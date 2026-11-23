// Ported from ChangelogStoreTests and ScrapeRunnerTests: real SQLite, a fake
// site behind the real client, real note writes into a temp vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangelogStore, MIGRATIONS } from '../src/store.js';
import { runScrape, type RunOptions } from '../src/runner.js';
import { HOME_URL, INDEX_URL } from '../src/parsers.js';
import { MuleSoftClientError } from '../src/client.js';
import type { MuleSoftConfig } from '../src/model.js';
import { historyPage, homeHTML, indexHTML, makeEntry, openTestDb, para, productPage, siteClient } from './support.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mulesoft-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const newStore = () => new ChangelogStore(openTestDb(MIGRATIONS));
const vault = (name = 'vault') => path.join(tmp, name);
const note = (q: string, name = 'vault') => fs.readFileSync(path.join(vault(name), `${q}.md`), 'utf8');
const config = (o: Partial<MuleSoftConfig> = {}): MuleSoftConfig => ({ vaultFolder: vault(), maxProductPages: 500, ...o });
const HISTORY = { historyStart: '2019-01-01' } as const;
const fixedNow = new Date(1_763_000_000_000);
const run = (client: Parameters<typeof runScrape>[0], store: ChangelogStore, c: MuleSoftConfig, o: RunOptions = {}) =>
  runScrape(client, store, c, { now: fixedNow, pageDelayMs: 0, ...o });

