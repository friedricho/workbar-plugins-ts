// Ported from ClaudeSpendPluginTests: the plugin end to end on the SDK test
// kit (fake HTTP, fake cookie source; the real Keychain and cookie DB are
// never touched). The host's never-run catch-up is simulated with onJob.
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { ScheduledJobController, schedules, validateSettingsSchema } from '@workbar/sdk';
import {
  createClaudeSpend, JOB_ID, LAST_BANDS_KEY, LAST_FETCH_AT_KEY, LAST_RESET_AT_KEY, LEGACY_INTERVAL_KEY, LIMIT_REACHED_KEY, NOTIFY_70_KEY,
  NOTIFY_CONNECTION_KEY, NOTIFY_RESET_KEY, SNAPSHOT_KEY, settingsSchema,
} from '../src/index.js';
import { OUTAGE_KEY } from '../src/outage.js';
import { SessionCookieError } from '../src/cookies.js';
import { CANARY_SESSION, FakeCookies, fakeHttp, fixture, usageJSON } from './support.js';

type Plugin = ReturnType<typeof createClaudeSpend>;

function setup(seed: Record<string, unknown> = {}, clock = { t: Date.parse('2026-11-23T20:00:00Z') }) {
  const t: TestContext = createTestContext('claudespend');
  for (const [k, v] of Object.entries(seed)) t.settings.set(k, v);
  const http = fakeHttp();
  const cookies = new FakeCookies();
  (t.context as { http: unknown }).http = http;
  const plugin = createClaudeSpend({ cookies: () => cookies, now: () => clock.t });
  return { t, plugin, http, cookies, clock };
}
const poll = async (p: Plugin) => { await p.onJob!(JOB_ID); await p.currentRun; };
const run = async (p: Plugin) => { await p.perform!('refresh-now'); await p.currentRun; };
const line = (t: TestContext) => (t.menu[0] as { label: string }).label;
const posts = (t: TestContext, title: string) => t.notifications.filter(n => n.title === title).length;
const LIVE = 'Claude credits $304.82 / $1,100.00 (28%)';

/** A started plugin with one good poll on the books. */
async function started(seed: Record<string, unknown> = {}, clock?: { t: number }) {
  const s = setup(seed, clock);
  await s.plugin.activate(s.t.context);
  await poll(s.plugin);
  return s;
}

