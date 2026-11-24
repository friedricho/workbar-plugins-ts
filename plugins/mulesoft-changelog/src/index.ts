// MuleSoft Changelog: scrapes docs.mulesoft.com's release notes on a schedule
// and writes one rolling Markdown note per calendar quarter into a vault
// folder, newest entries first. Entries live in the plugin's SQLite
// database, the source of truth the notes render from. The first run walks
// the whole by-date index plus every linked product page (~360 fetches);
// later runs fetch only pages with unknown entries. A one-time-per-page
// history walk (cutoff `historyStart`, shipped as 2019-01-01) backfills the
// years the rolling index no longer covers. Port of the Swift
// MuleSoftChangelogPlugin.
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
import { formatStatusTime, isComplete, type MuleSoftConfig, type ScrapeSummary } from './model.js';
import { ChangelogStore, MIGRATIONS } from './store.js';
import { MuleSoftClient, MuleSoftClientError } from './client.js';
import { Cancelled, runScrape } from './runner.js';
import { WriteError } from '../../../shared/atomic-write.js';

export const PLUGIN_ID = 'mulesoftchangelog';
export const JOB_ID = `${PLUGIN_ID}.scrape`;
export const VAULT_FOLDER_KEY = 'vaultFolder';
/** Safety valves and the history cutoff: settings keys with no UI (as in Swift). */
export const MAX_PRODUCT_PAGES_KEY = 'maxProductPages';
/** Oldest entry date the history walk keeps ("YYYY-MM-DD"; "" disables the walk). */
export const HISTORY_START_KEY = 'historyStart';
export const MAX_HISTORY_PAGES_KEY = 'maxHistoryPages';
/** The folder notes were last rendered into (internal). A change re-renders ALL quarters. */
export const RENDERED_FOLDER_KEY = 'renderedFolder';
/** The retired 1/6/12/24 h picker; read once by the schedule migration, then removed. */
export const LEGACY_INTERVAL_KEY = 'intervalHours';
/** The Mule 4 era. */
export const DEFAULT_HISTORY_START = '2019-01-01';

const NOT_CONFIGURED = 'Not configured — choose a vault folder in Settings';

/** 1, 6 and 12 keep their cadence; 24 (or anything else) becomes Daily at 9:00 AM. */
export async function migrateLegacyInterval(settings: SettingsStore): Promise<ScheduleSpec | null> {
  const hours = await settings.get<number>(LEGACY_INTERVAL_KEY);
  if (hours === undefined) return null;
  await settings.delete(LEGACY_INTERVAL_KEY);
  return [1, 6, 12].includes(hours) ? schedules.everyNHours(hours) : schedules.daily(9 * 60);
}

/** "" disables the walk; an unparseable value falls back to the shipped
 *  default (a hidden key must never break the run). */
export function historyCutoff(value: unknown): string | null {
  const text = (typeof value === 'string' ? value : DEFAULT_HISTORY_START).trim();
  if (text === '') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && isValidDay(text) ? text : DEFAULT_HISTORY_START;
}
const isValidDay = (ymd: string): boolean => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
};

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
      description: 'Every scraped entry is stored in this plugin’s database (Settings → Storage → mulesoftchangelog): entries(fingerprint, entry_date, quarter_key, product, title, page_url, anchor, body_markdown, body_html, first_seen_at, last_seen_at).',
      fields: [{ type: 'status', key: 'entries', label: 'Entries' }],
    },
    {
      title: 'Run',
      fields: [{ type: 'action', key: 'scrape-now', label: 'Scrape now', help: 'Fetches now and updates the notes — doesn’t change the schedule.' }],
    },
  ],
};

export interface MuleSoftOptions {
  /** Injected in tests; defaults to the real client over ctx.http. */
  readonly client?: (ctx: PluginContext) => MuleSoftClient;
  readonly pageDelayMs?: number;
}