describe('store', () => {
  it('migration applies at version 1', async () => {
    expect(await openTestDb(MIGRATIONS).get('PRAGMA user_version')).toEqual({ user_version: 1 });
  });
  it('insert returns only the new entries and dedups on re-insert', async () => {
    const store = newStore();
    const a = makeEntry({ title: 'Connector A 1.0.0' });
    const b = makeEntry({ title: 'Connector B 2.0.0', date: '2026-10-01' });
    expect(await store.insert([a, b])).toEqual([a, b]);
    expect(await store.count()).toBe(2);
    const c = makeEntry({ title: 'Connector C 3.0.0', date: '2026-09-01' });
    expect(await store.insert([a, c])).toEqual([c]);
    expect(await store.count()).toBe(3);
  });
  it('knownFingerprints batches the dedup filter', async () => {
    const store = newStore();
    expect(await store.knownFingerprints([])).toEqual(new Set());
    const a = makeEntry({ title: 'Connector A 1.0.0' });
    await store.insert([a]);
    expect(await store.knownFingerprints([a.fingerprint, 'not-stored', 'also-not'])).toEqual(new Set([a.fingerprint]));
    const many = Array.from({ length: 1200 }, (_, i) => `fp-${i}`);
    expect((await store.knownFingerprints([...many, a.fingerprint])).size).toBe(1); // > 500: chunked
  });
  it('quarter query orders newest first, title as tiebreak', async () => {
    const store = newStore();
    await store.insert([
      makeEntry({ title: 'Older 1.0.0', date: '2026-10-01' }),
      makeEntry({ title: 'Beta 1.0.0', date: '2026-11-03' }),
      makeEntry({ title: 'Alpha 1.0.0', date: '2026-11-03' }),
      makeEntry({ title: 'Other 1.0.0', date: '2026-09-01' }),
    ]);
    expect((await store.entriesForQuarter('2026-Q4')).map(e => e.title)).toEqual(['Alpha 1.0.0', 'Beta 1.0.0', 'Older 1.0.0']);
    expect((await store.entriesForQuarter('2026-Q3')).map(e => e.title)).toEqual(['Other 1.0.0']);
  });
  it('product, URL, anchor and bodies round-trip', async () => {
    const store = newStore();
    const entry = makeEntry({
      title: 'EDIFACT EDI Connector 3.0.1', pageURL: 'https://docs.mulesoft.com/release-notes/connector/edifact-edi-connector-release-notes',
      anchor: '3-0-1', bodyMarkdown: 'Some **markdown** [link](https://x.test)', bodyHTML: '<p>Some <b>markdown</b></p>',
    });
    await store.insert([entry]);
    const read = await store.entriesForQuarter('2026-Q4');
    expect(read).toEqual([entry]);
    expect(read[0]!.product).toBe('EDIFACT EDI Connector');
  });
  it('quarterKeys returns distinct quarters newest first', async () => {
    const store = newStore();
    expect(await store.quarterKeys()).toEqual([]);
    await store.insert([makeEntry({ title: 'A 1.0.0' }), makeEntry({ title: 'B 1.0.0' }), makeEntry({ title: 'C 1.0.0', date: '2025-09-02' })]);
    expect(await store.quarterKeys()).toEqual(['2026-Q4', '2025-Q3']);
  });
  it('the backfill flag round-trips, starts unset and survives a reopen', async () => {
    const file = path.join(tmp, 'm.sqlite');
    const db = openTestDb(MIGRATIONS, file);
    const store = new ChangelogStore(db);
    expect(await store.isBackfillComplete()).toBe(false);
    await store.markBackfillComplete();
    expect(await store.isBackfillComplete()).toBe(true);
    await db.close();
    const reopened = openTestDb(MIGRATIONS, file);
    expect(await new ChangelogStore(reopened).isBackfillComplete()).toBe(true);
    await reopened.close();
  });
  it('existingAnchors returns the page’s stored anchors only', async () => {
    const store = newStore();
    const page = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
    await store.insert([
      makeEntry({ title: 'Alpha 1.0.0', pageURL: page, anchor: '1-0-0' }),
      makeEntry({ title: 'Alpha 1.1.0', pageURL: page, anchor: '1-1-0' }),
      makeEntry({ title: 'Beta 2.0.0' }),
    ]);
    expect(await store.existingAnchors(page)).toEqual(new Set(['1-0-0', '1-1-0']));
    expect(await store.existingAnchors('https://docs.mulesoft.com/release-notes/nope')).toEqual(new Set());
  });
  it('hasWholePageEntry is true only for a stored empty-anchor entry', async () => {
    const store = newStore();
    const dedicated = 'https://docs.mulesoft.com/release-notes/mule-maven-plugin/mule-maven-plugin-4-10-4-release-notes';
    const anchored = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
    expect(await store.hasWholePageEntry(dedicated)).toBe(false);
    await store.insert([
      makeEntry({ title: 'Mule Maven Plugin 4.10.4', pageURL: dedicated, anchor: '' }),
      makeEntry({ title: 'Alpha 1.0.0', pageURL: anchored, anchor: '1-0-0' }),
    ]);
    expect(await store.hasWholePageEntry(dedicated)).toBe(true);
    expect(await store.hasWholePageEntry(anchored)).toBe(false);
  });
  it('productForPage returns the most common stored product', async () => {
    const store = newStore();
    const page = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
    await store.insert([
      makeEntry({ title: 'Alpha Connector 1.0.0', pageURL: page, anchor: '1-0-0' }),
      makeEntry({ title: 'Alpha Connector 1.1.0', pageURL: page, anchor: '1-1-0' }),
      makeEntry({ title: 'Alpha Connector — July 2026', product: 'Alpha Connector', pageURL: page, anchor: 'july-2026' }),
    ]);
    expect(await store.productForPage(page)).toBe('Alpha Connector');
    expect(await store.productForPage('https://docs.mulesoft.com/release-notes/nope')).toBeNull();
  });
  it('knownPageURLs returns distinct stored pages sorted', async () => {
    const store = newStore();
    expect(await store.knownPageURLs()).toEqual([]);
    const b = 'https://docs.mulesoft.com/release-notes/connector/beta-release-notes';
    const a = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
    await store.insert([
      makeEntry({ title: 'Beta 1.0.0', pageURL: b, anchor: '1-0-0' }),
      makeEntry({ title: 'Beta 1.1.0', pageURL: b, anchor: '1-1-0' }),
      makeEntry({ title: 'Alpha 1.0.0', pageURL: a, anchor: '1-0-0' }),
    ]);
    expect(await store.knownPageURLs()).toEqual([a, b]);
  });
  it('history walk markers: absent or a different cutoff needs a walk', async () => {
    const store = newStore();
    const candidates = ['p1', 'p2', 'p3'];
    expect(await store.historyPagesNeedingWalk(candidates, '2019-01-01')).toEqual(candidates);
    await store.markHistoryWalked('p1', '2019-01-01');
    await store.markHistoryWalked('p2', '2016-01-01');
    expect(await store.historyPagesNeedingWalk(candidates, '2019-01-01')).toEqual(['p2', 'p3']);
    expect(await store.historyPagesNeedingWalk(candidates, '2016-01-01')).toEqual(['p1', 'p3']);
    await store.markHistoryWalked('p2', '2019-01-01');
    expect(await store.historyPagesNeedingWalk(candidates, '2019-01-01')).toEqual(['p3']);
    expect(await store.historyPagesNeedingWalk([], '2019-01-01')).toEqual([]);
  });
});

