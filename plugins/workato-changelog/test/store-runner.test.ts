// Ported from ChangelogStoreTests and ScrapeRunnerTests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangelogStore, MIGRATIONS } from '../src/store.js';
import { runScrape } from '../src/runner.js';
import { parse } from '../src/parser.js';
import { fixture, networkError, openTestDb, page, ScriptedClient } from './support.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workato-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const config = (maxPages = 100) => ({ vaultFolder: path.join(tmp, 'vault'), maxPages });
const notes = () => (fs.existsSync(path.join(tmp, 'vault')) ? fs.readdirSync(path.join(tmp, 'vault')).sort() : []);

describe('store', () => {
  it('migration applies at version 1', async () => {
    const db = openTestDb(MIGRATIONS);
    expect(await db.get('PRAGMA user_version')).toEqual({ user_version: 1 });
  });
  it('insert returns only new entries and dedups on re-insert', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    const entries = parse(fixture('changelog-page-1.html'));
    expect(await store.insert(entries)).toHaveLength(10);
    expect(await store.insert(entries)).toEqual([]);
    expect(await store.count()).toBe(10);
  });
  it('quarter query orders newest first, title as tiebreak; fields round-trip', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    const entries = parse(fixture('changelog-page-1.html'));
    await store.insert(entries);
    const q3 = await store.entriesForQuarter('2026-Q3');
    expect(q3.map(e => e.date)).toEqual([...q3.map(e => e.date)].sort().reverse());
    const sep9 = q3.filter(e => e.date === '2026-09-09').map(e => e.title);
    expect(sep9).toEqual([...sep9].sort());
    const original = entries.find(e => e.title === 'On-Prem Agent 33.1')!;
    expect((await store.entriesForQuarter('2026-Q4')).find(e => e.fingerprint === original.fingerprint)).toEqual(original);
  });
  it('quarter keys are distinct, newest first; the backfill flag starts unset', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await store.insert(parse(fixture('changelog-page-1.html')));
    expect(await store.quarterKeys()).toEqual(['2026-Q4', '2026-Q3']);
    expect(await store.isBackfillComplete()).toBe(false);
    await store.markBackfillComplete();
    expect(await store.isBackfillComplete()).toBe(true);
  });
  it('reads a database written by the Swift plugin (same schema, \\/-escaped JSON)', async () => {
    const db = openTestDb(MIGRATIONS);
    db.raw.prepare(`INSERT INTO entries VALUES ('fp', '2026-11-03', '2026-Q4', 'T', '["API\\/SDK","SAP"]', 'Released', 'md', '<p>x</p>', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z')`).run();
    expect((await new ChangelogStore(db).entriesForQuarter('2026-Q4'))[0]!.categories).toEqual(['API/SDK', 'SAP']);
  });
});

