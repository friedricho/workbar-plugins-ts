// Ported from MuleSoftChangelogPluginTests: the plugin end to end on the SDK test kit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { schedules, ScheduledJobController, validateSettingsSchema } from '@workbar/sdk';
import {
  createMuleSoftChangelog, historyCutoff, HISTORY_START_KEY, JOB_ID, LEGACY_INTERVAL_KEY, MAX_HISTORY_PAGES_KEY,
  MAX_PRODUCT_PAGES_KEY, RENDERED_FOLDER_KEY, settingsSchema, VAULT_FOLDER_KEY,
} from '../src/index.js';
import { MIGRATIONS } from '../src/store.js';
import { HOME_URL } from '../src/parsers.js';
import { historyPage, homeHTML, indexHTML, openTestDb, para, siteClient } from './support.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mulesoft-p-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ALPHA = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
const BETA = 'https://docs.mulesoft.com/release-notes/connector/beta-release-notes';

/** Three entries on two product pages, plus a home with no product links. */
const servingSite = () => siteClient({
  index: indexHTML([
    ['November 10', [['../connector/alpha-release-notes#1-0-0', 'Alpha Connector 1.0.0'], ['../connector/alpha-release-notes#1-1-0', 'Alpha Connector 1.1.0']]],
    ['November 3', [['../connector/beta-release-notes#2-0-0', 'Beta Connector 2.0.0']]],
  ]),
  home: homeHTML(),
  pages: {
    [ALPHA]: historyPage('Alpha Connector Release Notes', [['1-0-0', '1.0.0', para('Alpha one body.')], ['1-1-0', '1.1.0', para('Alpha one-one body.')]]),
    [BETA]: historyPage('Beta Connector Release Notes', [['2-0-0', '2.0.0', para('Beta two body.')]]),
  },
});

function setup(client = servingSite()) {
  const t: TestContext = createTestContext('mulesoftchangelog');
  const db = openTestDb(MIGRATIONS);
  (t.context.storage as { open: unknown }).open = async () => db;
  const plugin = createMuleSoftChangelog({ client: () => client, pageDelayMs: 0 });
  return { t, plugin, client, db };
}
const vault = (name = 'vault') => path.join(tmp, name);