const ALPHA = 'https://docs.mulesoft.com/release-notes/connector/alpha-release-notes';
const BETA = 'https://docs.mulesoft.com/release-notes/connector/beta-release-notes';
const twoPageIndex = indexHTML([
  ['November 10', [['../connector/alpha-release-notes#1-0-0', 'Alpha Connector 1.0.0'], ['../connector/alpha-release-notes#1-1-0', 'Alpha Connector 1.1.0']]],
  ['November 3', [['../connector/beta-release-notes#2-0-0', 'Beta Connector 2.0.0']]],
]);
const twoPageSite: Record<string, string> = {
  [ALPHA]: productPage([['1-0-0', para('Alpha one body.')], ['1-1-0', para('Alpha one-one body.')]]),
  [BETA]: productPage([['2-0-0', para('Beta two body.')]]),
};
const dedicatedURL = 'https://docs.mulesoft.com/release-notes/mule-maven-plugin/mule-maven-plugin-4-10-4-release-notes';
const dedicatedIndex = indexHTML([['November 4', [['../mule-maven-plugin/mule-maven-plugin-4-10-4-release-notes', 'Mule Maven Plugin 4.10.4']]]]);

describe('runner: index phase', () => {
  it('backfill fetches the index plus every linked page, stores bodies, writes notes', async () => {
    const store = newStore();
    const s = await run(siteClient({ index: twoPageIndex, pages: twoPageSite }), store, config());
    expect(s).toMatchObject({ pagesFetched: 2, pagesFailed: 0, entriesNew: 3, entriesTotal: 3, indexFullyProcessed: true, quartersWritten: ['2026-Q4'] });
    expect(await store.isBackfillComplete()).toBe(true);
    const q4 = note('2026-Q4');
    expect(q4.startsWith('# MuleSoft Release Notes — 2026 Q4')).toBe(true);
    for (const text of ['## Alpha Connector 1.0.0', 'Alpha one body.', 'Alpha one-one body.', 'Beta two body.', `[source](${ALPHA}#1-0-0)`]) expect(q4).toContain(text);
  });

  it('an incremental run with an all-known index fetches ONLY the index', async () => {
    const store = newStore();
    const client = siteClient({ index: twoPageIndex, pages: twoPageSite });
    await run(client, store, config());
    expect(client.calls).toHaveLength(3);
    const second = await run(client, store, config());
    expect(second).toMatchObject({ pagesFetched: 0, entriesNew: 0, quartersWritten: [] });
    expect(client.calls).toHaveLength(4);
    expect(client.calls.at(-1)).toBe(INDEX_URL);
  });

  it('a product-page failure is tolerated: other pages commit, the failed page retries next run', async () => {
    const store = newStore();
    const first = await run(siteClient({ index: twoPageIndex, pages: twoPageSite, throwingOn: [BETA] }), store, config());
    expect(first).toMatchObject({ pagesFetched: 1, pagesFailed: 1, entriesNew: 2, indexFullyProcessed: true });
    expect(await store.isBackfillComplete()).toBe(true);
    const recovered = siteClient({ index: twoPageIndex, pages: twoPageSite });
    const second = await run(recovered, store, config());
    expect(second).toMatchObject({ entriesNew: 1, pagesFetched: 1 });
    expect(recovered.calls).toEqual([INDEX_URL, BETA]);
    expect(await store.count()).toBe(3);
  });

  it('a missing anchor stores the entry with an empty body and never fails the run', async () => {
    const store = newStore();
    const index = indexHTML([['November 10', [['../connector/alpha-release-notes#9-9-9', 'Alpha Connector 9.9.9']]]]);
    expect((await run(siteClient({ index, pages: twoPageSite }), store, config())).entriesNew).toBe(1);
    const stored = await store.entriesForQuarter('2026-Q4');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ bodyMarkdown: '', bodyHTML: '' });
  });

  it('a no-fragment entry stores the whole dedicated page minus its h1', async () => {
    const store = newStore();
    const dedicated = `<html><body>
<article class="doc ">
<h1>Mule Maven Plugin 4.10.4 Release Notes</h1>
<div class="paragraph"><p><strong>November 4, 2026</strong></p></div>
<h2 id="whats-new" class="discrete">What’s New</h2>
<div class="paragraph"><p>Dedicated page body.</p></div>
</article>
</body></html>`;
    expect((await run(siteClient({ index: dedicatedIndex, pages: { [dedicatedURL]: dedicated } }), store, config())).entriesNew).toBe(1);
    const stored = (await store.entriesForQuarter('2026-Q4'))[0]!;
    expect(stored.anchor).toBe('');
    expect(stored.bodyMarkdown).toContain('November 4, 2026');
    expect(stored.bodyMarkdown).toContain('Dedicated page body.');
    expect(stored.bodyMarkdown).not.toContain('Mule Maven Plugin 4.10.4 Release Notes');
  });

  it('the page cap bounds the walk and leaves the flag unset', async () => {
    const store = newStore();
    const client = siteClient({ index: twoPageIndex, pages: twoPageSite });
    const s = await run(client, store, config({ maxProductPages: 1 }));
    expect(s).toMatchObject({ pagesFetched: 1, indexFullyProcessed: false });
    expect(await store.isBackfillComplete()).toBe(false);
    expect(client.calls).toHaveLength(2);
  });

  it('the index fetch failing fails the run and stores nothing', async () => {
    const store = newStore();
    await expect(run(siteClient({ index: '', error: new Error('offline') }), store, config())).rejects.toBeInstanceOf(MuleSoftClientError);
    expect(await store.count()).toBe(0);
    expect(await store.isBackfillComplete()).toBe(false);
  });

  it('renderAllQuarters re-renders every stored quarter even when nothing is new', async () => {
    const store = newStore();
    const client = siteClient({ index: twoPageIndex, pages: twoPageSite });
    await run(client, store, config({ vaultFolder: vault('a') }));
    const s = await run(client, store, config({ vaultFolder: vault('b') }), { renderAllQuarters: true });
    expect(s).toMatchObject({ entriesNew: 0, quartersWritten: ['2026-Q4'] });
    expect(note('2026-Q4', 'b')).toContain('## Beta Connector 2.0.0');
  });

  it('a new entry re-renders only its own quarter', async () => {
    const store = newStore();
    const fullIndex = `<html><body>
<article class="doc ">
<h2 id="november-2026">November 2026</h2>
<div class="paragraph">
<p>November 3</p>
</div>
<div class="ulist"><ul>
<li><p><a href="../connector/beta-release-notes#2-0-0" class="xref page">Beta Connector 2.0.0</a></p></li>
</ul></div>
<div class="paragraph">
<p>November 2</p>
</div>
<div class="ulist"><ul>
<li><p><a href="../connector/beta-release-notes#1-9-0" class="xref page">Beta Connector 1.9.0</a></p></li>
</ul></div>
<h2 id="september-2026">September 2026</h2>
<div class="paragraph">
<p>September 1</p>
</div>
<div class="ulist"><ul>
<li><p><a href="../connector/beta-release-notes#1-8-0" class="xref page">Beta Connector 1.8.0</a></p></li>
</ul></div>
</article>
</body></html>`;
    await run(siteClient({ index: fullIndex, pages: { [BETA]: productPage([['1-8-0', para('One eight.')], ['1-9-0', para('One nine.')], ['2-0-0', para('Two oh.')]]) } }), store, config());
    expect(await store.quarterKeys()).toEqual(['2026-Q4', '2026-Q3']);
    const newIndex = indexHTML([
      ['November 12', [['../connector/beta-release-notes#2-1-0', 'Beta Connector 2.1.0']]],
      ['November 3', [['../connector/beta-release-notes#2-0-0', 'Beta Connector 2.0.0']]],
    ]);
    const s = await run(siteClient({ index: newIndex, pages: { [BETA]: productPage([['2-0-0', para('Two oh.')], ['2-1-0', para('Two one.')]]) } }), store, config());
    expect(s).toMatchObject({ entriesNew: 1, quartersWritten: ['2026-Q4'] });
  });

  it('a cancelled run stops between pages and keeps what it committed', async () => {
    const store = newStore();
    let fetched = 0;
    const client = siteClient({ index: twoPageIndex, pages: twoPageSite });
    const original = client.fetch.bind(client);
    client.fetch = async url => { fetched++; return original(url); };
    await expect(run(client, store, config(), { isCancelled: () => fetched >= 2 })).rejects.toThrow('cancelled');
    expect(await store.count()).toBe(2); // alpha committed before the cancel
    expect(fs.existsSync(vault())).toBe(false);
  });
});

