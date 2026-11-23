// Port of MuleSoftScrapeRunner.swift. One run, two phases:
//
// Index phase: fetch the by-date index (a single rolling ~15-month page),
// dedup against the store, fetch ONLY the product pages with unknown
// entries, extract each entry's section, store. The index failing fails the
// run; a product page failing is tolerated (its entries stay unknown and
// are retried next run).
//
// History phase (when config.historyStart is set): backfill the years the
// index no longer covers, once per page per cutoff. Pages the index phase
// fetched are history-extracted from the same HTML (no extra fetch); then a
// walk covers the rest: the release-notes home (depth 0) → landings (1) →
// their children (2, terminal), plus every page ever stored. `hist:<page>`
// markers make it one-time; a changed cutoff re-walks. quick-refs/ pages
// (the index itself) are never history-extracted. Overlap dedup is
// (page, anchor), both directions, and a dedicated release page (stored
// empty-anchor entry) is never history-extracted.
//
// Each page's inserts commit before the next fetch. The backfill flag only
// sets the re-render scope: until it is set, every parsed quarter renders.
import path from 'node:path';
import { quarterKey, type MuleSoftConfig, type ReleaseEntry, type ScrapeSummary } from './model.js';
import type { ChangelogStore } from './store.js';
import type { MuleSoftClient } from './client.js';
import { derivedProduct, discoverPageLinks, extractHistory, extractSection, fingerprint, HOME_URL, INDEX_URL, parseIndex, RELEASE_NOTES_ROOT } from './parsers.js';
import { renderNote } from './renderer.js';
import { writeTextAtomic } from '../../../shared/atomic-write.js';

export class Cancelled extends Error { constructor() { super('cancelled'); this.name = 'Cancelled'; } }