export function createMuleSoftChangelog(options: MuleSoftOptions = {}): CapabilityPlugin & { readonly currentRun: Promise<void> | null } {
  let ctx: PluginContext | null = null;
  let store: ChangelogStore | null = null;
  let controller: ScheduledJobController | null = null;
  let config: MuleSoftConfig = { vaultFolder: '', maxProductPages: 500 };
  let entriesTotal = 0;
  let unwatch: (() => void) | null = null;
  let running: { cancelled: boolean } | null = null;
  let currentRun: Promise<void> | null = null;
  /** The last run's success line, rebuilt on every publish: a scheduled run
   *  finishes before the scheduler re-plans, so "next run" must refresh. */
  let successLine: (() => string) | null = null;

  const loadConfig = async (c: PluginContext): Promise<MuleSoftConfig> => {
    const maxProductPages = (await c.settings.get<number>(MAX_PRODUCT_PAGES_KEY)) ?? 0;
    const maxHistoryPages = (await c.settings.get<number>(MAX_HISTORY_PAGES_KEY)) ?? 0;
    return {
      vaultFolder: (await c.settings.get<string>(VAULT_FOLDER_KEY)) ?? '',
      maxProductPages: maxProductPages > 0 ? maxProductPages : 500,
      historyStart: historyCutoff(await c.settings.get(HISTORY_START_KEY)),
      maxHistoryPages: maxHistoryPages > 0 ? maxHistoryPages : 1000,
    };
  };

  const statusLine = (): string => {
    if (!isComplete(config)) return 'MuleSoft Changelog not configured';
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
    void ctx?.notifications.post({ title, subtitle: 'MuleSoft Changelog', body }).catch(() => {});
  };

  const succeeded = async (c: PluginContext, reason: string, s: ScrapeSummary, folder: string, reRenderedAll: boolean): Promise<void> => {
    entriesTotal = s.entriesTotal;
    // Only on success: a failed write leaves the key stale, so the next run retries the full re-render.
    await c.settings.set(RENDERED_FOLDER_KEY, folder);
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    const failedNote = s.pagesFailed > 0 ? ` · ${s.pagesFailed} pages failed (retrying next run)` : '';
    const historyNote = s.historyPagesFetched > 0 ? ` · history: ${s.historyPagesFetched} pages, ${s.historyEntriesNew} entries` : '';
    successLine = () => {
      const next = controller?.nextRunAt ? formatStatusTime(new Date(controller.nextRunAt)) : 'the next tick';
      const detail = s.entriesNew === 0 && reRenderedAll ? `Up to date — ${s.entriesTotal} entries · re-rendered ${s.quartersWritten.length} notes · next run ${next}`
        : s.entriesNew === 0 ? `Up to date — ${s.entriesTotal} entries · next run ${next}`
        : `Added ${s.entriesNew} entries · ${s.entriesTotal} total · next run ${next}`;
      return detail + failedNote + historyNote;
    };
    c.logger.info(`${reason} run finished — ${s.pagesFetched} product pages, ${s.entriesNew} new, quarters written: ${s.quartersWritten.join(', ')}`
      + (s.pagesFailed > 0 ? ` · ${s.pagesFailed} pages FAILED` : '')
      + (s.indexFullyProcessed ? ' · index fully processed' : ' · page cap hit')
      + (s.historyPagesFetched > 0 ? ` · history: ${s.historyPagesFetched} pages walked, ${s.historyEntriesNew} entries` : ''));
    publish();
  };

  const failed = async (c: PluginContext, reason: string, error: unknown): Promise<void> => {
    if (error instanceof Cancelled) return; // superseded or deactivated: not a failure
    successLine = null;
    const message = error instanceof Error ? error.message : String(error);
    c.logger.error(`${reason} run failed: ${message}`);
    if (error instanceof MuleSoftClientError) {
      if (error.kind === 'http') {
        c.reportHealth(health.warning(`docs.mulesoft.com returned HTTP ${error.status}`));
        notify('MuleSoft Changelog run failed', `docs.mulesoft.com returned HTTP ${error.status}. It will try again at the next scheduled run.`);
      } else if (error.kind === 'badResponse') {
        c.reportHealth(health.warning(message));
        notify('MuleSoft Changelog got an unreadable page', `${message}. It will try again at the next scheduled run.`);
      } else {
        c.reportHealth(health.warning(message));
        notify('MuleSoft Changelog couldn’t reach docs.mulesoft.com', `${message}. It will try again at the next scheduled run.`);
      }
    } else if (error instanceof WriteError) {
      c.reportHealth(health.error(message));
      notify('MuleSoft Changelog couldn’t write a note', `${message} Check the vault folder in Settings.`);
    } else {
      c.reportHealth(health.error(`MuleSoft Changelog run failed: ${message}`));
      notify('MuleSoft Changelog run failed', message);
    }
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    publish();
  };

  /** One run; a new run cancels an in-flight one (between pages). The promise
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
    c.reportHealth(health.ok('Scraping MuleSoft release notes…'));
    c.logger.info(`${reason} run started — vault ${folder}${folderChanged ? ' (folder changed — re-rendering all notes)' : ''}`);
    const client = options.client ? options.client(c) : new MuleSoftClient(c.http);
    return runScrape(client, store, config, {
      renderAllQuarters: folderChanged,
      isCancelled: () => token.cancelled || ctx !== c,
      ...(options.pageDelayMs !== undefined ? { pageDelayMs: options.pageDelayMs } : {}),
    }).then(s => succeeded(c, reason, s, folder, folderChanged), e => failed(c, reason, e))
      .catch(() => { /* the plugin was deactivated mid-run: its context is revoked */ })
      .finally(() => { if (running === token) running = null; });
  };

  return {
    metadata: { id: PLUGIN_ID, name: 'MuleSoft Changelog', icon: 'file-search', summary: 'Scrapes MuleSoft’s release notes into quarterly Markdown notes in your Obsidian vault', version: '2.0.1' },
    settings: settingsSchema,
    get currentRun() { return currentRun; },

    async activate(context) {
      ctx = context;
      await context.settings.registerDefaults({
        [MAX_PRODUCT_PAGES_KEY]: 500,
        [HISTORY_START_KEY]: DEFAULT_HISTORY_START,
        [MAX_HISTORY_PAGES_KEY]: 1000,
      });
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
      unwatch = context.settings.onChange(key => {
        if (key === VAULT_FOLDER_KEY || key === MAX_PRODUCT_PAGES_KEY || key === HISTORY_START_KEY || key === MAX_HISTORY_PAGES_KEY) void arm();
      });
      await arm();
      context.logger.info(`activated — vault=${config.vaultFolder ? 'set' : '(none)'}, ${entriesTotal} entries stored, history from ${config.historyStart ?? 'off'}`);
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

    actions: () => [{ name: 'scrape-now', title: 'Scrape now', summary: 'Fetch the MuleSoft release notes and update the vault notes', acceptsText: false }],

    async perform(action) {
      if (action !== 'scrape-now') return undefined;
      const configured = ctx ? isComplete(await loadConfig(ctx)) : false;
      void startRun('manual');
      return configured ? 'MuleSoft release-notes scrape started' : NOT_CONFIGURED;
    },
  };
}

export default definePlugin(() => createMuleSoftChangelog());
