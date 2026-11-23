// Port of WorkatoScrapeRunner.swift: walk the archive pages, store new
// entries, re-render the quarter notes that gained entries.
// - Backfill (first run): walk until a 404 or an empty page, then mark done.
// - Incremental: stop at the first page that is entirely known.
import path from 'node:path';
import type { ScrapeSummary, WorkatoConfig } from './model.js';
import type { ChangelogStore } from './store.js';
import type { WorkatoClient } from './client.js';
import { parse } from './parser.js';
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

export async function runScrape(client: WorkatoClient, store: ChangelogStore, config: WorkatoConfig, o: RunOptions = {}): Promise<ScrapeSummary> {
  const now = o.now ?? new Date();
  const delay = o.pageDelayMs ?? 250;
  const check = () => { if (o.isCancelled?.()) throw new Cancelled(); };
  const backfilling = !(await store.isBackfillComplete());
  const touched = new Set<string>();
  let pagesFetched = 0;
  let newTotal = 0;
  let reachedEnd = false;

  for (let page = 1; page <= Math.max(1, config.maxPages); page++) {
    check();
    const html = await client.fetchPage(page);
    if (html === null) { reachedEnd = true; break; } // 404: past the last page
    pagesFetched++;
    const entries = parse(html);
    if (entries.length === 0) { reachedEnd = true; break; } // 200 with no posts: end of the archive
    const inserted = await store.insert(entries, now);
    newTotal += inserted.length;
    if (backfilling) {
      // All parsed quarters, not only new ones: a crash can commit pages without
      // rendering their notes, and a resumed backfill re-walks them as known.
      for (const e of entries) touched.add(e.quarterKey);
      if (inserted.length > 0 && delay > 0) await new Promise(r => setTimeout(r, delay)); // politeness
    } else {
      for (const e of inserted) touched.add(e.quarterKey);
      if (inserted.length === 0) break; // whole page known: history converged
    }
  }
  if (backfilling && reachedEnd) await store.markBackfillComplete();

  const quarters = o.renderAllQuarters ? await store.quarterKeys() : [...touched].sort();
  for (const q of quarters) {
    check();
    const note = renderNote(q, await store.entriesForQuarter(q), now);
    await writeTextAtomic(path.join(config.vaultFolder, `${q}.md`), note, 'workatochangelog');
  }
  return { pagesFetched, entriesNew: newTotal, entriesTotal: await store.count(), quartersWritten: quarters, reachedEndOfHistory: reachedEnd };
}
