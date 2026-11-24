// Autopilot Pendo Feedback: fetches ALL poll responses for one Pendo guide on
// a schedule, rewrites a rolling Markdown report at a chosen path, and keeps
// every response in the plugin's SQLite database (dedup makes the repeated
// all-time fetches incremental). The integration key is a shared host
// secret chosen by name; its value never reaches settings, logs or errors.
// Port of the Swift PendoFeedbackPlugin.
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
import { formatStatusTime, isComplete, isRegion, REGIONS, type PendoConfig } from './model.js';
import { PendoClient, PendoClientError } from './client.js';
import { renderReport } from './renderer.js';
import { MIGRATIONS, PendoStore } from './store.js';
import { WriteError, writeTextAtomic } from '../../../shared/atomic-write.js';

export const PLUGIN_ID = 'pendofeedback';
export const JOB_ID = `${PLUGIN_ID}.fetch`;
/** Which shared host secret holds the integration key (the name, never the value). */
export const HOST_SECRET_NAME_KEY = 'hostSecretName';
export const GUIDE_ID_KEY = 'guideID';
export const REGION_KEY = 'region';
export const OUTPUT_PATH_KEY = 'outputPath';
/** The host secret name the Swift host's settings migration used. */
export const DEFAULT_HOST_SECRET = 'pendo';
/** LEGACY: the retired 1–30 day window; cleared on activate. */
export const LEGACY_DAYS_BACK_KEY = 'daysBack';
/** LEGACY: the 1/6/12/24 h picker; read once by the schedule migration. */
export const LEGACY_INTERVAL_KEY = 'intervalHours';
/** LEGACY: a last-run time (epoch seconds) the plugin once stored itself;
 *  handed to the host scheduler once, then removed. */
export const LEGACY_LAST_RUN_KEY = 'lastRunAt';

export const NOT_CONFIGURED = 'Not configured — choose an API key and a guide ID here (keys are added on the Secrets page)';

export async function migrateLegacyInterval(settings: SettingsStore): Promise<ScheduleSpec | null> {
  const hours = await settings.get<number>(LEGACY_INTERVAL_KEY);
  if (hours === undefined) return null;
  await settings.delete(LEGACY_INTERVAL_KEY);
  return [1, 6, 12].includes(hours) ? schedules.everyNHours(hours) : schedules.daily(9 * 60);
}

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Pendo',
      fields: [
        { type: 'select', key: REGION_KEY, label: 'Region', options: Object.entries(REGIONS).map(([value, r]) => ({ value, label: r.label })), default: 'us' },
        { type: 'hostSecret', key: HOST_SECRET_NAME_KEY, label: 'API key', help: 'An integration key added on the Secrets page in Settings.' },
        { type: 'text', key: GUIDE_ID_KEY, label: 'Guide ID', placeholder: 'from the guide’s URL in Pendo', help: 'Responses are fetched for all time — every response ever submitted to this guide.' },
      ],
    },
    {
      title: 'Report',
      fields: [
        { type: 'schedule', key: ScheduledJobController.specKey, label: 'Runs' },
        { type: 'path', key: OUTPUT_PATH_KEY, label: 'Output file', pick: 'save', defaultName: 'Pendo Feedback.md', filters: [{ name: 'Markdown', extensions: ['md'] }] },
        { type: 'status', key: 'lastRun', label: 'Status' },
      ],
    },
    {
      title: 'Database',
      description: 'Every response ever fetched is stored in this plugin’s database (Settings → Storage → pendofeedback), in addition to the report: responses(fingerprint, guide_id, poll_id, poll_response, response_text, visitor_id, account_id, browser_time, raw_json, first_seen_at, last_seen_at) and polls(guide_id, poll_id, question, choices_json).',
      fields: [{ type: 'status', key: 'responses', label: 'Responses' }],
    },
    {
      title: 'Run',
      fields: [{ type: 'action', key: 'run-now', label: 'Update report now', help: 'Fetches now and rewrites the report — doesn’t change the schedule.' }],
    },
  ],
};

/** The report was written but the database update failed. */
class StoreError extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); this.name = 'StoreError'; }
}

export interface PendoOptions {
  /** Injected in tests; defaults to the real client over ctx.http. */
  readonly client?: (ctx: PluginContext) => PendoClient;
}