describe('scrape runner', () => {
  const pages = [page([['Nov 3, 2026', 'A'], ['Oct 1, 2026', 'B']]), page([['Sep 9, 2026', 'C'], ['Jul 2, 2026', 'D']]), page([['Jan 5, 2026', 'E']])];

  it('backfill paginates to the 404, stores everything, writes touched quarters, marks done', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    const client = new ScriptedClient(n => pages[n - 1] ?? null);
    const s = await runScrape(client, store, config(), { pageDelayMs: 0 });
    expect(s).toEqual({ pagesFetched: 3, entriesNew: 5, entriesTotal: 5, quartersWritten: ['2026-Q1', '2026-Q3', '2026-Q4'], reachedEndOfHistory: true });
    expect(client.requested).toEqual([1, 2, 3, 4]);
    expect(notes()).toEqual(['2026-Q1.md', '2026-Q3.md', '2026-Q4.md']);
    expect(await store.isBackfillComplete()).toBe(true);
  });

  it('an incremental run stops at the first all-known page', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await runScrape(new ScriptedClient(n => pages[n - 1] ?? null), store, config(), { pageDelayMs: 0 });
    const client = new ScriptedClient(n => pages[n - 1] ?? null);
    const s = await runScrape(client, store, config(), { pageDelayMs: 0 });
    expect(client.requested).toEqual([1]);
    expect(s.entriesNew).toBe(0);
    expect(s.quartersWritten).toEqual([]);
  });

  it('a new entry re-renders only its own quarter', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await runScrape(new ScriptedClient(n => pages[n - 1] ?? null), store, config(), { pageDelayMs: 0 });
    const fresh = [page([['Nov 20, 2026', 'New'], ['Nov 3, 2026', 'A']]), ...pages.slice(1)];
    const s = await runScrape(new ScriptedClient(n => fresh[n - 1] ?? null), store, config(), { pageDelayMs: 0 });
    expect(s.quartersWritten).toEqual(['2026-Q4']);
    expect(fs.readFileSync(path.join(tmp, 'vault', '2026-Q4.md'), 'utf8')).toContain('## New');
  });

  it('a failure mid-backfill keeps committed pages and leaves the flag unset', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await expect(runScrape(new ScriptedClient(n => (n === 2 ? networkError() : pages[n - 1] ?? null)), store, config(), { pageDelayMs: 0 })).rejects.toThrow(/unreachable/);
    expect(await store.count()).toBe(2);
    expect(await store.isBackfillComplete()).toBe(false);
  });

  it('a resumed backfill renders quarters committed before the crash', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await expect(runScrape(new ScriptedClient(n => (n === 2 ? networkError() : pages[n - 1] ?? null)), store, config(), { pageDelayMs: 0 })).rejects.toThrow();
    expect(notes()).toEqual([]); // crashed before rendering
    const s = await runScrape(new ScriptedClient(n => pages[n - 1] ?? null), store, config(), { pageDelayMs: 0 });
    expect(s.quartersWritten).toContain('2026-Q4'); // page 1 was already known, still rendered
    expect(notes()).toEqual(['2026-Q1.md', '2026-Q3.md', '2026-Q4.md']);
  });

  it('renderAllQuarters re-renders every stored quarter even when nothing is new', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    await runScrape(new ScriptedClient(n => pages[n - 1] ?? null), store, config(), { pageDelayMs: 0 });
    const other = { vaultFolder: path.join(tmp, 'other'), maxPages: 100 };
    const s = await runScrape(new ScriptedClient(n => pages[n - 1] ?? null), store, other, { pageDelayMs: 0, renderAllQuarters: true });
    expect(s.quartersWritten).toEqual(['2026-Q4', '2026-Q3', '2026-Q1']);
    expect(fs.readdirSync(other.vaultFolder).sort()).toEqual(['2026-Q1.md', '2026-Q3.md', '2026-Q4.md']);
  });

  it('the page cap bounds the walk and leaves the flag unset', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    const client = new ScriptedClient(n => pages[n - 1] ?? null);
    const s = await runScrape(client, store, config(2), { pageDelayMs: 0 });
    expect(client.requested).toEqual([1, 2]);
    expect(s.reachedEndOfHistory).toBe(false);
    expect(await store.isBackfillComplete()).toBe(false);
  });

  it('a 200 page without posts ends the archive', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    const s = await runScrape(new ScriptedClient(n => (n === 1 ? pages[0]! : '<html>no posts</html>')), store, config(), { pageDelayMs: 0 });
    expect(s.reachedEndOfHistory).toBe(true);
    expect(await store.isBackfillComplete()).toBe(true);
  });

  it('a cancelled run stops between pages', async () => {
    const store = new ChangelogStore(openTestDb(MIGRATIONS));
    let cancelled = false;
    const client = new ScriptedClient(n => { cancelled = n >= 2; return pages[n - 1] ?? null; });
    await expect(runScrape(client, store, config(), { pageDelayMs: 0, isCancelled: () => cancelled })).rejects.toThrow('cancelled');
    expect(client.requested).toEqual([1, 2]);
  });
});