describe('runner: history phase', () => {
  it('history fold-in backfills old sections from pages the index phase already fetched', async () => {
    const store = newStore();
    const alpha = historyPage('Alpha Connector Release Notes', [
      ['1-0-0', '1.0.0', para('Alpha one body.')],
      ['1-1-0', '1.1.0', para('Alpha one-one body.')],
      ['0-9-0', '0.9.0', '<div class="paragraph"><p><strong>March 5, 2019</strong></p><p>Alpha ancient body.</p></div>'],
    ]);
    const client = siteClient({ index: twoPageIndex, home: homeHTML(), pages: { [ALPHA]: alpha, [BETA]: twoPageSite[BETA]! } });
    const s = await run(client, store, config(HISTORY));
    expect(s).toMatchObject({ pagesFetched: 2, pagesFailed: 0, entriesNew: 3, historyEntriesNew: 1, historyPagesFetched: 1, quartersWritten: ['2019-Q1', '2026-Q4'] });
    expect(await store.count()).toBe(4);
    expect(client.calls).toHaveLength(4); // index, alpha, beta, home
    const q1 = note('2019-Q1');
    expect(q1).toContain('## Alpha Connector 0.9.0');
    expect(q1).toContain('Alpha ancient body.');
    expect(q1).toContain(`[source](${ALPHA}#0-9-0)`);

    const second = await run(client, store, config(HISTORY));
    expect(second).toMatchObject({ entriesNew: 0, historyPagesFetched: 0, historyEntriesNew: 0, quartersWritten: [] });
    expect(client.calls).toHaveLength(5);
    expect(client.calls.at(-1)).toBe(INDEX_URL);
  });

  it('an index-linked section is not duplicated by the history phase', async () => {
    const store = newStore();
    const index = indexHTML([['November 3', [['../connector/beta-release-notes#july-2026', 'Beta Connector']]]]);
    const beta = historyPage('Beta Connector Release Notes', [['july-2026', 'July 2026', para('A month of changes.')]]);
    const s = await run(siteClient({ index, home: homeHTML(), pages: { [BETA]: beta } }), store, config(HISTORY));
    expect(s).toMatchObject({ entriesNew: 1, historyEntriesNew: 0 });
    expect(await store.count()).toBe(1);
    expect((await store.entriesForQuarter('2026-Q4'))[0]).toMatchObject({ anchor: 'july-2026', title: 'Beta Connector' });
  });

  it('history sections older than the cutoff are not stored', async () => {
    const store = newStore();
    const alpha = historyPage('Alpha Connector Release Notes', [
      ['1-0-0', '1.0.0', para('Alpha one body.')],
      ['0-1-0', '0.1.0', '<div class="paragraph"><p><strong>March 5, 2016</strong></p><p>Mule 3 era.</p></div>'],
    ]);
    const s = await run(siteClient({ index: twoPageIndex, home: homeHTML(), pages: { [ALPHA]: alpha, [BETA]: twoPageSite[BETA]! } }), store, config(HISTORY));
    expect(s).toMatchObject({ entriesNew: 3, historyEntriesNew: 0, quartersWritten: ['2026-Q4'] });
    expect(await store.count()).toBe(3);
    expect(fs.existsSync(path.join(vault(), '2016-Q1.md'))).toBe(false);
  });

  it('the walk discovers landings from home and their children, depth-capped', async () => {
    const store = newStore();
    const landingURL = 'https://docs.mulesoft.com/release-notes/connector/landing-release-notes';
    const gammaURL = 'https://docs.mulesoft.com/release-notes/connector/gamma-release-notes';
    const deltaURL = 'https://docs.mulesoft.com/release-notes/connector/delta-release-notes';
    const landing = `<html><body>
<article class="doc ">
<h1>Connectors</h1>
<div class="ulist"><ul>
<li><p><a href="gamma-release-notes" class="xref page">Gamma Connector</a></p></li>
</ul></div>
</article>
</body></html>`;
    const gamma = historyPage('Gamma Connector Release Notes', [['0-5-0', '0.5.0',
      '<div class="paragraph"><p><strong>May 4, 2020</strong></p><p>Gamma body.</p></div>'
      + '<div class="paragraph"><p><a href="delta-release-notes" class="xref page">Delta</a></p></div>']]);
    const client = siteClient({
      index: indexHTML([]), home: homeHTML([['connector/landing-release-notes', 'Connectors']]),
      pages: { [landingURL]: landing, [gammaURL]: gamma, [deltaURL]: '<html><body><article class="doc "><h1>Delta</h1></article></body></html>' },
    });
    const s = await run(client, store, config(HISTORY));
    expect(s).toMatchObject({ pagesFetched: 0, historyPagesFetched: 3, historyEntriesNew: 1, pagesFailed: 0, quartersWritten: ['2020-Q2'] });
    expect(client.calls).not.toContain(deltaURL);
    expect((await store.entriesForQuarter('2020-Q2'))[0]).toMatchObject({ product: 'Gamma Connector', title: 'Gamma Connector 0.5.0', date: '2020-05-04' });
    expect(note('2020-Q2')).toContain('## Gamma Connector 0.5.0');
    expect(note('2020-Q2')).toContain('Gamma body.');
  });

  it('a failed history page stays unmarked and is retried next run', async () => {
    const store = newStore();
    await run(siteClient({ index: twoPageIndex, pages: twoPageSite }), store, config());
    const second = await run(siteClient({ index: twoPageIndex, home: homeHTML(), pages: twoPageSite, throwingOn: [BETA] }), store, config(HISTORY));
    expect(second).toMatchObject({ pagesFetched: 0, historyPagesFetched: 2, pagesFailed: 1 });
    const recovered = siteClient({ index: twoPageIndex, home: homeHTML(), pages: twoPageSite });
    const third = await run(recovered, store, config(HISTORY));
    expect(third).toMatchObject({ historyPagesFetched: 1, pagesFailed: 0 });
    expect(recovered.calls).toEqual([INDEX_URL, BETA]);
  });

  it('a dedicated release page (stored empty-anchor entry) is never history-extracted', async () => {
    const store = newStore();
    const dedicated = `<html><body>
<article class="doc ">
<h1>Mule Maven Plugin 4.10.4 Release Notes</h1>
<div class="paragraph"><p><strong>November 4, 2026</strong></p></div>
<h2 id="november-4-2026">November 4, 2026</h2>
<div class="paragraph"><p>Released.</p></div>
<h2 id="whats-new" class="discrete">What’s New</h2>
<div class="paragraph"><p>Dedicated page body.</p></div>
</article>
</body></html>`;
    const s = await run(siteClient({ index: dedicatedIndex, home: homeHTML(), pages: { [dedicatedURL]: dedicated } }), store, config(HISTORY));
    expect(s).toMatchObject({ entriesNew: 1, historyEntriesNew: 0, historyPagesFetched: 1 });
    expect(await store.count()).toBe(1);
    expect((await store.entriesForQuarter('2026-Q4'))[0]!.anchor).toBe('');
  });

  it('quick-refs pages (the by-date index itself) are never history-walked', async () => {
    const store = newStore();
    await store.insert([makeEntry({ title: 'Index Chrome 1.0.0', pageURL: INDEX_URL, anchor: 'november-2026' })]);
    const client = siteClient({ index: indexHTML([]), home: homeHTML(), pages: {} });
    const s = await run(client, store, config(HISTORY));
    expect(s).toMatchObject({ historyPagesFetched: 1, pagesFailed: 0 });
    expect(client.calls).toEqual([INDEX_URL, HOME_URL]);
  });
});
