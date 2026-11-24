// Claude Spend: polls claude.ai's member usage endpoint (what Claude Desktop's
// Settings → Usage page fetches: undocumented, member-facing), authenticated
// by Claude Desktop's own session cookies, and shows
// `Claude credits $304.82 / $1,100.00 (28%)` in the menu with threshold,
// limit-reached and reset notifications. Port of the Swift ClaudeSpendPlugin.
//
// The endpoint has no contract: a decode failure keeps the last-good snapshot
// (never a silent $0); money uses the payload's own exponent; percentages are
// the server's `utilization`. Polling is a calendar schedule (default hourly:
// credits move slowly) with never-run catch-up. Failed fetches post at most one
// banner per hour (OutageNotifier). The session cookie is a live credential:
// in memory for one fetch only, never settings, logs or errors. The persisted
// snapshot carries usage numbers only.
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
import { ClaudeUsageClient, ORG_UUID_KEY, ORG_UUID_OVERRIDE_KEY, UsageError } from './client.js';
import { SAVED_COOKIE_SECRET, SessionCookieProvider, type CookieSource } from './cookies.js';
import {
  bandFor, creditsDisabled, decodeUsage, disabledReason, encodeUsage, formatPercent, formatStatusTime, hasSeatWindows, limitMoney,
  numbersFor, spendLimitReached, statusLineFor, usedCreditsMinor, usedMoney, utilizationPercent,
  type Band, type ClaudeUsageStatus,
} from './model.js';
import { OutageNotifier } from './outage.js';

export const PLUGIN_ID = 'claudespend';
export const JOB_ID = `${PLUGIN_ID}.poll`;
export const SNAPSHOT_KEY = 'lastSnapshotJSON';
export const LAST_FETCH_AT_KEY = 'lastFetchAt';
export const NOTIFY_70_KEY = 'notifyAt70';
export const NOTIFY_90_KEY = 'notifyAt90';
export const NOTIFY_RESET_KEY = 'notifyOnReset';
export const NOTIFY_CONNECTION_KEY = 'notifyOnConnectionError';
/** {"credits": band}: one notification per crossing, across relaunches. */
export const LAST_BANDS_KEY = 'lastBandsJSON';
export const LIMIT_REACHED_KEY = 'lastLimitReached';
export const LAST_RESET_AT_KEY = 'lastResetAt';
/** The retired 1/5/15-minute interval picker, read once by the schedule migration. */
export const LEGACY_INTERVAL_KEY = 'pollIntervalSeconds';

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Usage credits',
      fields: [
        { type: 'status', key: 'credits', label: 'Monthly credits' },
        { type: 'status', key: 'updated', label: 'Updated' },
        { type: 'status', key: 'seatWindows', label: 'Seat windows' },
        { type: 'action', key: 'refresh-now', label: 'Refresh now', help: 'Fetches the credits now — doesn’t change the cadence.' },
      ],
    },
    {
      title: 'Schedule',
      fields: [{ type: 'schedule', key: ScheduledJobController.specKey, label: 'Runs', help: 'Credits move slowly — hourly is plenty. Narrow it to certain times or days.' }],
    },
    {
      title: 'Notifications',
      fields: [
        { type: 'toggle', key: NOTIFY_70_KEY, label: 'Notify at 70% of the monthly credits', default: true },
        { type: 'toggle', key: NOTIFY_90_KEY, label: 'Notify at 90% of the monthly credits', default: true },
        { type: 'toggle', key: NOTIFY_RESET_KEY, label: 'Notify when the monthly window resets', default: false },
        { type: 'toggle', key: NOTIFY_CONNECTION_KEY, label: 'Notify when the connection fails', default: true, help: 'Connection-failure banners are limited to one per hour and survive relaunches; the failure always shows in the status line regardless.' },
      ],
    },
    {
      title: 'Account',
      fields: [
        { type: 'text', key: ORG_UUID_OVERRIDE_KEY, label: 'Org id', placeholder: 'auto-discovered', help: 'Auto-discovered from Claude Desktop’s session (the lastActiveOrg cookie). Paste a UUID to pin it; empty restores auto-discovery.' },
        { type: 'secret', key: SAVED_COOKIE_SECRET, label: 'Session cookie', placeholder: 'sessionKey=… (paste to override)', help: 'Normally the plugin authenticates through Claude Desktop’s own session (Keychain “Claude Safe Storage” → its cookie database; the first read prompts for Keychain access). A cookie saved here wins over it.' },
        { type: 'status', key: 'auth', label: 'Authenticating via' },
        { type: 'status', key: 'org', label: 'Org' },
      ],
    },
  ],
};