export interface RunOptions {
  readonly now?: Date;
  readonly pageDelayMs?: number;
  /** Re-render every stored quarter (the vault folder changed). */
  readonly renderAllQuarters?: boolean;
  readonly isCancelled?: () => boolean;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isWalkable = (url: string) => url.startsWith(RELEASE_NOTES_ROOT) && !url.includes('/quick-refs/');

export async function runScrape(client: MuleSoftClient, store: ChangelogStore, config: MuleSoftConfig, o: RunOptions = {}): Promise<ScrapeSummary> {
  const now = o.now ?? new Date();
  const delay = o.pageDelayMs ?? 250;
  const check = () => { if (o.isCancelled?.()) throw new Cancelled(); };
  const cutoff = config.historyStart ?? null;
  const backfilling = !(await store.isBackfillComplete());

  const tryFetch = async (url: string): Promise<string | null> => {
    try { return await client.fetch(url); } catch { return null; }
  };

  /** History-extract one fetched page and insert what's new. */
  const historyFrom = async (html: string, pageURL: string): Promise<ReleaseEntry[]> => {
    if (cutoff === null || await store.hasWholePageEntry(pageURL)) return [];
    const product = (await store.productForPage(pageURL)) ?? derivedProduct(html);
    if (product === null) return [];
    const { sections } = extractHistory(html, product, cutoff);
    if (sections.length === 0) return [];
    const stored = await store.existingAnchors(pageURL);
    return store.insert(sections.filter(s => !stored.has(s.anchor)).map(s => ({
      fingerprint: fingerprint(s.date, s.title), date: s.date, quarterKey: quarterKey(s.date), product, title: s.title,
      pageURL, anchor: s.anchor, bodyMarkdown: s.markdown, bodyHTML: s.html,
    })), now);
  };

  // ---- Index phase ----
  check();
  const all = parseIndex(await client.fetch(INDEX_URL));
  const known = await store.knownFingerprints(all.map(e => e.fingerprint));
  const unknown = all.filter(e => !known.has(e.fingerprint));

  let pagesFetched = 0;
  let pagesFailed = 0;
  const newEntries: ReleaseEntry[] = [];
  const historyEntries: ReleaseEntry[] = [];
  let fullyProcessed = true;
  let indexPageURLs: string[] = [];

  if (unknown.length > 0) {
    const grouped = new Map<string, ReleaseEntry[]>();
    for (const e of unknown) grouped.set(e.pageURL, [...(grouped.get(e.pageURL) ?? []), e]);
    indexPageURLs = [...grouped.keys()].sort();
    const cap = Math.max(1, config.maxProductPages);
    fullyProcessed = indexPageURLs.length <= cap;
    for (const pageURL of indexPageURLs.slice(0, cap)) {
      check();
      const html = await tryFetch(pageURL);
      if (html === null) { pagesFailed++; continue; } // entries stay unknown: retried next run
      pagesFetched++;
      let pageEntries = grouped.get(pageURL) ?? [];
      if (cutoff !== null) {
        // A previous walk may have stored the section under a synthesized title.
        const stored = await store.existingAnchors(pageURL);
        pageEntries = pageEntries.filter(e => e.anchor === '' || !stored.has(e.anchor));
      }
      const withBodies = pageEntries.map(e => {
        const section = extractSection(html, e.anchor);
        return section ? { ...e, bodyMarkdown: section.markdown, bodyHTML: section.html } : e; // drift: empty body
      });
      newEntries.push(...await store.insert(withBodies, now));
      if (cutoff !== null) {
        historyEntries.push(...await historyFrom(html, pageURL)); // fold-in: no extra fetch
        await store.markHistoryWalked(pageURL, cutoff);
      }
      if (delay > 0) await sleep(delay); // politeness during the ~360-page backfill
    }
  }
  if (fullyProcessed) await store.markBackfillComplete();

  // ---- History walk ----
  let historyFetched = 0;
  if (cutoff !== null) {
    const seen = new Set<string>();
    const seeds: Array<{ url: string; depth: number }> = [];
    const seed = (url: string, depth: number) => { if (isWalkable(url) && !seen.has(url)) { seen.add(url); seeds.push({ url, depth }); } };
    seed(HOME_URL, 0);
    for (const u of indexPageURLs) seed(u, 2);
    for (const u of await store.knownPageURLs()) seed(u, 2);
    const needing = new Set(await store.historyPagesNeedingWalk(seeds.map(s => s.url), cutoff));
    const queue = seeds.filter(s => needing.has(s.url));
    const cap = Math.max(1, config.maxHistoryPages ?? 1000);
    for (let cursor = 0; cursor < queue.length && historyFetched < cap; cursor++) {
      const { url, depth } = queue[cursor]!;
      check();
      const html = await tryFetch(url);
      if (html === null) { pagesFailed++; continue; } // unmarked: retried next run
      historyFetched++;
      historyEntries.push(...await historyFrom(html, url));
      await store.markHistoryWalked(url, cutoff);
      if (depth < 2) {
        const links = discoverPageLinks(html, url).filter(l => isWalkable(l) && !seen.has(l));
        for (const link of await store.historyPagesNeedingWalk(links, cutoff)) {
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }
      if (delay > 0) await sleep(delay);
    }
  }

  // ---- Render ----
  const touched = new Set(backfilling ? all.map(e => e.quarterKey) : newEntries.map(e => e.quarterKey));
  for (const e of historyEntries) touched.add(e.quarterKey);
  const quarters = o.renderAllQuarters ? await store.quarterKeys() : [...touched].sort();
  for (const q of quarters) {
    check();
    const note = renderNote(q, await store.entriesForQuarter(q), now);
    await writeTextAtomic(path.join(config.vaultFolder, `${q}.md`), note, 'mulesoftchangelog');
  }
  return {
    pagesFetched, pagesFailed, entriesNew: newEntries.length, entriesTotal: await store.count(), quartersWritten: quarters,
    indexFullyProcessed: fullyProcessed, historyPagesFetched: historyFetched, historyEntriesNew: historyEntries.length,
  };
}
