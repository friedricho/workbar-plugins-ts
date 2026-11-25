// Ported from PendoFeedbackPluginTests: the plugin end to end on the SDK test kit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { schedules, ScheduledJobController, validateSettingsSchema } from '@workbar/sdk';
import {
  createPendoFeedback, GUIDE_ID_KEY, HOST_SECRET_NAME_KEY, JOB_ID, LEGACY_DAYS_BACK_KEY, LEGACY_INTERVAL_KEY, LEGACY_LAST_RUN_KEY,
  NOT_CONFIGURED, OUTPUT_PATH_KEY, REGION_KEY, settingsSchema,
} from '../src/index.js';
import { PendoClient } from '../src/client.js';
import { MIGRATIONS } from '../src/store.js';
import { fakeHttp, openTestDb, servingHttp } from './support.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pendo-p-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CANARY = 'canary-integration-key';
const report = () => path.join(tmp, 'Pendo Feedback.md');

function setup(o: { http?: ReturnType<typeof fakeHttp>; secrets?: Record<string, string>; configured?: boolean; lastRunAgoMs?: number | null } = {}) {
  const t: TestContext = createTestContext('pendofeedback', { hostSecrets: o.secrets ?? { pendo: CANARY } });
  const db = openTestDb(MIGRATIONS);
  (t.context.storage as { open: unknown }).open = async () => db;
  if (o.configured !== false) {
    t.settings.set(GUIDE_ID_KEY, 'g1');
    t.settings.set(REGION_KEY, 'us');
    t.settings.set(OUTPUT_PATH_KEY, report());
  }
  // A recent last run, so the fresh job doesn't fire at activation.
  const ago = o.lastRunAgoMs === undefined ? 60_000 : o.lastRunAgoMs;
  if (ago !== null) t.lastRuns.set(JOB_ID, new Date(Date.now() - ago).toISOString());
  const http = o.http ?? servingHttp();
  const plugin = createPendoFeedback({ client: () => new PendoClient(http) });
  return { t, plugin, http, db };
}
const menuTitle = (t: TestContext) => (t.menu[0] as { label: string }).label;