describe('MuleSoft Changelog plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation registers defaults, opens storage, reports not-configured when unset', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
    expect(t.settings.get(MAX_PRODUCT_PAGES_KEY)).toBe(500);
    expect(t.settings.get(HISTORY_START_KEY)).toBe('2019-01-01'); // the history walk ships on
    expect(t.settings.get(MAX_HISTORY_PAGES_KEY)).toBe(1000);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'Not configured — choose a vault folder in Settings' });
    expect(t.menu).toEqual([
      { kind: 'text', label: 'MuleSoft Changelog not configured' },
      { kind: 'item', id: 'scrape', label: 'Scrape Now' },
      { kind: 'item', id: 'open', label: 'Open Output Folder', enabled: false },
    ]);
    expect(t.jobs.has(JOB_ID)).toBe(false);
    await plugin.deactivate!();
  });

  it('Scrape Now scrapes, stores, writes quarter notes, records the run, reports health', async () => {
    const { t, plugin, db } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    t.lastRuns.set(JOB_ID, new Date(Date.now() - 60_000).toISOString());
    await plugin.activate(t.context);
    await plugin.onMenuItem!('scrape');
    await plugin.currentRun;
    const detail = (t.health.at(-1) as { kind: string; detail?: string });
    expect(detail.kind).toBe('ok');
    expect(detail.detail).toMatch(/^Added 3 entries · 3 total · next run /);
    // The history walk ran with the shipped 2019 default: just the home page.
    expect(detail.detail).toContain('history: 1 pages, 0 entries');
    const note = fs.readFileSync(path.join(vault(), '2026-Q4.md'), 'utf8');
    expect(note.startsWith('# MuleSoft Release Notes — 2026 Q4')).toBe(true);
    for (const text of ['do not edit', '## Alpha Connector 1.0.0', 'Alpha one body.', 'Beta two body.']) expect(note).toContain(text);
    expect(Date.parse(t.lastRuns.get(JOB_ID)!)).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.get('SELECT COUNT(*) AS n FROM entries')).toEqual({ n: 3 });
    expect(t.status.get('entries')).toBe('3 entries');
    await plugin.deactivate!();
  });

  it('changing the vault folder re-renders every note into the new folder', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault('a'));
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(fs.existsSync(path.join(vault('a'), '2026-Q4.md'))).toBe(true);
    expect(t.settings.get(RENDERED_FOLDER_KEY)).toBe(vault('a'));
    await t.context.settings.set(VAULT_FOLDER_KEY, vault('b'));
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(fs.existsSync(path.join(vault('b'), '2026-Q4.md'))).toBe(true);
    expect(t.settings.get(RENDERED_FOLDER_KEY)).toBe(vault('b'));
    expect(t.health.at(-1)).toMatchObject({ kind: 'ok', detail: expect.stringContaining('re-rendered 1 notes') });
    await plugin.deactivate!();
  });

  it('an empty historyStart disables the history walk entirely', async () => {
    const { t, plugin, client } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    t.settings.set(HISTORY_START_KEY, '');
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    const detail = (t.health.at(-1) as { detail?: string }).detail!;
    expect(detail).toContain('Added 3 entries');
    expect(detail).not.toContain('history:');
    expect(client.calls).not.toContain(HOME_URL);
    await plugin.deactivate!();
  });

  it('historyStart: "" disables, a bad value falls back to the shipped default', () => {
    expect(historyCutoff('')).toBeNull();
    expect(historyCutoff('  ')).toBeNull();
    expect(historyCutoff(undefined)).toBe('2019-01-01');
    expect(historyCutoff('2021-06-01')).toBe('2021-06-01');
    expect(historyCutoff('2021-02-30')).toBe('2019-01-01');
    expect(historyCutoff('last year')).toBe('2019-01-01');
  });

  it('a failed run reports warning health and posts one notification', async () => {
    const { t, plugin } = setup(siteClient({ index: '', error: new Error('The Internet connection appears to be offline.') }));
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'docs.mulesoft.com unreachable: The Internet connection appears to be offline.' });
    expect(t.notifications).toEqual([{
      title: 'MuleSoft Changelog couldn’t reach docs.mulesoft.com', subtitle: 'MuleSoft Changelog',
      body: 'docs.mulesoft.com unreachable: The Internet connection appears to be offline.. It will try again at the next scheduled run.',
    }]);
    await plugin.deactivate!();
  });

  it('an HTTP error on the index names the status', async () => {
    const { t, plugin } = setup(siteClient({ index: 'Service Unavailable', indexStatus: 503 }));
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'docs.mulesoft.com returned HTTP 503' });
    expect(t.notifications[0]).toMatchObject({ title: 'MuleSoft Changelog run failed', body: 'docs.mulesoft.com returned HTTP 503. It will try again at the next scheduled run.' });
    await plugin.deactivate!();
  });

  it('a note it cannot write is an error, with a pointer to the vault setting', async () => {
    const { t, plugin } = setup();
    const blocker = path.join(tmp, 'file');
    fs.writeFileSync(blocker, '');
    t.settings.set(VAULT_FOLDER_KEY, path.join(blocker, 'vault'));
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(t.health.at(-1)!.kind).toBe('error');
    expect(t.notifications[0]!.body).toMatch(/Check the vault folder in Settings\.$/);
    await plugin.deactivate!();
  });

  it('perform(scrape-now) starts a run; unknown actions return undefined', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    expect(plugin.actions!().map(a => a.name)).toEqual(['scrape-now']);
    expect(await plugin.perform!('scrape-now')).toBe('MuleSoft release-notes scrape started');
    await plugin.currentRun;
    expect(await plugin.perform!('nope')).toBeUndefined();
    await plugin.deactivate!();
  });

  it('perform(scrape-now) says not-configured instead of pretending', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(await plugin.perform!('scrape-now')).toBe('Not configured — choose a vault folder in Settings');
    await plugin.deactivate!();
  });

  it('a scheduled fire runs through ScheduledJobController', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ schedule: schedules.daily(540) });
    await plugin.onJob!(JOB_ID);
    expect(fs.existsSync(path.join(vault(), '2026-Q4.md'))).toBe(true);
    await plugin.deactivate!();
    expect(t.jobs.size).toBe(0);
  });

  it('after a scheduled run, the host’s re-plan refreshes "next run" in the health line', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    await plugin.onJob!(JOB_ID);
    const next = new Date(2030, 0, 2, 9, 0);
    plugin.onJobNextRun!(JOB_ID, next.toISOString());
    await new Promise(r => setTimeout(r, 0)); // the controller emits after an async lastRunAt
    expect(t.health.at(-1)).toMatchObject({ kind: 'ok', detail: expect.stringContaining('next run Jan 2, 9:00 AM') });
    await plugin.deactivate!();
  });

  it('Open Output Folder opens the vault folder through ctx.shell', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, vault());
    await plugin.activate(t.context);
    await plugin.onMenuItem!('open');
    expect(t.opened).toEqual([{ path: vault(), reveal: false }]);
    await plugin.deactivate!();
  });

  it('legacy intervalHours maps onto a schedule and the old key is removed', async () => {
    for (const [hours, spec] of [[1, schedules.everyNHours(1)], [6, schedules.everyNHours(6)], [12, schedules.everyNHours(12)], [24, schedules.daily(540)], [7, schedules.daily(540)]] as const) {
      const { t, plugin } = setup();
      t.settings.set(LEGACY_INTERVAL_KEY, hours);
      await plugin.activate(t.context);
      expect(t.settings.get(ScheduledJobController.specKey)).toEqual(spec);
      expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
      await plugin.deactivate!();
    }
  });

  it('a fresh install (no legacy key) persists no schedule and keeps the default', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.settings.has(ScheduledJobController.specKey)).toBe(false);
    await plugin.deactivate!();
  });
});