export function createPendoFeedback(options: PendoOptions = {}): CapabilityPlugin & { readonly currentRun: Promise<void> | null } {
  let ctx: PluginContext | null = null;
  let store: PendoStore | null = null;
  let controller: ScheduledJobController | null = null;
  let configured = false;
  let secretName: string = DEFAULT_HOST_SECRET;
  let legacyLastRunAt: string | null = null;
  let responsesTotal = 0;
  let unwatch: (() => void) | null = null;
  let running: { cancelled: boolean } | null = null;
  let currentRun: Promise<void> | null = null;
  let successLine: (() => string) | null = null;

  const loadConfig = async (c: PluginContext): Promise<PendoConfig> => {
    const name = await c.settings.get<string>(HOST_SECRET_NAME_KEY);
    secretName = typeof name === 'string' ? name : DEFAULT_HOST_SECRET;
    let apiKey = '';
    if (secretName !== '') {
      try { apiKey = (await c.hostSecrets.get(secretName)) ?? ''; }
      catch (e) { c.logger.error(`couldn’t read the chosen host secret: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const region = await c.settings.get(REGION_KEY);
    return {
      apiKey,
      guideID: ((await c.settings.get<string>(GUIDE_ID_KEY)) ?? '').trim(),
      region: isRegion(region) ? region : 'us',
      outputPath: (await c.settings.get<string>(OUTPUT_PATH_KEY)) ?? '',
    };
  };

  const statusLine = (): string => {
    if (!configured) return 'Pendo Feedback not configured';
    const last = controller?.lastRunAt ? formatStatusTime(new Date(controller.lastRunAt)) : 'never';
    const next = controller?.nextRunAt ? formatStatusTime(new Date(controller.nextRunAt)) : '—';
    return `Last run ${last} · next ${next}`;
  };

  const publish = (): void => {
    if (!ctx) return;
    const rows: MenuItem[] = [
      { kind: 'text', label: statusLine() },
      { kind: 'item', id: 'run', label: 'Update Report Now' },
    ];
    ctx.menu.set(rows);
    if (successLine) ctx.reportHealth(health.ok(successLine()));
    ctx.reportStatus({ lastRun: statusLine(), responses: `${responsesTotal} stored` });
  };

  const arm = async (): Promise<void> => {
    if (!ctx || !controller) return;
    configured = isComplete(await loadConfig(ctx));
    if (configured) {
      // The one-time migration: the legacy anchor becomes the job's last run.
      if (legacyLastRunAt) { const at = legacyLastRunAt; legacyLastRunAt = null; await ctx.scheduler.recordRun(JOB_ID, at); }
    } else {
      successLine = null;
      ctx.reportHealth(health.ok(NOT_CONFIGURED));
    }
    await controller.arm();
    publish();
  };

  const notify = (title: string, body: string): void => {
    void ctx?.notifications.post({ title, subtitle: 'Autopilot Pendo Feedback', body }).catch(() => {});
  };

  const finished = async (c: PluginContext, reason: string): Promise<void> => {
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    publish();
  };

  const failed = async (c: PluginContext, reason: string, error: unknown): Promise<void> => {
    successLine = null;
    const message = error instanceof Error ? error.message : String(error);
    c.logger.error(`${reason} run failed: ${message}`);
    if (error instanceof PendoClientError) {
      switch (error.kind) {
        case 'unauthorized':
          c.reportHealth(health.error('Pendo rejected the API key — check the key and its permissions'));
          notify('Pendo Feedback couldn’t authenticate', 'Pendo rejected the API key. Check the key and its permissions in Settings.');
          break;
        case 'guideNotFound':
          c.reportHealth(health.warning(`Guide ${error.detail} not found — check the guide ID`));
          notify('Pendo Feedback couldn’t find the guide', `Guide ${error.detail} wasn’t found. Check the guide ID in Settings.`);
          break;
        case 'rateLimited': // transient: the next run retries, no notification
          c.reportHealth(health.warning('Pendo rate-limited the request — retrying next run'));
          break;
        case 'badResponse':
          c.reportHealth(health.warning(message));
          notify('Pendo Feedback got an unreadable response', `${message}. It will try again at the next scheduled run.`);
          break;
        case 'http':
          c.reportHealth(health.warning(`Pendo returned HTTP ${error.status}`));
          notify('Pendo Feedback run failed', `Pendo returned HTTP ${error.status}. It will try again at the next scheduled run.`);
          break;
        default: // network, timeout
          c.reportHealth(health.warning(message));
          notify('Pendo Feedback couldn’t reach Pendo', `${message}. It will try again at the next scheduled run.`);
      }
    } else if (error instanceof WriteError) {
      c.reportHealth(health.error(message));
      notify('Pendo Feedback couldn’t write the report', `${message} Check the output file location in Settings.`);
    } else if (error instanceof StoreError) {
      // The report was written first, so only the database is stale.
      c.reportHealth(health.warning(`Report updated, but the response database wasn’t: ${message}`));
      notify('Pendo Feedback couldn’t update its database', `${message} The Markdown report was updated; the database retries at the next scheduled run.`);
    } else {
      c.reportHealth(health.error(`Pendo Feedback run failed: ${message}`));
      notify('Pendo Feedback run failed', message);
    }
    await finished(c, reason);
  };

  const startRun = (reason: 'manual' | 'scheduled'): Promise<void> => {
    const run = doRun(reason);
    currentRun = run;
    return run;
  };

  const doRun = async (reason: 'manual' | 'scheduled'): Promise<void> => {
    const c = ctx;
    const s = store;
    if (!c || !s) return;
    const config = await loadConfig(c);
    configured = isComplete(config);
    if (!configured) { successLine = null; c.reportHealth(health.ok(NOT_CONFIGURED)); publish(); return; }
    if (running) running.cancelled = true;
    const token = { cancelled: false };
    running = token;
    const live = () => !token.cancelled && ctx === c;
    successLine = null;
    c.reportHealth(health.ok('Fetching Pendo feedback…'));
    c.logger.info(`${reason} run started — guide ${config.guideID}, all time`);
    const client = options.client ? options.client(c) : new PendoClient(c.http);
    try {
      const guide = await client.fetchGuide(config);
      const rows = await client.fetchPollResponses(config);
      if (!live()) return; // superseded or deactivated: write nothing
      const markdown = renderReport({ guideName: guide.name, guideID: config.guideID, region: config.region, rows, pollMap: guide.pollMap });
      await writeTextAtomic(config.outputPath, markdown, 'pendofeedback');
      let newCount: number;
      try {
        newCount = await s.record(config.guideID, rows, guide.pollMap);
        responsesTotal = await s.responseCount();
      } catch (e) { throw new StoreError(e); }
      if (!live()) return;
      successLine = () => `Report updated — ${rows.length} response(s) · next run ${controller?.nextRunAt ? formatStatusTime(new Date(controller.nextRunAt)) : 'the next tick'}`;
      c.logger.info(`${reason} run finished — ${rows.length} responses written to ${config.outputPath}, ${newCount} new stored (${responsesTotal} total)`);
      await finished(c, reason);
    } catch (e) {
      if (live()) await failed(c, reason, e).catch(() => {});
    } finally {
      if (running === token) running = null;
    }
  };

  return {
    metadata: { id: PLUGIN_ID, name: 'Autopilot Pendo Feedback', icon: 'message-square', summary: 'Fetches Pendo guide poll feedback on a schedule and writes a Markdown report plus a SQLite history', version: '2.0.1' },
    settings: settingsSchema,
    get currentRun() { return currentRun; },

    async activate(context) {
      ctx = context;
      await context.settings.registerDefaults({ [REGION_KEY]: 'us', [HOST_SECRET_NAME_KEY]: DEFAULT_HOST_SECRET });
      if ((await context.settings.get(LEGACY_DAYS_BACK_KEY)) !== undefined) await context.settings.delete(LEGACY_DAYS_BACK_KEY);
      const legacy = await context.settings.get<number>(LEGACY_LAST_RUN_KEY);
      if (legacy !== undefined) {
        if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) legacyLastRunAt = new Date(legacy * 1000).toISOString();
        await context.settings.delete(LEGACY_LAST_RUN_KEY);
      }
      store = new PendoStore(await context.storage.open(MIGRATIONS));
      responsesTotal = await store.responseCount();
      configured = isComplete(await loadConfig(context));
      controller = await ScheduledJobController.create({
        jobId: JOB_ID,
        context,
        migrateLegacy: migrateLegacyInterval,
        isConfigured: () => configured,
        onFire: () => startRun('scheduled'),
      });
      controller.onChange(publish);
      unwatch = context.settings.onChange(key => {
        if (key === HOST_SECRET_NAME_KEY || key === GUIDE_ID_KEY || key === REGION_KEY || key === OUTPUT_PATH_KEY) void arm();
      });
      await arm();
      context.logger.info(`activated — guide=${configured ? 'set' : '(incomplete)'}, ${responsesTotal} responses stored`);
    },

    async deactivate() {
      if (running) running.cancelled = true;
      unwatch?.();
      unwatch = null;
      await controller?.disarm().catch(() => {});
      controller = null;
      store = null;
      ctx = null;
      configured = false;
      legacyLastRunAt = null;
      successLine = null;
    },

    onJob: async id => { await controller?.onJob(id); },
    onJobNextRun: (id, next) => controller?.onJobNextRun(id, next),

    async onMenuItem(id) {
      if (id === 'run') void startRun('manual');
    },

    actions: () => [{ name: 'run-now', title: 'Update report now', summary: 'Fetch Pendo feedback and rewrite the report', acceptsText: false }],

    async perform(action) {
      if (action !== 'run-now') return undefined;
      const ok = ctx ? isComplete(await loadConfig(ctx)) : false;
      if (!ok) {
        ctx?.reportHealth(health.ok(NOT_CONFIGURED));
        return NOT_CONFIGURED;
      }
      void startRun('manual');
      return 'Pendo report run started';
    },

    /** The chosen host secret for the Secrets page ("" = None). */
    hostSecretUsage: () => (secretName === '' ? [] : [secretName]),
  };
}

export default definePlugin(() => createPendoFeedback());