/** Every existing install lands on hourly (the fastest cadence; credits move slowly); the old key is removed. */
export async function migrateLegacyInterval(settings: SettingsStore): Promise<ScheduleSpec | null> {
  if ((await settings.get(LEGACY_INTERVAL_KEY)) === undefined) return null;
  await settings.delete(LEGACY_INTERVAL_KEY);
  return schedules.everyNHours(1);
}

type PollState = { kind: 'neverFetched' | 'ok' | 'stale' | 'authFailed' } | { kind: 'creditsDisabled'; reason: string };

export interface ClaudeSpendOptions {
  /** Injectable cookie source (the real one reads the Keychain and Claude Desktop's cookie DB). */
  readonly cookies?: (ctx: PluginContext) => CookieSource;
  readonly now?: () => number;
}

export function createClaudeSpend(options: ClaudeSpendOptions = {}): CapabilityPlugin & { readonly currentRun: Promise<void> | null } {
  const now = options.now ?? Date.now;
  let ctx: PluginContext | null = null;
  let controller: ScheduledJobController | null = null;
  let outage: OutageNotifier | null = null;
  let source: CookieSource | null = null;
  let client: ClaudeUsageClient | null = null;
  let unwatch: (() => void) | null = null;
  let running: { cancelled: boolean } | null = null;
  let currentRun: Promise<void> | null = null;

  let snapshot: ClaudeUsageStatus | null = null;
  let fetchedAt: number | null = null;
  let state: PollState = { kind: 'neverFetched' };
  let usingSavedCookie = false;

  // ------------------------------------------------------------ display state

  /** The menu status line. `⚠` marks the stale-offline state; auth, disabled and never-fetched
   *  get their own lines instead of a misleading $0. */
  const statusLine = (): string => {
    switch (state.kind) {
      case 'authFailed': return 'Claude credits — sign in to Claude Desktop';
      case 'neverFetched': return 'Claude credits — waiting for first fetch';
      case 'creditsDisabled': return 'Claude credits — usage credits disabled';
      default:
        if (!snapshot || (!usedMoney(snapshot) && !limitMoney(snapshot))) return 'Claude credits — no data yet';
        return (state.kind === 'stale' ? '⚠ ' : '') + statusLineFor(snapshot);
    }
  };

  const healthDetail = (): string => {
    switch (state.kind) {
      case 'ok': return statusLine();
      case 'stale': return `Offline — showing data from ${fetchedAt ? formatStatusTime(new Date(fetchedAt)) : 'unknown time'}`;
      case 'authFailed': return 'No usable Claude Desktop session — sign in to Claude Desktop, approve Keychain access, or paste a session cookie on this page';
      case 'creditsDisabled': return state.reason ? `Usage credits are disabled — ${state.reason}` : 'Usage credits are disabled';
      case 'neverFetched': return 'Waiting for the first usage-credits fetch';
    }
  };

  const publish = async (): Promise<void> => {
    const c = ctx;
    if (!c) return;
    const rows: MenuItem[] = [
      { kind: 'text', label: statusLine() },
      { kind: 'item', id: 'refresh', label: 'Refresh Now' },
      { kind: 'item', id: 'details', label: 'Open Claude Credits Details…' },
    ];
    c.menu.set(rows);
    const org = (await c.settings.get<string>(ORG_UUID_KEY)) ?? (await c.settings.get<string>(ORG_UUID_OVERRIDE_KEY));
    const lastReset = await c.settings.get<number>(LAST_RESET_AT_KEY);
    c.reportStatus({
      credits: snapshot && state.kind !== 'creditsDisabled' && (usedMoney(snapshot) || limitMoney(snapshot))
        ? `${numbersFor(snapshot)} — resets monthly${lastReset ? ` (last reset ${formatStatusTime(new Date(lastReset * 1000)).split(',')[0]})` : ''}`
        : state.kind === 'creditsDisabled' ? `Usage credits disabled${state.reason ? ` — ${state.reason}` : ''}` : 'No data yet',
      updated: fetchedAt ? formatStatusTime(new Date(fetchedAt)) : null,
      seatWindows: snapshot && hasSeatWindows(snapshot) ? 'Present on this org — usage credits may have been switched off. Rendering for them arrives with a live payload to pin the shape.' : null,
      auth: usingSavedCookie ? 'the session cookie saved on this page' : 'Claude Desktop’s own session (Keychain + cookie store)',
      org: org ?? null,
    });
  };

  const reportHealth = (): void => {
    if (!ctx) return;
    ctx.reportHealth(state.kind === 'creditsDisabled' || state.kind === 'authFailed' ? health.error(healthDetail())
      : state.kind === 'stale' ? health.warning(healthDetail()) : health.ok(healthDetail()));
  };

  // ------------------------------------------------------------ snapshot + band memory

  const loadSnapshot = async (c: PluginContext): Promise<void> => {
    try {
      const raw = await c.settings.get<string>(SNAPSHOT_KEY);
      const at = await c.settings.get<number>(LAST_FETCH_AT_KEY);
      if (typeof raw !== 'string' || typeof at !== 'number') return;
      snapshot = decodeUsage(raw);
      fetchedAt = at * 1000;
      state = creditsDisabled(snapshot) ? { kind: 'creditsDisabled', reason: disabledReason(snapshot) ?? '' } : { kind: 'ok' };
    } catch { snapshot = null; fetchedAt = null; state = { kind: 'neverFetched' }; } // a corrupt value is "no snapshot": the next fetch rewrites it
  };

  const lastBand = async (s: SettingsStore): Promise<Band | undefined> => {
    try {
      const v = (JSON.parse((await s.get<string>(LAST_BANDS_KEY)) ?? '') as { credits?: unknown }).credits;
      return v === 0 || v === 1 || v === 2 ? v : undefined;
    } catch { return undefined; } // unreadable memory costs at most one duplicate notification, never a missed one
  };

  const post = (title: string, body: string): void => {
    void ctx?.notifications.post({ title, subtitle: 'Claude Spend', body }).catch(() => {});
  };

  /** Notifies when utilization CROSSES into a band (≥70 / ≥90), when `spend_limit_reached` flips
   *  false→true, and when spend DROPS (the monthly window rolled: the payload carries no reset date,
   *  so the drop IS the reset). Memory persists: one notification per crossing, none after a relaunch,
   *  first sighting silent (no install-time spam). */
  const evaluateThresholds = async (c: PluginContext, previous: ClaudeUsageStatus | null, next: ClaudeUsageStatus): Promise<void> => {
    const s = c.settings;
    const util = utilizationPercent(next);
    if (util !== undefined) {
      const band = bandFor(util);
      const old = await lastBand(s);
      if (band !== old) {
        await s.set(LAST_BANDS_KEY, JSON.stringify({ credits: band }));
        if (old !== undefined && band > old) {
          if (band === 2 && (await s.get<boolean>(NOTIFY_90_KEY)) !== false) post('Claude credits over 90%', `Usage credits at ${formatPercent(util)} — ${numbersFor(next)}`);
          else if (band === 1 && (await s.get<boolean>(NOTIFY_70_KEY)) !== false) post('Claude credits over 70%', `Usage credits at ${formatPercent(util)} — ${numbersFor(next)}`);
        }
      }
    }
    const reached = spendLimitReached(next);
    const lastReached = await s.get<boolean>(LIMIT_REACHED_KEY); // undefined = first sighting, silent
    if (lastReached === false && reached) post('Claude credits spent — limit reached', 'The monthly usage-credit limit is exhausted.');
    await s.set(LIMIT_REACHED_KEY, reached);

    const newCredits = usedCreditsMinor(next); const oldCredits = previous ? usedCreditsMinor(previous) : undefined;
    if (newCredits !== undefined && oldCredits !== undefined && newCredits < oldCredits - 0.5) {
      await s.set(LAST_RESET_AT_KEY, Math.floor(now() / 1000)); // always recorded; the notification only when the toggle is on
      if ((await s.get<boolean>(NOTIFY_RESET_KEY)) === true) post('Claude credits reset', `The monthly window rolled — now ${numbersFor(next)}.`);
    }
  };

  // ------------------------------------------------------------ runs

  const succeeded = async (c: PluginContext, reason: string, status: ClaudeUsageStatus): Promise<void> => {
    const previous = snapshot;
    snapshot = status;
    fetchedAt = now();
    usingSavedCookie = source?.usingSavedCookie ?? false;
    // A disabled org is a SUCCESSFUL fetch of "credits are off": still snapshotted (the page shows the
    // reason and the last numbers), but health is an error and the menu never shows numbers as current.
    state = creditsDisabled(status) ? { kind: 'creditsDisabled', reason: disabledReason(status) ?? '' } : { kind: 'ok' };
    await c.settings.set(SNAPSHOT_KEY, encodeUsage(status));
    await c.settings.set(LAST_FETCH_AT_KEY, fetchedAt / 1000);
    await evaluateThresholds(c, previous, status);
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    reportHealth();
    const u = usedMoney(status); const l = limitMoney(status);
    c.logger.info(`${reason} fetch finished — used ${u ? u.amountMinor : '?'} minor of ${l ? l.amountMinor : '?'} minor${creditsDisabled(status) ? ' (disabled)' : ''}`);
    await publish();
  };

  const failed = async (c: PluginContext, reason: string, error: unknown): Promise<void> => {
    if (reason === 'manual') { await c.scheduler.recordRun(JOB_ID); await controller?.manualRunFinished(); }
    const message = error instanceof Error ? error.message : String(error);
    c.logger.error(`${reason} fetch failed: ${message}`);
    if (error instanceof UsageError && (error.kind === 'authUnavailable' || error.kind === 'unauthorized')) {
      state = { kind: 'authFailed' }; // the health line carries it: no banner
    } else {
      // Offline / timeout / malformed / Cloudflare: keep the snapshot on display and mark it stale.
      if (snapshot) state = { kind: 'stale' };
      if (await outage?.recordFailure()) post('Claude credits couldn’t refresh', `${message}. Showing the last data — it will try again at the next scheduled run.`);
    }
    reportHealth();
    await publish();
  };

  const doRun = async (reason: 'manual' | 'scheduled'): Promise<void> => {
    const c = ctx;
    if (!c) return;
    if (!client) {
      source ??= options.cookies ? options.cookies(c) : new SessionCookieProvider({ savedCookie: () => c.secrets.get(SAVED_COOKIE_SECRET), storage: c.storage });
      client = new ClaudeUsageClient(c.http, source, c.settings);
    }
    if (running) running.cancelled = true;
    const token = { cancelled: false };
    running = token;
    const live = () => !token.cancelled && ctx === c;
    try {
      let outcome: { ok: true; status: ClaudeUsageStatus } | { ok: false; error: unknown };
      try { outcome = { ok: true, status: await client.fetch() }; } catch (error) { outcome = { ok: false, error }; }
      if (!live()) return; // superseded or deactivated
      if (outcome.ok) await succeeded(c, reason, outcome.status); else await failed(c, reason, outcome.error);
    } catch { /* deactivated mid-run: the context is revoked */ }
    finally { if (running === token) running = null; }
  };

  const startRun = (reason: 'manual' | 'scheduled'): Promise<void> => { const run = doRun(reason); currentRun = run; return run; };

  return {
    metadata: { id: PLUGIN_ID, name: 'Claude Spend', icon: 'credit-card', summary: 'Shows the Claude Desktop/Cowork usage-credit budget and thresholds', version: '2.0.0' },
    settings: settingsSchema,
    get currentRun() { return currentRun; },

    async activate(context) {
      ctx = context;
      await context.settings.registerDefaults({ [NOTIFY_70_KEY]: true, [NOTIFY_90_KEY]: true, [NOTIFY_RESET_KEY]: false, [NOTIFY_CONNECTION_KEY]: true });
      // Warm start: the last snapshot shows until the catch-up fetch lands.
      await loadSnapshot(context);
      outage = new OutageNotifier(context.settings, NOTIFY_CONNECTION_KEY, undefined, now);
      controller = await ScheduledJobController.create({
        jobId: JOB_ID, // kept from the interval era: preserves the recorded last run
        defaultSpec: schedules.everyNHours(1),
        context,
        migrateLegacy: migrateLegacyInterval,
        onFire: () => startRun('scheduled'),
      });
      controller.onChange(() => void publish());
      // An org or cookie change on the page: rebuild the client (and so the cookie source) on the next run.
      unwatch = context.settings.onChange(key => { if (key === ORG_UUID_OVERRIDE_KEY) client = null; });
      await controller.arm();
      reportHealth();
      await publish();
      context.logger.info(`activated — schedule ${JSON.stringify(controller.spec)}`);
    },

    async deactivate() {
      if (running) running.cancelled = true;
      unwatch?.(); unwatch = null;
      await controller?.disarm().catch(() => {});
      controller = null; outage = null; source = null; client = null; ctx = null;
      snapshot = null; fetchedAt = null; state = { kind: 'neverFetched' }; usingSavedCookie = false;
    },

    onJob: async id => { await controller?.onJob(id); },
    onJobNextRun: (id, next) => controller?.onJobNextRun(id, next),

    async onMenuItem(id) {
      if (id === 'refresh') void startRun('manual');
      if (id === 'details') ctx?.requestOpenDetail();
    },

    actions: () => [{ name: 'refresh-now', title: 'Refresh Claude credits now', summary: 'Fetch the current Claude Desktop/Cowork usage credits', acceptsText: false }],

    async perform(action) {
      if (action !== 'refresh-now') return undefined;
      // Starts the fetch and returns at once; the outcome lands in health (and a banner on a fresh outage).
      void startRun('manual');
      return 'Claude credits refresh started';
    },
  };
}

export default definePlugin(() => createClaudeSpend());
