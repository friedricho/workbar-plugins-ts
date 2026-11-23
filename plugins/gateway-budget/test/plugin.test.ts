// Ported from BoomiBudgetPluginTests: the plugin end to end on the SDK test kit.
// The host's never-run catch-up is simulated with onJob (the test kit's
// scheduler plans but never fires).
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { validateSettingsSchema } from '@workbar/sdk';
import {
  createGatewayBudget, JOB_ID, LAST_BANDS_KEY, LAST_FETCH_AT_KEY, NOTIFY_70_KEY, NOTIFY_RESET_KEY, POLL_INTERVAL_KEY,
  settingsSchema, SNAPSHOT_KEY, STATUS_URL_KEY,
} from '../src/index.js';
import { GatewayTokenError } from '../src/gateway.js';
import { CANARY, fakeHttp, fixture, MockTokenProvider, payload } from './support.js';

function setup(http = fakeHttp(), tokens = new MockTokenProvider()) {
  const t: TestContext = createTestContext('boomibudget');
  (t.context as { http: unknown }).http = http;
  const plugin = createGatewayBudget({ tokenProvider: () => tokens });
  return { t, plugin, http, tokens };
}
const labels = (t: TestContext) => t.menu.map(m => (m as { label: string }).label);
const poll = async (plugin: ReturnType<typeof createGatewayBudget>) => { await plugin.onJob!(JOB_ID); };
const titles = (t: TestContext, title: string) => t.notifications.filter(n => n.title === title).length;