describe('Claude Spend plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation arms an hourly poll; the catch-up fetch shows the credits line, with Refresh and Details rows', async () => {
    const { t, plugin, http } = setup();
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ schedule: schedules.everyNHours(1) });
    expect(t.settings.has(ScheduledJobController.specKey)).toBe(false); // the default is not persisted, so a later change applies
    expect(line(t)).toBe('Claude credits — waiting for first fetch');
    await poll(plugin);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: LIVE });
    expect(t.menu).toEqual([
      { kind: 'text', label: LIVE },
      { kind: 'item', id: 'refresh', label: 'Refresh Now' },
      { kind: 'item', id: 'details', label: 'Open Claude Credits Details…' },
    ]);
    expect(http.calls[0]!.headers.cookie).toContain(CANARY_SESSION);
    expect(t.settings.has(SNAPSHOT_KEY)).toBe(true);
    expect(t.settings.has(LAST_FETCH_AT_KEY)).toBe(true);
    expect(t.status.get('credits')).toBe('$304.82 of $1,100.00 (28%) — resets monthly');
  });

  it('opening the menu never fetches: only a poll does', async () => {
    const { t, http } = await started();
    const before = http.calls.length;
    t.menu.length; // reading cached rows
    expect(http.calls.length).toBe(before);
  });

  it('the legacy poll-interval setting migrates once to hourly and is removed', async () => {
    const { t, plugin } = setup({ [LEGACY_INTERVAL_KEY]: 300 });
    await plugin.activate(t.context);
    expect(t.settings.get(ScheduledJobController.specKey)).toEqual(schedules.everyNHours(1));
    expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
    expect(t.settings.get(ScheduledJobController.legacyMigratedKey)).toBe(true);
  });

  it('deactivate cancels the job and an in-flight run, and keeps the recorded last run', async () => {
    const { t, plugin, http } = await started();
    const lastRun = t.lastRuns.get(JOB_ID);
    http.delayMs = 200;
    void plugin.perform!('refresh-now');
    await plugin.deactivate();
    await plugin.currentRun;
    expect(t.jobs.has(JOB_ID)).toBe(false);
    expect(t.lastRuns.get(JOB_ID)).toBe(lastRun);
    expect(t.health.at(-1)!.kind).not.toBe('error'); // the cancelled run reported nothing
  });

  it('the schedule can be changed live; the recorded last run is kept', async () => {
    const { t, plugin } = await started();
    await t.context.settings.set(ScheduledJobController.specKey, schedules.daily(9 * 60));
    await new Promise(r => setTimeout(r, 0));
    expect(t.jobs.get(JOB_ID)).toEqual({ schedule: schedules.daily(9 * 60) });
    void plugin;
  });

  // ---------------------------------------------------------------- offline / auth / disabled

  it('offline keeps the snapshot on display, marks it stale, and posts one banner per outage (a flap does not re-arm)', async () => {
    const { t, plugin, http } = await started();
    http.error = new Error('net::ERR_INTERNET_DISCONNECTED');
    await run(plugin); await run(plugin);
    expect(line(t)).toBe(`⚠ ${LIVE}`);
    expect(t.health.at(-1)!.kind).toBe('warning');
    expect(posts(t, 'Claude credits couldn’t refresh')).toBe(1);
    http.error = undefined; // recovery clears the stale marker
    await run(plugin);
    expect(line(t)).toBe(LIVE);
    http.error = new Error('net::ERR_INTERNET_DISCONNECTED'); // a flap: fail → succeed → fail
    await run(plugin);
    expect(posts(t, 'Claude credits couldn’t refresh')).toBe(1); // the gate is time-only
  });

  it('a Cloudflare 403 is stale-class (retry later), not the auth line', async () => {
    const { t, plugin, http } = await started();
    http.handler = () => [403, '<!DOCTYPE html><html>challenge</html>'];
    await run(plugin);
    expect(line(t).startsWith('⚠ Claude credits $')).toBe(true);
    const n = t.notifications.find(x => x.title === 'Claude credits couldn’t refresh')!;
    expect(n.body).toContain('Cloudflare');
    expect(n.body).toContain('next scheduled run');
    expect(n.body).not.toContain('retrying every');
  });

  it('a relaunch during a continuing outage stays quiet inside the cooldown', async () => {
    const first = await started();
    first.http.error = new Error('offline');
    await run(first.plugin);
    expect(posts(first.t, 'Claude credits couldn’t refresh')).toBe(1);
    await first.plugin.deactivate();
    // A fresh plugin over the SAME settings: the persisted post time is still inside the window.
    const t2 = createTestContext('claudespend');
    for (const [k, v] of first.t.settings) t2.settings.set(k, v);
    const http2 = fakeHttp({ error: new Error('offline') });
    (t2.context as { http: unknown }).http = http2;
    const p2 = createClaudeSpend({ cookies: () => new FakeCookies(), now: () => first.clock.t });
    await p2.activate(t2.context);
    await poll(p2);
    expect(line(t2)).toBe(`⚠ ${LIVE}`); // warm-started from the snapshot, now stale
    expect(posts(t2, 'Claude credits couldn’t refresh')).toBe(0);
  });

  it('the connection-error toggle silences the banner; the failure still reports health and the stale line', async () => {
    const { t, plugin, http } = await started({ [NOTIFY_CONNECTION_KEY]: false });
    http.error = new Error('offline');
    await run(plugin);
    expect(t.notifications).toEqual([]);
    expect(line(t).startsWith('⚠ Claude credits $')).toBe(true);
    expect(t.health.at(-1)!.kind).toBe('warning');
    expect(t.settings.has(OUTAGE_KEY)).toBe(false); // a banner that never showed must not start the window
  });

  it('a failure after the cooldown elapses posts again', async () => {
    const clock = { t: Date.parse('2026-11-23T20:00:00Z') };
    const { t, plugin, http } = await started({}, clock);
    http.error = new Error('offline');
    await run(plugin);
    expect(posts(t, 'Claude credits couldn’t refresh')).toBe(1);
    clock.t += 59 * 60_000; await run(plugin);
    expect(posts(t, 'Claude credits couldn’t refresh')).toBe(1);
    clock.t += 2 * 60_000; await run(plugin); // 61 minutes after the banner
    expect(posts(t, 'Claude credits couldn’t refresh')).toBe(2);
  });

  it('auth failure shows the sign-in line and an error, never a silent $0, and no request leaves', async () => {
    const { t, plugin, http, cookies } = setup();
    cookies.error = new SessionCookieError('keychainDenied', 'security exit 51');
    await plugin.activate(t.context);
    await poll(plugin);
    const h = t.health.at(-1)!;
    expect(h.kind).toBe('error');
    const detail = (h as { detail: string }).detail;
    expect(detail).toContain('sign in to Claude Desktop');
    expect(line(t)).toBe('Claude credits — sign in to Claude Desktop');
    expect(t.notifications).toEqual([]); // the health line carries it
    expect(http.calls).toEqual([]);
    const logged = t.logs.filter(l => l.level === 'error').map(l => l.message).join('\n');
    expect(logged).toContain('couldn’t get Claude Desktop’s session cookies');
    expect(logged).toContain('Claude Safe Storage');
  });

  it('a signed-out desktop app (401) shows the sign-in line too', async () => {
    const { t, plugin, http } = setup();
    http.handler = () => [401, '{"error": "session expired"}'];
    await plugin.activate(t.context);
    await poll(plugin);
    expect(t.health.at(-1)!.kind).toBe('error');
    expect(line(t)).toBe('Claude credits — sign in to Claude Desktop');
  });

  it('credits disabled shows its own line and reason, never a silent $0, and is still snapshotted', async () => {
    const { t, plugin, http } = setup();
    http.handler = () => [200, fixture('claude-usage-credits-disabled')];
    await plugin.activate(t.context);
    await poll(plugin);
    const h = t.health.at(-1) as { kind: string; detail: string };
    expect(h.kind).toBe('error');
    expect(h.detail).toContain('disabled');
    expect(h.detail).toContain('Your admin disabled usage credits');
    expect(line(t)).toBe('Claude credits — usage credits disabled');
    expect(t.settings.has(SNAPSHOT_KEY)).toBe(true);
    expect(t.status.get('credits')).toContain('Usage credits disabled — Your admin disabled usage credits');
  });

  it('an undecodable 200 keeps the last-good snapshot (fail closed), never zeros', async () => {
    const { t, plugin, http } = await started();
    http.handler = () => [200, '{"spend": null}'];
    await run(plugin);
    expect(line(t)).toBe(`⚠ ${LIVE}`);
    expect(t.settings.get(SNAPSHOT_KEY)).toContain('30482');
  });

  // ---------------------------------------------------------------- thresholds, limit-reached, resets

  it('band crossings notify once; repeats and first sightings don’t', async () => {
    const { t, plugin, http } = await started(); // first sighting at 28% (green): recorded, NOT notified
    expect(t.notifications).toEqual([]);
    http.handler = () => [200, usageJSON({ usedMinor: 82500, limitMinor: 110000, utilization: 75 })];
    await run(plugin);
    expect(posts(t, 'Claude credits over 70%')).toBe(1);
    await run(plugin); // the same band again: silent
    expect(posts(t, 'Claude credits over 70%')).toBe(1);
    http.handler = () => [200, usageJSON({ usedMinor: 104500, limitMinor: 110000, utilization: 95 })];
    await run(plugin);
    expect(posts(t, 'Claude credits over 90%')).toBe(1);
    expect(t.notifications.find(n => n.title === 'Claude credits over 90%')!.body).toBe('Usage credits at 95% — $1,045.00 of $1,100.00 (95%)');
    expect(JSON.parse(t.settings.get(LAST_BANDS_KEY) as string)).toEqual({ credits: 2 }); // memory persisted (same shape as Swift's)
  });

  it('the 70% toggle silences the early warning; 90% stays on', async () => {
    const { t, plugin, http } = await started({ [NOTIFY_70_KEY]: false });
    http.handler = () => [200, usageJSON({ usedMinor: 82500, limitMinor: 110000, utilization: 75 })];
    await run(plugin);
    expect(posts(t, 'Claude credits over 70%')).toBe(0);
    http.handler = () => [200, usageJSON({ usedMinor: 104500, limitMinor: 110000, utilization: 95 })];
    await run(plugin);
    expect(posts(t, 'Claude credits over 90%')).toBe(1);
  });

  it('a relaunch does not repeat a band notification (the band memory persists)', async () => {
    const { t, plugin, http } = await started();
    http.handler = () => [200, usageJSON({ usedMinor: 82500, limitMinor: 110000, utilization: 75 })];
    await run(plugin);
    await plugin.deactivate();
    const t2 = createTestContext('claudespend');
    for (const [k, v] of t.settings) t2.settings.set(k, v);
    (t2.context as { http: unknown }).http = fakeHttp({ handler: () => [200, usageJSON({ usedMinor: 83000, limitMinor: 110000, utilization: 75.5 })] });
    const p2 = createClaudeSpend({ cookies: () => new FakeCookies() });
    await p2.activate(t2.context);
    await poll(p2);
    expect(posts(t2, 'Claude credits over 70%')).toBe(0);
  });

  it('limit-reached posts only on the false→true transition (first sighting silent)', async () => {
    const { t, plugin, http } = await started();
    const reached = () => [200, usageJSON({ usedMinor: 110000, limitMinor: 110000, utilization: 100, spendLimitReached: true, severity: 'exceeded' })] as [number, string];
    http.handler = reached;
    await run(plugin);
    expect(posts(t, 'Claude credits spent — limit reached')).toBe(1);
    await run(plugin); // still reached: silent
    expect(posts(t, 'Claude credits spent — limit reached')).toBe(1);
    http.handler = () => [200, usageJSON({ usedMinor: 0, limitMinor: 110000, utilization: 0 })]; // the reset…
    await run(plugin);
    http.handler = reached; // …then reached again: a second transition posts again
    await run(plugin);
    expect(posts(t, 'Claude credits spent — limit reached')).toBe(2);
  });

  it('a first sighting that is already limit-reached stays silent', async () => {
    const { t, plugin, http } = setup();
    http.handler = () => [200, fixture('claude-usage-limit-reached')];
    await plugin.activate(t.context);
    await poll(plugin);
    expect(t.notifications).toEqual([]);
    expect(t.settings.get(LIMIT_REACHED_KEY)).toBe(true);
  });

  it('a spend drop (monthly reset) is always recorded, and notifies only when the toggle is on', async () => {
    const drop = () => [200, usageJSON({ usedMinor: 500, limitMinor: 110000, utilization: 0.5 })] as [number, string];
    const off = await started(); // toggle OFF (the default)
    off.http.handler = drop;
    await run(off.plugin);
    expect(posts(off.t, 'Claude credits reset')).toBe(0);
    expect(off.t.settings.get(LAST_RESET_AT_KEY)).toBe(Math.floor(off.clock.t / 1000));
    const on = await started({ [NOTIFY_RESET_KEY]: true });
    on.http.handler = drop;
    await run(on.plugin);
    expect(posts(on.t, 'Claude credits reset')).toBe(1);
    expect(on.t.notifications.find(n => n.title === 'Claude credits reset')!.body).toBe('The monthly window rolled — now $5.00 of $1,100.00 (1%).');
  });

  it('a reset needs a real drop: noise inside half a minor unit and an unchanged spend do not count, a real drop does', async () => {
    // spend.used.amount_minor stays an integer (as in the real payload); only extra_usage.used_credits is a float.
    const at = (usedCredits: number, usedMinor = Math.round(usedCredits)) => [200, usageJSON({ usedMinor, usedCredits, limitMinor: 110000, utilization: 28 })] as [number, string];
    const { t, plugin, http } = await started({ [NOTIFY_RESET_KEY]: true }); // used_credits 30482 on the books
    http.handler = () => at(30482); await run(plugin);                        // unchanged
    http.handler = () => at(30481.7); await run(plugin);                      // 0.3 below: float noise, not a reset
    expect(line(t)).toBe(LIVE);                                               // …and it decoded (the case really reached the threshold logic)
    expect(posts(t, 'Claude credits reset')).toBe(0);
    expect(t.settings.has(LAST_RESET_AT_KEY)).toBe(false);
    http.handler = () => at(30480); await run(plugin);                        // 1.7 below the last reading (30481.7): a real drop
    expect(posts(t, 'Claude credits reset')).toBe(1);
  });

  it('a failed MANUAL run still records the run (so the cadence counts from it); a failed scheduled run does not double-record', async () => {
    const { t, plugin, http } = await started();
    t.lastRuns.delete(JOB_ID);
    http.error = new Error('offline');
    await run(plugin);
    expect(t.lastRuns.has(JOB_ID)).toBe(true);
  });

  // ---------------------------------------------------------------- warm start, hygiene, actions

  it('a stored snapshot shows before the first fetch lands (warm start)', async () => {
    const seed = { [SNAPSHOT_KEY]: fixture('claude-usage-live'), [LAST_FETCH_AT_KEY]: Date.now() / 1000 - 60 };
    const { t, plugin } = setup(seed);
    await plugin.activate(t.context); // no poll yet
    expect(line(t)).toBe(LIVE);
  });

  it('a stored credits-disabled snapshot restores its state on activation', async () => {
    const { t, plugin } = setup({ [SNAPSHOT_KEY]: fixture('claude-usage-credits-disabled'), [LAST_FETCH_AT_KEY]: Date.now() / 1000 - 60 });
    await plugin.activate(t.context);
    expect(line(t)).toBe('Claude credits — usage credits disabled');
  });

  it('a corrupt stored snapshot is "no snapshot", never a crash', async () => {
    const { t, plugin } = setup({ [SNAPSHOT_KEY]: '{not json', [LAST_FETCH_AT_KEY]: 5 });
    await plugin.activate(t.context);
    expect(line(t)).toBe('Claude credits — waiting for first fetch');
    await poll(plugin);
    expect(line(t)).toBe(LIVE);
  });

  it('the session cookie never lands in settings, status, logs, health or notifications', async () => {
    const { t, plugin, http } = await started();
    http.error = new Error('offline');
    await run(plugin);
    const everything = JSON.stringify([...t.settings], null, 0) + JSON.stringify([...t.status]) + JSON.stringify(t.logs) + JSON.stringify(t.health) + JSON.stringify(t.notifications) + JSON.stringify(t.menu) + JSON.stringify([...t.secrets]);
    expect(everything).not.toContain(CANARY_SESSION);
  });

  it('the saved-cookie secret is declared as a secret field (the importer carries it over by name)', () => {
    const fields = settingsSchema.sections.flatMap(s => s.fields);
    expect(fields.find(f => f.type === 'secret')!.key).toBe('sessionCookie');
  });

  it('declares exactly the refresh-now action; perform starts a run; unknown names are no-ops', async () => {
    const { t, plugin } = setup();
    expect(plugin.actions!()).toEqual([{ name: 'refresh-now', title: 'Refresh Claude credits now', summary: 'Fetch the current Claude Desktop/Cowork usage credits', acceptsText: false, agent: true }]);
    await plugin.activate(t.context);
    expect(await plugin.perform!('refresh-now')).toBe('Claude credits refresh started');
    await plugin.currentRun;
    expect(line(t)).toBe(LIVE);
    expect(await plugin.perform!('nope')).toBeUndefined();
  });

  it('a manual run records the run so the cadence counts from it', async () => {
    const { t, plugin } = await started();
    t.lastRuns.delete(JOB_ID);
    await run(plugin);
    expect(t.lastRuns.has(JOB_ID)).toBe(true);
  });

  it('the Refresh Now menu row runs a fetch; Details opens the settings page', async () => {
    const { t, plugin, http } = await started();
    const before = http.calls.length;
    await plugin.onMenuItem!('refresh'); await plugin.currentRun;
    expect(http.calls.length).toBeGreaterThan(before);
    await plugin.onMenuItem!('details');
    expect(t.openDetailRequests).toBe(1);
  });

  it('after a pasted-cookie change the next run uses a fresh client', async () => {
    const { t, plugin, http } = await started();
    await t.context.settings.set('orgUUIDOverride', '99999999-8888-7777-6666-555555555555');
    await run(plugin);
    expect(http.calls.at(-1)!.url).toContain('99999999-8888-7777-6666-555555555555');
  });

});
