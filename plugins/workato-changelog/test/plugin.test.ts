// Ported from WorkatoChangelogPluginTests: the plugin end to end on the SDK test kit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { schedules, ScheduledJobController } from '@workbar/sdk';
import { createWorkatoChangelog, JOB_ID, LEGACY_INTERVAL_KEY, RENDERED_FOLDER_KEY, VAULT_FOLDER_KEY, settingsSchema } from '../src/index.js';
import { MIGRATIONS } from '../src/store.js';
import { networkError, openTestDb, page, ScriptedClient } from './support.js';
import { validateSettingsSchema } from '@workbar/sdk';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workato-p-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pages = [page([['Nov 3, 2026', 'A'], ['Oct 1, 2026', 'B']]), page([['Sep 9, 2026', 'C']])];

function setup(script: (n: number) => string | null | Error = n => pages[n - 1] ?? null) {
  const t: TestContext = createTestContext('workatochangelog');
  const db = openTestDb(MIGRATIONS);
  (t.context.storage as { open: unknown }).open = async () => db;
  const client = new ScriptedClient(script);
  const plugin = createWorkatoChangelog({ client: () => client, pageDelayMs: 0 });
  return { t, plugin, client };
}

describe('Workato Changelog plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation registers defaults and reports not-configured when no vault is set', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.settings.get('maxPages')).toBe(100);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'Not configured — choose a vault folder in Settings' });
    expect(t.jobs.has(JOB_ID)).toBe(false);
    expect(t.menu[0]).toEqual({ kind: 'text', label: 'Workato Changelog not configured' });
  });

  it('Scrape Now scrapes, stores, writes notes, records the run and reports health', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await plugin.activate(t.context);
    await plugin.onMenuItem!('scrape');
    await plugin.currentRun;
    expect(fs.readdirSync(path.join(tmp, 'vault')).sort()).toEqual(['2026-Q3.md', '2026-Q4.md']);
    expect(t.lastRuns.has(JOB_ID)).toBe(true);
    expect(t.health.at(-1)).toMatchObject({ kind: 'ok', detail: expect.stringMatching(/^Added 3 entries · 3 total · next run /) });
    expect(t.settings.get(RENDERED_FOLDER_KEY)).toBe(path.join(tmp, 'vault'));
    expect(t.status.get('entries')).toBe('3 entries');
  });

  it('changing the vault folder re-renders every note into the new folder', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    await t.context.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'moved'));
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(fs.readdirSync(path.join(tmp, 'moved')).sort()).toEqual(['2026-Q3.md', '2026-Q4.md']);
    expect(t.health.at(-1)!).toMatchObject({ detail: expect.stringContaining('re-rendered 2 notes') });
  });

  it('a failed run reports warning health and posts one notification', async () => {
    const { t, plugin } = setup(() => networkError());
    t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await plugin.activate(t.context);
    await plugin.perform!('scrape-now');
    await plugin.currentRun;
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'Workato unreachable: getaddrinfo ENOTFOUND www.workato.com' });
    expect(t.notifications).toEqual([{ title: 'Workato Changelog couldn’t reach workato.com', subtitle: 'Workato Changelog', body: 'Workato unreachable: getaddrinfo ENOTFOUND www.workato.com. It will try again at the next scheduled run.' }]);
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
  });

  it('perform(scrape-now) starts a run; unknown actions return undefined; not-configured is honest', async () => {
    const configured = setup();
    configured.t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await configured.plugin.activate(configured.t.context);
    expect(await configured.plugin.perform!('scrape-now')).toBe('Workato changelog scrape started');
    expect(await configured.plugin.perform!('dance')).toBeUndefined();
    await configured.plugin.currentRun;
    const bare = setup();
    await bare.plugin.activate(bare.t.context);
    expect(await bare.plugin.perform!('scrape-now')).toBe('Not configured — choose a vault folder in Settings');
  });

  it('a scheduled fire runs through ScheduledJobController', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await plugin.activate(t.context);
    expect(t.jobs.get(JOB_ID)).toEqual({ schedule: schedules.daily(540) });
    await plugin.onJob!(JOB_ID);
    expect(fs.readdirSync(path.join(tmp, 'vault'))).toHaveLength(2);
  });

  it('Open Output Folder opens the vault folder through ctx.shell', async () => {
    const { t, plugin } = setup();
    t.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await plugin.activate(t.context);
    await plugin.onMenuItem!('open');
    expect(t.opened).toEqual([{ path: path.join(tmp, 'vault'), reveal: false }]);
  });

  it('legacy intervalHours maps onto a schedule and the old key is removed', async () => {
    for (const [hours, spec] of [[6, schedules.everyNHours(6)], [24, schedules.daily(540)]] as const) {
      const { t, plugin } = setup();
      t.settings.set(LEGACY_INTERVAL_KEY, hours);
      await plugin.activate(t.context);
      expect(t.settings.get(ScheduledJobController.specKey)).toEqual(spec);
      expect(t.settings.has(LEGACY_INTERVAL_KEY)).toBe(false);
    }
  });

  it('a fresh install (no legacy key) persists no schedule and keeps the default', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.settings.has(ScheduledJobController.specKey)).toBe(false);
  });

  it('setting the vault folder in Settings arms the job', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    await t.context.settings.set(VAULT_FOLDER_KEY, path.join(tmp, 'vault'));
    await new Promise(r => setTimeout(r, 10));
    expect(t.jobs.has(JOB_ID)).toBe(true);
    expect((t.menu[2] as { enabled?: boolean }).enabled).not.toBe(false);
  });
});