describe('AI Gateway Budget plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation arms the poll; the catch-up fetch shows one line per window', async () => {
    const { t, plugin, http } = setup();
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ intervalSeconds: 60 });
    expect(labels(t)[0]).toBe('Gateway budget — waiting for first fetch');
    await poll(plugin);
    expect(http.calls[0]!.headers.authorization).toBe(`Bearer ${CANARY}`);
    expect(t.menu).toHaveLength(3);
    expect(labels(t)[0]).toMatch(/^30d: \$109\.87\/\$900\.00 \(12%\), resets in /);
    expect(t.menu.slice(1)).toEqual([{ kind: 'item', id: 'refresh', label: 'Refresh Now' }, { kind: 'item', id: 'details', label: 'Open Budget Details…' }]);
    expect(t.settings.has(SNAPSHOT_KEY)).toBe(true);
    expect(t.settings.has(LAST_FETCH_AT_KEY)).toBe(true);
    expect(t.health.at(-1)).toMatchObject({ kind: 'ok', detail: expect.stringMatching(/^30d: \$109\.87/) });
    await plugin.deactivate!();
  });

  it('deactivate cancels the job and drops an in-flight result; the menu stays as it was', async () => {
    const { t, plugin } = setup(fakeHttp({ delayMs: 200 }));
    await plugin.activate(t.context);
    void plugin.perform!('refresh-now');
    const run = plugin.currentRun;
    await plugin.deactivate!();
    await run;
    expect(t.jobs.has(JOB_ID)).toBe(false);
    expect(t.settings.has(SNAPSHOT_KEY)).toBe(false);
  });

  it('offline keeps the snapshot on display, marks it stale, posts once per outage', async () => {
    const { t, plugin, http } = setup();
    await plugin.activate(t.context);
    await poll(plugin);
    http.error = new Error('The Internet connection appears to be offline.');
    await poll(plugin);
    await poll(plugin);
    expect(labels(t)[0]).toMatch(/^⚠ 30d: \$109\.87\/\$900\.00 \(12%\), resets in /);
    expect(t.health.at(-1)).toMatchObject({ kind: 'warning', detail: expect.stringMatching(/^Offline — showing data from /) });
    expect(titles(t, 'Gateway budget couldn’t refresh')).toBe(1);
    http.error = undefined;
    await poll(plugin);
    expect(labels(t)[0]).toMatch(/^30d: \$/);
    http.error = new Error('offline again');
    await poll(plugin);
    expect(titles(t, 'Gateway budget couldn’t refresh')).toBe(2); // a new outage
    await plugin.deactivate!();
  });

  it('an auth failure shows the sign-in line and an error, never a silent $0', async () => {
    const tokens = new MockTokenProvider();
    tokens.error = new GatewayTokenError('helperUnavailable', '/usr/local/boomi/bin/claude-code-helper');
    const { t, plugin, http } = setup(fakeHttp(), tokens);
    await plugin.activate(t.context);
    await poll(plugin);
    const h = t.health.at(-1) as { kind: string; detail: string };
    expect(h.kind).toBe('error');
    expect(h.detail).toContain('couldn’t get a gateway token');
    expect(h.detail).toContain('CorporateAIClientProvisioning');
    expect(labels(t)[0]).toBe('Gateway budget — sign in via CorporateAIClientProvisioning');
    expect(t.notifications).toEqual([]);
    expect(http.calls).toEqual([]);
    await plugin.deactivate!();
  });

  it('band crossings notify once per window; repeats and first sightings don’t', async () => {
    const http = fakeHttp({ handler: () => [200, payload(108, 12)] });
    const { t, plugin } = setup(http);
    await plugin.activate(t.context);
    await poll(plugin);
    expect(t.notifications).toEqual([]);
    http.handler = () => [200, payload(675, 75)];
    await poll(plugin);
    expect(titles(t, 'Gateway budget over 70%')).toBe(1);
    await poll(plugin);
    expect(titles(t, 'Gateway budget over 70%')).toBe(1);
    http.handler = () => [200, payload(855, 95)];
    await poll(plugin);
    expect(titles(t, 'Gateway budget over 90%')).toBe(1);
    expect(JSON.parse(t.settings.get(LAST_BANDS_KEY) as string)).toEqual({ '30d': 2 });
    await plugin.deactivate!();
  });

  it('the 70% toggle silences the early warning; 90% stays on', async () => {
    const http = fakeHttp({ handler: () => [200, payload(108, 12)] });
    const { t, plugin } = setup(http);
    t.settings.set(NOTIFY_70_KEY, false);
    await plugin.activate(t.context);
    await poll(plugin);
    http.handler = () => [200, payload(675, 75)];
    await poll(plugin);
    expect(titles(t, 'Gateway budget over 70%')).toBe(0);
    http.handler = () => [200, payload(855, 95)];
    await poll(plugin);
    expect(titles(t, 'Gateway budget over 90%')).toBe(1);
    await plugin.deactivate!();
  });

  it('a spend drop (window reset) notifies only when the toggle is on', async () => {
    for (const on of [false, true]) {
      const http = fakeHttp({ handler: () => [200, payload(500, 55)] });
      const { t, plugin } = setup(http);
      if (on) t.settings.set(NOTIFY_RESET_KEY, true);
      await plugin.activate(t.context);
      await poll(plugin);
      http.handler = () => [200, payload(3, 0.3)];
      await poll(plugin);
      expect(titles(t, 'Gateway budget window reset')).toBe(on ? 1 : 0);
      if (on) expect(t.notifications.find(n => n.title === 'Gateway budget window reset')!.body).toBe('30d window reset — now $3.00 of $900.00');
      await plugin.deactivate!();
    }
  });

  it('the poll interval setting re-arms the job live', async () => {
    const { t, plugin } = setup();
    t.settings.set(POLL_INTERVAL_KEY, 300);
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ intervalSeconds: 300 });
    await t.context.settings.set(POLL_INTERVAL_KEY, 30);
    await new Promise(r => setTimeout(r, 10));
    expect(t.jobs.get(JOB_ID)).toEqual({ intervalSeconds: 30 });
    await plugin.deactivate!();
  });

  it('a /v1 status-URL override is normalized to the status route', async () => {
    const { t, plugin, http } = setup();
    t.settings.set(STATUS_URL_KEY, 'https://gw.example.com/v1');
    await plugin.activate(t.context);
    await poll(plugin);
    expect(http.calls[0]!.url).toBe('https://gw.example.com/boomi/budget/status');
    await plugin.deactivate!();
  });

  it('a stored snapshot shows before the first fetch lands (warm start)', async () => {
    const { t, plugin } = setup(fakeHttp({ delayMs: 500 }));
    t.settings.set(SNAPSHOT_KEY, fixture('budget-status-live').replace('2026-12-01T00:00:00+00:00', new Date(Date.now() + 5 * 86_400_000).toISOString()));
    t.settings.set(LAST_FETCH_AT_KEY, Date.now() / 1000 - 60);
    await plugin.activate(t.context);
    expect(labels(t)[0]).toMatch(/^30d: \$109\.87\/\$900\.00 \(12%\), resets in /);
    await plugin.deactivate!();
  });

  it('a corrupt snapshot is ignored, never a crash', async () => {
    const { t, plugin } = setup();
    t.settings.set(SNAPSHOT_KEY, '{nope');
    t.settings.set(LAST_FETCH_AT_KEY, 1);
    await plugin.activate(t.context);
    expect(labels(t)[0]).toBe('Gateway budget — waiting for first fetch');
    await plugin.deactivate!();
  });

  it('the token never lands in settings', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    await poll(plugin);
    expect(JSON.stringify(Object.fromEntries(t.settings))).not.toContain(CANARY);
    expect(JSON.stringify(t.logs)).not.toContain(CANARY);
    await plugin.deactivate!();
  });

  it('a manual refresh records the run and re-plans; Open Budget Details opens the page', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(await plugin.perform!('refresh-now')).toBe('Gateway budget refresh started');
    await plugin.currentRun;
    expect(t.lastRuns.has(JOB_ID)).toBe(true);
    await plugin.onMenuItem!('details');
    expect(t.openDetailRequests).toBe(1);
    expect(await plugin.perform!('nope')).toBeUndefined();
    await plugin.deactivate!();
  });

  it('actions() declares exactly the refresh-now action', () => {
    expect(createGatewayBudget().actions!()).toEqual([{ name: 'refresh-now', title: 'Refresh gateway budget now', summary: 'Fetch the current Boomi AI gateway budget counters', acceptsText: false }]);
  });
});
