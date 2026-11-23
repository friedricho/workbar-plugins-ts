// AI Gateway Budget: polls the AI gateway's rolling budget windows
// (`/boomi/budget/status`, the Claude Code status line's budget display as a
// plugin) every minute and shows one line per window in the menu, with
// threshold and reset notifications. The last good payload is snapshotted
// into settings (no credential), so a relaunch starts warm and an offline
// gateway shows stale data instead of nothing. Port of the Swift
// BoomiBudgetPlugin.
import {
  definePlugin,
  health,
  type CapabilityPlugin,
  type MenuItem,
  type PluginContext,
  type SettingsSchema,
} from '@workbar/sdk';
import { bandFor, decodeStatus, encodeStatus, formatStatusTime, line, money, primaryLimit, type BudgetBand, type BudgetStatus } from './model.js';
import { BudgetClientError, BudgetGateway, GatewayTokenProvider, normalizedStatusURL, PRODUCTION_URL, SAVED_TOKEN_NAME, type TokenProvider } from './gateway.js';

export const PLUGIN_ID = 'boomibudget';
export const JOB_ID = `${PLUGIN_ID}.poll`;
export const STATUS_URL_KEY = 'statusURL';
export const POLL_INTERVAL_KEY = 'pollIntervalSeconds';
export const NOTIFY_70_KEY = 'notifyAt70';
export const NOTIFY_90_KEY = 'notifyAt90';
export const NOTIFY_RESET_KEY = 'notifyOnReset';
export const SNAPSHOT_KEY = 'lastSnapshotJSON';
/** Epoch seconds of the snapshot's fetch. */
export const LAST_FETCH_AT_KEY = 'lastFetchAt';
/** {"30d": band}: one notification per crossing, across relaunches. */
export const LAST_BANDS_KEY = 'lastBandsJSON';

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Budget',
      fields: [
        { type: 'status', key: 'windows', label: 'Windows' },
        { type: 'status', key: 'updated', label: 'Updated' },
        { type: 'action', key: 'refresh-now', label: 'Refresh now', help: 'Fetches the budget now — doesn’t change the cadence.' },
      ],
    },
    {
      title: 'Gateway',
      fields: [
        { type: 'number', key: POLL_INTERVAL_KEY, label: 'Poll interval', min: 30, max: 3600, step: 30, unit: 's', default: 60 },
        { type: 'text', key: STATUS_URL_KEY, label: 'Status URL', placeholder: 'https://…/boomi/budget/status', default: PRODUCTION_URL, help: 'The gateway’s budget route. A base URL ending in /v1 is rewritten to the status route; empty restores the production default.' },
        { type: 'secret', key: SAVED_TOKEN_NAME, label: 'Token override', placeholder: 'optional', help: 'Normally the token comes from the corporate helper (CorporateAIClientProvisioning). A token saved here wins over it.' },
        { type: 'status', key: 'tokenSource', label: 'Token source' },
      ],
    },
    {
      title: 'Notifications',
      fields: [
        { type: 'toggle', key: NOTIFY_70_KEY, label: 'Notify at 70% of a window', default: true },
        { type: 'toggle', key: NOTIFY_90_KEY, label: 'Notify at 90% of a window', default: true },
        { type: 'toggle', key: NOTIFY_RESET_KEY, label: 'Notify when a window resets', default: false },
      ],
    },
  ],
};

type PollState = 'ok' | 'stale' | 'authFailed' | 'neverFetched';

export interface BudgetOptions {
  /** Injected in tests: the token source (defaults to the saved token + corporate helper). */
  readonly tokenProvider?: (ctx: PluginContext) => TokenProvider;
  /** Injected in tests: the clock. */
  readonly now?: () => number;
}

