// Workato Changelog: scrapes workato.com's public product-hub changelog on a
// schedule and writes one rolling Markdown note per calendar quarter into a
// vault folder, newest entries first. Entries live in the plugin's SQLite
// database, the source of truth the notes render from. The first run
// backfills the whole archive (2019 → today); later runs are incremental.
// Port of the Swift WorkatoChangelogPlugin.
import {
  definePlugin,
  health,
  ScheduledJobController,
  schedules,
  type CapabilityPlugin,
  type MenuItem,
  type PluginContext,
  type ScheduleSpec,
  type SettingsSchema,
  type SettingsStore,
} from '@workbar/sdk';
import { formatStatusTime, isComplete, type ScrapeSummary, type WorkatoConfig } from './model.js';
import { ChangelogStore, MIGRATIONS } from './store.js';
import { WorkatoClient, WorkatoClientError } from './client.js';
import { Cancelled, runScrape } from './runner.js';
import { WriteError } from '../../../shared/atomic-write.js';

export const PLUGIN_ID = 'workatochangelog';
export const JOB_ID = `${PLUGIN_ID}.scrape`;
export const VAULT_FOLDER_KEY = 'vaultFolder';
/** Safety valve only; no settings UI. */
export const MAX_PAGES_KEY = 'maxPages';
/** The folder notes were last rendered into (internal). A change means the new
 *  folder is missing every note, so that run re-renders ALL quarters. */
export const RENDERED_FOLDER_KEY = 'renderedFolder';
/** The retired 1/6/12/24 h picker; read once by the schedule migration, then removed. */
export const LEGACY_INTERVAL_KEY = 'intervalHours';

const NOT_CONFIGURED = 'Not configured — choose a vault folder in Settings';

/** 1, 6 and 12 keep their cadence; 24 (or anything else) becomes Daily at 9:00 AM. */
export async function migrateLegacyInterval(settings: SettingsStore): Promise<ScheduleSpec | null> {
  const hours = await settings.get<number>(LEGACY_INTERVAL_KEY);
  if (hours === undefined) return null;
  await settings.delete(LEGACY_INTERVAL_KEY);
  return [1, 6, 12].includes(hours) ? schedules.everyNHours(hours) : schedules.daily(9 * 60);
}

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Vault',
      fields: [{
        type: 'path', key: VAULT_FOLDER_KEY, label: 'Output folder', pick: 'folder',
        help: 'Quarter notes (2026-Q4.md, …) are written here, newest entries first. They’re regenerated on each run — don’t edit them by hand.',
      }],
    },
    {
      title: 'Schedule',
      fields: [
        { type: 'schedule', key: ScheduledJobController.specKey, label: 'Runs' },
        { type: 'status', key: 'lastRun', label: 'Status' },
      ],
    },
    {
      title: 'Database',
      description: 'Every scraped entry is stored in this plugin’s database (Settings → Storage → workatochangelog): entries(fingerprint, entry_date, quarter_key, title, categories JSON, badge, body_markdown, body_html, first_seen_at, last_seen_at).',
      fields: [{ type: 'status', key: 'entries', label: 'Entries' }],
    },
    {
      title: 'Run',
      fields: [{ type: 'action', key: 'scrape-now', label: 'Scrape now', help: 'Fetches now and updates the notes — doesn’t change the schedule.' }],
    },
  ],
};

export interface WorkatoOptions {
  /** Injected in tests; defaults to the real client over ctx.http. */
  readonly client?: (ctx: PluginContext) => WorkatoClient;
  readonly pageDelayMs?: number;
}