describe('Pendo Feedback plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation registers defaults, clears legacy keys and reports not-configured when unset', async () => {
    const { t, plugin } = setup({ configured: false });
    t.settings.set(LEGACY_DAYS_BACK_KEY, 7);
    await plugin.activate(t.context);
    expect(t.settings.get(REGION_KEY)).toBe('us');
    expect(t.settings.get(HOST_SECRET_NAME_KEY)).toBe('pendo');
    expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
    expect(t.settings.has(LEGACY_DAYS_BACK_KEY)).toBe(false);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: NOT_CONFIGURED });
    expect(t.menu).toEqual([{ kind: 'text', label: 'Pendo Feedback not configured' }, { kind: 'item', id: 'run', label: 'Update Report Now' }]);
    await plugin.deactivate!();
  });

  it('reads the shared "pendo" host secret by default; without it the plugin is not configured', async () => {
    const without = setup({ secrets: {} });
    await without.plugin.activate(without.t.context);
    expect(without.t.health.at(-1)).toEqual({ kind: 'ok', detail: NOT_CONFIGURED });
    expect(menuTitle(without.t)).toBe('Pendo Feedback not configured');
    await without.plugin.deactivate!();
    const withKey = setup();
    await withKey.plugin.activate(withKey.t.context);
    expect(menuTitle(withKey.t)).toContain('Last run');
    await withKey.plugin.deactivate!();
  });

  it('uses the chosen host secret name; "None" or a deleted name disarm', async () => {
    const { t, plugin } = setup({ secrets: { 'Pendo API': CANARY } });
    t.settings.set(HOST_SECRET_NAME_KEY, 'Pendo API');
    await plugin.activate(t.context);
    expect(menuTitle(t)).toContain('Last run');
    expect(plugin.hostSecretUsage!()).toEqual(['Pendo API']);
    await t.context.settings.set(HOST_SECRET_NAME_KEY, '');
    await new Promise(r => setTimeout(r, 10));
    expect(menuTitle(t)).toBe('Pendo Feedback not configured');
    expect(plugin.hostSecretUsage!()).toEqual([]);
    await t.context.settings.set(HOST_SECRET_NAME_KEY, 'deleted-name');
    await new Promise(r => setTimeout(r, 10));
    expect(menuTitle(t)).toBe('Pendo Feedback not configured');
    await plugin.deactivate!();
  });

  it('Update Report Now fetches, writes the report, stores responses, records the run, reports health', async () => {
    const { t, plugin, db } = setup();
    await plugin.activate(t.context);
    await plugin.onMenuItem!('run');
    await plugin.currentRun;
    const h = t.health.at(-1) as { kind: string; detail: string };
    expect(h.kind).toBe('ok');
    expect(h.detail).toMatch(/^Report updated — 1 response\(s\) · next run /);
    const text = fs.readFileSync(report(), 'utf8');
    expect(text).toContain('# Pendo Feedback — Autopilot Early Access Guide');
    expect(text).toContain('Very useful');
    expect(Date.parse(t.lastRuns.get(JOB_ID)!)).toBeGreaterThan(Date.now() - 10_000);
    expect(menuTitle(t)).toContain('Last run');
    expect(await db.all('SELECT poll_id, poll_response, response_text, visitor_id, account_id, browser_time FROM responses')).toEqual([{
      poll_id: 'p1', poll_response: 'c1', response_text: 'Very useful', visitor_id: 'visitor-abc', account_id: 'acct-1', browser_time: '2026-11-11T09:14:00Z',
    }]);
    expect(await db.get('SELECT COUNT(*) AS n FROM polls WHERE guide_id = ?', ['g1'])).toEqual({ n: 1 });
    expect(t.status.get('responses')).toBe('1 stored');
    await plugin.onMenuItem!('run');
    await plugin.currentRun;
    expect(await db.get('SELECT COUNT(*) AS n FROM responses')).toEqual({ n: 1 }); // all-time refetch dedups
    await plugin.deactivate!();
  });

  it('401 turns health red, posts one notification and never leaks the key', async () => {
    const { t, plugin } = setup({ http: fakeHttp({ handler: () => [401, '{"error": "denied"}'] }) });
    await plugin.activate(t.context);
    await plugin.perform!('run-now');
    await plugin.currentRun;
    expect(t.health.at(-1)).toEqual({ kind: 'error', detail: 'Pendo rejected the API key — check the key and its permissions' });
    expect(t.notifications).toHaveLength(1);
    expect(JSON.stringify([t.health, t.notifications, t.logs])).not.toContain(CANARY);
    expect(t.lastRuns.has(JOB_ID)).toBe(true);
    await plugin.deactivate!();
  });

  it('the key is sent to Pendo but never lands in settings', async () => {
    const { t, plugin, http } = setup();
    await plugin.activate(t.context);
    await plugin.perform!('run-now');
    await plugin.currentRun;
    expect(http.calls.every(c => c.headers['x-pendo-integration-key'] === CANARY)).toBe(true);
    expect(JSON.stringify(Object.fromEntries(t.settings))).not.toContain(CANARY);
    await plugin.deactivate!();
  });

  it.each([
    ['guide not found', [404, '{}'], 'warning', 'Guide g1 not found — check the guide ID', 1],
    ['rate limited (no notification)', [429, '[]'], 'warning', 'Pendo rate-limited the request — retrying next run', 0],
    ['HTTP error', [502, ''], 'warning', 'Pendo returned HTTP 502', 1],
  ] as const)('a failed run: %s', async (_name, [status, body], kind, detail, notes) => {
    const { t, plugin } = setup({ http: fakeHttp({ handler: () => [status, body] }) });
    await plugin.activate(t.context);
    await plugin.perform!('run-now');
    await plugin.currentRun;
    expect(t.health.at(-1)).toEqual({ kind, detail });
    expect(t.notifications).toHaveLength(notes);
    await plugin.deactivate!();
  });

  it('a report it cannot write is an error that points at the output setting', async () => {
    const { t, plugin } = setup();
    fs.writeFileSync(path.join(tmp, 'file'), '');
    t.settings.set(OUTPUT_PATH_KEY, path.join(tmp, 'file', 'report.md'));
    await plugin.activate(t.context);
    await plugin.perform!('run-now');
    await plugin.currentRun;
    expect(t.health.at(-1)!.kind).toBe('error');
    expect(t.notifications[0]!.body).toMatch(/Check the output file location in Settings\.$/);
    await plugin.deactivate!();
  });

  it('a database failure after the report is written is a warning, not an error', async () => {
    const { t, plugin, db } = setup();
    await plugin.activate(t.context);
    db.raw.exec('DROP TABLE responses');
    await plugin.perform!('run-now');
    await plugin.currentRun;
    expect(fs.existsSync(report())).toBe(true);
    expect(t.health.at(-1)).toMatchObject({ kind: 'warning', detail: expect.stringMatching(/^Report updated, but the response database wasn’t: /) });
    await plugin.deactivate!();
  });

  it('actions() declares exactly the run-now action', () => {
    expect(createPendoFeedback().actions!()).toEqual([{ name: 'run-now', title: 'Update report now', summary: 'Fetch Pendo feedback and rewrite the report', acceptsText: false, agent: true }]);
  });

  it('an unconfigured perform reports not-configured and starts nothing', async () => {
    const { t, plugin } = setup({ configured: false });
    await plugin.activate(t.context);
    expect(await plugin.perform!('run-now')).toBe(NOT_CONFIGURED);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: NOT_CONFIGURED });
    expect(plugin.currentRun).toBeNull();
    expect(await plugin.perform!('nope')).toBeUndefined();
    await plugin.deactivate!();
  });

  it('a configured perform starts a real run and returns the started line', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(await plugin.perform!('run-now')).toBe('Pendo report run started');
    await plugin.currentRun;
    expect(fs.readFileSync(report(), 'utf8')).toContain('Very useful');
    await plugin.deactivate!();
  });

  it('a scheduled fire runs through ScheduledJobController; a re-plan refreshes "next run"', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ schedule: schedules.daily(540) });
    await plugin.onJob!(JOB_ID);
    expect(fs.existsSync(report())).toBe(true);
    plugin.onJobNextRun!(JOB_ID, new Date(2030, 0, 2, 9, 0).toISOString());
    await new Promise(r => setTimeout(r, 0));
    expect(t.health.at(-1)).toMatchObject({ kind: 'ok', detail: expect.stringContaining('next run Jan 2, 9:00 AM') });
    await plugin.deactivate!();
  });

  it('clearing the guide ID disarms and says so', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.jobs.has(JOB_ID)).toBe(true);
    await t.context.settings.set(GUIDE_ID_KEY, '');
    await new Promise(r => setTimeout(r, 10));
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: NOT_CONFIGURED });
    expect(menuTitle(t)).toBe('Pendo Feedback not configured');
    expect(t.jobs.has(JOB_ID)).toBe(false);
    await plugin.deactivate!();
  });

  it('a legacy lastRunAt moves to the host scheduler once; the settings key is removed', async () => {
    const { t, plugin } = setup({ lastRunAgoMs: null });
    const anchor = Math.floor(Date.now() / 1000) - 60;
    t.settings.set(LEGACY_LAST_RUN_KEY, anchor);
    await plugin.activate(t.context);
    expect(t.settings.has(LEGACY_LAST_RUN_KEY)).toBe(false);
    expect(t.lastRuns.get(JOB_ID)).toBe(new Date(anchor * 1000).toISOString());
    expect(t.jobs.has(JOB_ID)).toBe(true);
    // A later re-arm keeps the scheduler's own anchor.
    await t.context.settings.set(REGION_KEY, 'eu');
    await new Promise(r => setTimeout(r, 10));
    expect(t.lastRuns.get(JOB_ID)).toBe(new Date(anchor * 1000).toISOString());
    await plugin.deactivate!();
  });

  it('deactivate cancels the job and an in-flight run writes nothing', async () => {
    const { t, plugin } = setup({ http: (() => { const h = servingHttp(); const f = h.fetch; h.fetch = async (u, i) => { await new Promise(r => setTimeout(r, 50)); return f(u, i); }; return h; })() });
    await plugin.activate(t.context);
    void plugin.perform!('run-now');
    await new Promise(r => setTimeout(r, 5));
    const run = plugin.currentRun;
    await plugin.deactivate!();
    await run;
    expect(t.jobs.has(JOB_ID)).toBe(false);
    expect(fs.existsSync(report())).toBe(false);
  });

  it('legacy intervalHours maps onto a schedule and the old key is removed', async () => {
    for (const [hours, spec] of [[1, schedules.everyNHours(1)], [6, schedules.everyNHours(6)], [12, schedules.everyNHours(12)], [24, schedules.daily(540)], [7, schedules.daily(540)]] as const) {
      const { t, plugin } = setup({ configured: false });
      t.settings.set(LEGACY_INTERVAL_KEY, hours);
      await plugin.activate(t.context);
      expect(t.settings.get(ScheduledJobController.specKey)).toEqual(spec);
      expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
      await plugin.deactivate!();
    }
  });

  it('a fresh install (no legacy key) persists no schedule and keeps the default', async () => {
    const { t, plugin } = setup({ configured: false });
    await plugin.activate(t.context);
    expect(t.settings.has(ScheduledJobController.specKey)).toBe(false);
    await plugin.deactivate!();
  });

  it('hostSecretUsage: the default name before activation, the chosen name after', async () => {
    expect(createPendoFeedback().hostSecretUsage!()).toEqual(['pendo']);
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(plugin.hostSecretUsage!()).toEqual(['pendo']);
    await plugin.deactivate!();
  });
});