export function createGatewayBudget(options: BudgetOptions = {}): CapabilityPlugin & { readonly currentRun: Promise<void> | null } {
  const now = options.now ?? Date.now;
  let ctx: PluginContext | null = null;
  let tokens: TokenProvider | null = null;
  let gateway: BudgetGateway | null = null;
  let snapshot: BudgetStatus | null = null;
  let fetchedAt: number | null = null;
  let state: PollState = 'neverFetched';
  let lastFailurePosted = false;
  let interval = 60;
  let unwatch: (() => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let running: { cancelled: boolean } | null = null;
  let currentRun: Promise<void> | null = null;

  const statusLines = (): string[] => {
    if (state === 'authFailed') return ['Gateway budget — sign in via CorporateAIClientProvisioning'];
    if (state === 'neverFetched') return ['Gateway budget — waiting for first fetch'];
    if (!snapshot || snapshot.budgetLimits.length === 0) return ['Gateway budget — no data yet'];
    const prefix = state === 'stale' ? '⚠ ' : '';
    return snapshot.budgetLimits.map(l => prefix + line(l, now()));
  };

  const healthDetail = (): string => {
    switch (state) {
      case 'ok': { const p = snapshot ? primaryLimit(snapshot) : undefined; return p ? line(p, now()) : 'Waiting for budget data'; }
      case 'stale': return `Offline — showing data from ${fetchedAt ? formatStatusTime(new Date(fetchedAt)) : 'unknown time'}`;
      case 'authFailed': return 'No usable gateway token — launch CorporateAIClientProvisioning or save a token on this page';
      default: return 'Waiting for first budget fetch';
    }
  };

  /** Pushes the menu and status (countdowns are recomputed, so this also runs on a timer). */
  const publish = (): void => {
    if (!ctx) return;
    const rows: MenuItem[] = [
      ...statusLines().map((label): MenuItem => ({ kind: 'text', label })),
      { kind: 'item', id: 'refresh', label: 'Refresh Now' },
      { kind: 'item', id: 'details', label: 'Open Budget Details…' },
    ];
    ctx.menu.set(rows);
    if (state === 'ok') ctx.reportHealth(health.ok(healthDetail()));
    ctx.reportStatus({
      windows: statusLines().join(' · '),
      updated: fetchedAt ? formatStatusTime(new Date(fetchedAt)) : 'never',
      tokenSource: tokens ? (tokens.usingSavedToken ? 'the token saved on this page' : 'the corporate helper') : '—',
    });
  };

  const loadInterval = async (c: PluginContext) => {
    const v = await c.settings.get<number>(POLL_INTERVAL_KEY);
    return typeof v === 'number' && v > 0 ? v : 60;
  };

  const arm = async (): Promise<void> => {
    if (!ctx) return;
    interval = await loadInterval(ctx);
    await ctx.scheduler.update(JOB_ID, { intervalSeconds: interval });
  };

  const buildGateway = async (c: PluginContext): Promise<BudgetGateway> => {
    tokens ??= options.tokenProvider ? options.tokenProvider(c) : new GatewayTokenProvider({ secrets: c.secrets });
    const url = normalizedStatusURL((await c.settings.get<string>(STATUS_URL_KEY)) ?? '') ?? PRODUCTION_URL;
    return new BudgetGateway(c.http, tokens, url);
  };

  const notify = (title: string, body: string): void => {
    void ctx?.notifications.post({ title, subtitle: 'AI Gateway Budget', body }).catch(() => {});
  };

  /** Crossings UP into a band notify once (band memory persists); a first
   *  sighting is recorded silently; a spend drop is a window reset. */
  const evaluateThresholds = async (c: PluginContext, previous: BudgetStatus | null, next: BudgetStatus): Promise<void> => {
    let bands: Record<string, BudgetBand> = {};
    try {
      const raw = await c.settings.get<string>(LAST_BANDS_KEY);
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (v === 0 || v === 1 || v === 2) bands[k] = v;
      }
    } catch { bands = {}; }
    const [n70, n90, nReset] = [await c.settings.get<boolean>(NOTIFY_70_KEY), await c.settings.get<boolean>(NOTIFY_90_KEY), await c.settings.get<boolean>(NOTIFY_RESET_KEY)];
    let changed = false;
    for (const limit of next.budgetLimits) {
      const band = bandFor(limit.usedPercentage);
      const old = bands[limit.budgetDuration];
      if (band === old) continue;
      bands[limit.budgetDuration] = band;
      changed = true;
      if (old !== undefined && band > old) {
        const text = line(limit, now());
        if (band === 2 && n90 !== false) notify('Gateway budget over 90%', `${limit.budgetDuration} window at ${text}`);
        else if (band === 1 && n70 !== false) notify('Gateway budget over 70%', `${limit.budgetDuration} window at ${text}`);
      }
    }
    if (nReset === true && previous) {
      for (const limit of next.budgetLimits) {
        const old = previous.budgetLimits.find(p => p.budgetDuration === limit.budgetDuration);
        if (old && limit.currentSpend < old.currentSpend - 0.005) {
          notify('Gateway budget window reset', `${limit.budgetDuration} window reset — now ${money(limit.currentSpend)} of ${money(limit.maxBudget)}`);
        }
      }
    }
    if (changed) await c.settings.set(LAST_BANDS_KEY, JSON.stringify(bands));
  };

  const succeeded = async (c: PluginContext, status: BudgetStatus, reason: string): Promise<void> => {
    const previous = snapshot;
    snapshot = status;
    fetchedAt = now();
    state = 'ok';
    lastFailurePosted = false;
    await c.settings.set(SNAPSHOT_KEY, encodeStatus(status));
    await c.settings.set(LAST_FETCH_AT_KEY, fetchedAt / 1000);
    await evaluateThresholds(c, previous, status);
    c.reportHealth(health.ok(healthDetail()));
    c.logger.info(`${reason} fetch finished — ${status.budgetLimits.length} window(s)`);
  };

  const failed = async (c: PluginContext, error: unknown, reason: string): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    c.logger.error(`${reason} fetch failed: ${message}`);
    if (error instanceof BudgetClientError && (error.kind === 'authUnavailable' || error.kind === 'unauthorized')) {
      state = 'authFailed';
      c.reportHealth(health.error(message));
      return;
    }
    // Offline, timeout, malformed: keep the snapshot on display, marked stale.
    if (snapshot) state = 'stale';
    c.reportHealth(health.warning(healthDetail()));
    if (!lastFailurePosted) { // one banner per outage
      lastFailurePosted = true;
      notify('Gateway budget couldn’t refresh', `${message}. Showing the last data — retrying every ${interval}s.`);
    }
  };

  const startRun = (reason: 'manual' | 'scheduled'): Promise<void> => {
    const run = doRun(reason);
    currentRun = run;
    return run;
  };

  const doRun = async (reason: 'manual' | 'scheduled'): Promise<void> => {
    const c = ctx;
    if (!c) return;
    if (running) running.cancelled = true;
    const token = { cancelled: false };
    running = token;
    const live = () => !token.cancelled && ctx === c;
    try {
      gateway ??= await buildGateway(c);
      let outcome: { ok: true; status: BudgetStatus } | { ok: false; error: unknown };
      try { outcome = { ok: true, status: await gateway.fetch() }; } catch (error) { outcome = { ok: false, error }; }
      if (!live()) return; // superseded or deactivated
      if (outcome.ok) await succeeded(c, outcome.status, reason);
      else await failed(c, outcome.error, reason);
      if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await arm(); }
      publish();
    } catch { /* deactivated mid-run: the context is revoked */ }
    finally { if (running === token) running = null; }
  };

  return {
    metadata: { id: PLUGIN_ID, name: 'AI Gateway Budget', icon: 'gauge', summary: 'Shows the AI gateway’s rolling budget windows, spend, and reset countdowns', version: '2.0.0' },
    settings: settingsSchema,
    get currentRun() { return currentRun; },

    async activate(context) {
      ctx = context;
      await context.settings.registerDefaults({
        [STATUS_URL_KEY]: PRODUCTION_URL, [POLL_INTERVAL_KEY]: 60,
        [NOTIFY_70_KEY]: true, [NOTIFY_90_KEY]: true, [NOTIFY_RESET_KEY]: false,
      });
      // Warm start: the last snapshot shows until the catch-up fetch lands.
      try {
        const raw = await context.settings.get<string>(SNAPSHOT_KEY);
        const at = await context.settings.get<number>(LAST_FETCH_AT_KEY);
        if (typeof raw === 'string' && typeof at === 'number') { snapshot = decodeStatus(raw); fetchedAt = at * 1000; state = 'ok'; }
      } catch { snapshot = null; fetchedAt = null; state = 'neverFetched'; }
      lastFailurePosted = false;
      unwatch = context.settings.onChange(key => {
        if (key === STATUS_URL_KEY || key === POLL_INTERVAL_KEY) { gateway = null; void arm(); }
      });
      ticker = setInterval(publish, 60_000); // countdowns stay current between polls
      await arm();
      context.reportHealth(health.ok(healthDetail()));
      publish();
      context.logger.info(`activated — polling every ${interval}s`);
    },

    async deactivate() {
      if (running) running.cancelled = true;
      unwatch?.();
      unwatch = null;
      if (ticker) clearInterval(ticker);
      ticker = null;
      await ctx?.scheduler.cancel(JOB_ID).catch(() => {});
      ctx = null;
      gateway = null;
      tokens = null;
      snapshot = null;
      fetchedAt = null;
      state = 'neverFetched';
      lastFailurePosted = false;
    },

    async onJob(id) { if (id === JOB_ID) await startRun('scheduled'); },

    async onMenuItem(id) {
      if (id === 'refresh') void startRun('manual');
      if (id === 'details') ctx?.requestOpenDetail();
    },

    actions: () => [{ name: 'refresh-now', title: 'Refresh gateway budget now', summary: 'Fetch the current Boomi AI gateway budget counters', acceptsText: false }],

    async perform(action) {
      if (action !== 'refresh-now') return undefined;
      void startRun('manual');
      return 'Gateway budget refresh started';
    },
  };
}

export default definePlugin(() => createGatewayBudget());