export function createWorkatoChangelog(options: WorkatoOptions = {}): CapabilityPlugin & { readonly currentRun: Promise<void> | null } {
  let ctx: PluginContext | null = null;
  let store: ChangelogStore | null = null;
  let controller: ScheduledJobController | null = null;
  let config: WorkatoConfig = { vaultFolder: '', maxPages: 100 };
  let entriesTotal = 0;
  let unwatch: (() => void) | null = null;
  let running: { cancelled: boolean } | null = null;
  let currentRun: Promise<void> | null = null;
  /** The last run's success line, rebuilt on every publish: a scheduled run
   *  finishes before the scheduler re-plans, so "next run" must refresh. */
  let successLine: (() => string) | null = null;

  const loadConfig = async (c: PluginContext): Promise<WorkatoConfig> => {
    const maxPages = (await c.settings.get<number>(MAX_PAGES_KEY)) ?? 0;
    return { vaultFolder: (await c.settings.get<string>(VAULT_FOLDER_KEY)) ?? '', maxPages: maxPages > 0 ? maxPages : 100 };
  };

  const statusLine = (): string => {
    if (!isComplete(config)) return 'Workato Changelog not configured';
    const last = controller?.lastRunAt ? formatStatusTime(new Date(controller.lastRunAt)) : 'never';
    const next = controller?.nextRunAt ? formatStatusTime(new Date(controller.nextRunAt)) : '—';
    return `Last run ${last} · next ${next}`;
  };

  const publish = (): void => {
    if (!ctx) return;
    const rows: MenuItem[] = [
      { kind: 'text', label: statusLine() },
      { kind: 'item', id: 'scrape', label: 'Scrape Now' },
      { kind: 'item', id: 'open', label: 'Open Output Folder', enabled: config.vaultFolder !== '' },
    ];
    ctx.menu.set(rows);
    if (successLine) ctx.reportHealth(health.ok(successLine()));
    ctx.reportStatus({ lastRun: statusLine(), entries: `${entriesTotal} entries` });
  };

  const arm = async (): Promise<void> => {
    if (!ctx || !controller) return;
    config = await loadConfig(ctx);
    if (!isComplete(config)) { successLine = null; ctx.reportHealth(health.ok(NOT_CONFIGURED)); }
    await controller.arm();
    publish();
  };

  const notify = (title: string, body: string): void => {
    void ctx?.notifications.post({ title, subtitle: 'Workato Changelog', body }).catch(() => {});
  };

  const succeeded = async (c: PluginContext, reason: string, s: ScrapeSummary, folder: string, reRenderedAll: boolean): Promise<void> => {
    entriesTotal = s.entriesTotal;
    await c.settings.set(RENDERED_FOLDER_KEY, folder);
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    successLine = () => {
      const next = controller?.nextRunAt ? formatStatusTime(new Date(controller.nextRunAt)) : 'the next tick';
      return s.entriesNew === 0 && reRenderedAll ? `Up to date — ${s.entriesTotal} entries · re-rendered ${s.quartersWritten.length} notes · next run ${next}`
        : s.entriesNew === 0 ? `Up to date — ${s.entriesTotal} entries · next run ${next}`
        : `Added ${s.entriesNew} entries · ${s.entriesTotal} total · next run ${next}`;
    };
    c.logger.info(`${reason} run finished — ${s.pagesFetched} pages, ${s.entriesNew} new, quarters written: ${s.quartersWritten.join(', ')}${s.reachedEndOfHistory ? ' · reached end of archive' : ''}`);
    publish();
  };

  const failed = async (c: PluginContext, reason: string, error: unknown): Promise<void> => {
    if (error instanceof Cancelled) return;
    successLine = null;
    const message = error instanceof Error ? error.message : String(error);
    c.logger.error(`${reason} run failed: ${message}`);
    if (error instanceof WorkatoClientError) {
      if (error.kind === 'http') {
        c.reportHealth(health.warning(`Workato returned HTTP ${error.status}`));
        notify('Workato Changelog run failed', `Workato returned HTTP ${error.status}. It will try again at the next scheduled run.`);
      } else if (error.kind === 'badResponse') {
        c.reportHealth(health.warning(message));
        notify('Workato Changelog got an unreadable page', `${message}. It will try again at the next scheduled run.`);
      } else {
        c.reportHealth(health.warning(message));
        notify('Workato Changelog couldn’t reach workato.com', `${message}. It will try again at the next scheduled run.`);
      }
    } else if (error instanceof WriteError) {
      c.reportHealth(health.error(message));
      notify('Workato Changelog couldn’t write a note', `${message} Check the vault folder in Settings.`);
    } else {
      c.reportHealth(health.error(`Workato Changelog run failed: ${message}`));
      notify('Workato Changelog run failed', message);
    }
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    publish();
  };

  /** One run. A new run cancels an in-flight one (between pages). The promise
   *  is recorded synchronously, so a caller can await `currentRun` right away. */
  const startRun = (reason: 'manual' | 'scheduled'): Promise<void> => {
    const run = doRun(reason);
    currentRun = run;
    return run;
  };

  const doRun = async (reason: 'manual' | 'scheduled'): Promise<void> => {
    const c = ctx;
    if (!c || !store) return;
    config = await loadConfig(c);
    if (!isComplete(config)) { successLine = null; c.reportHealth(health.ok(NOT_CONFIGURED)); publish(); return; }
    if (running) running.cancelled = true;
    const token = { cancelled: false };
    running = token;
    const folder = config.vaultFolder;
    const folderChanged = (await c.settings.get<string>(RENDERED_FOLDER_KEY)) !== folder;
    successLine = null;
    c.reportHealth(health.ok('Scraping Workato changelog…'));
    c.logger.info(`${reason} run started — vault ${folder}${folderChanged ? ' (folder changed — re-rendering all notes)' : ''}`);
    const client = options.client ? options.client(c) : new WorkatoClient(c.http);
    const run = runScrape(client, store, config, {
      renderAllQuarters: folderChanged,
      isCancelled: () => token.cancelled || ctx !== c,
      ...(options.pageDelayMs !== undefined ? { pageDelayMs: options.pageDelayMs } : {}),
    }).then(s => succeeded(c, reason, s, folder, folderChanged), e => failed(c, reason, e))
      .catch(() => { /* the plugin was deactivated mid-run: its context is revoked */ })
      .finally(() => { if (running === token) running = null; });
    return run;
  };

  return {
    metadata: { id: PLUGIN_ID, name: 'Workato Changelog', icon: 'file-search', summary: 'Scrapes Workato’s release notes into quarterly Markdown notes in your Obsidian vault', version: '2.0.0' },
    settings: settingsSchema,
    get currentRun() { return currentRun; },

    async activate(context) {
      ctx = context;
      await context.settings.registerDefaults({ [MAX_PAGES_KEY]: 100 });
      store = new ChangelogStore(await context.storage.open(MIGRATIONS));
      entriesTotal = await store.count();
      config = await loadConfig(context);
      controller = await ScheduledJobController.create({
        jobId: JOB_ID,
        context,
        migrateLegacy: migrateLegacyInterval,
        isConfigured: () => isComplete(config),
        onFire: () => startRun('scheduled'),
      });
      controller.onChange(publish);
      unwatch = context.settings.onChange(key => { if (key === VAULT_FOLDER_KEY || key === MAX_PAGES_KEY) void arm(); });
      await arm();
      context.logger.info(`activated — vault=${config.vaultFolder ? 'set' : '(none)'}, ${entriesTotal} entries stored`);
    },

    async deactivate() {
      if (running) running.cancelled = true;
      unwatch?.();
      unwatch = null;
      await controller?.disarm().catch(() => {});
      controller = null;
      store = null;
      ctx = null;
    },

    onJob: async id => { await controller?.onJob(id); },
    onJobNextRun: (id, next) => controller?.onJobNextRun(id, next),

    async onMenuItem(id) {
      if (id === 'scrape') void startRun('manual');
      if (id === 'open' && ctx && config.vaultFolder) await ctx.shell.openPath(config.vaultFolder);
    },

    actions: () => [{ name: 'scrape-now', title: 'Scrape now', summary: 'Fetch the Workato changelog and update the vault notes', acceptsText: false }],

    async perform(action) {
      if (action !== 'scrape-now') return undefined;
      const configured = ctx ? isComplete(await loadConfig(ctx)) : false;
      void startRun('manual');
      return configured ? 'Workato changelog scrape started' : NOT_CONFIGURED;
    },
  };
}

export default definePlugin(() => createWorkatoChangelog());
