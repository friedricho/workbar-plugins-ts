// Port of the MuleSoft ChangelogStore.swift. The schema is unchanged, so the
// importer can copy the Swift plugin's mulesoftchangelog.sqlite (entries,
// the backfill flag and the hist:<page> walk markers) and runs continue.
import type { Migration, SqlDatabase } from '@workbar/sdk';
import type { ReleaseEntry } from './model.js';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: 'create entries and meta',
    statements: [
      `CREATE TABLE IF NOT EXISTS entries (
        fingerprint    TEXT PRIMARY KEY,
        entry_date     TEXT NOT NULL,
        quarter_key    TEXT NOT NULL,
        product        TEXT NOT NULL,
        title          TEXT NOT NULL,
        page_url       TEXT NOT NULL,
        anchor         TEXT NOT NULL DEFAULT '',
        body_markdown  TEXT NOT NULL,
        body_html      TEXT NOT NULL,
        first_seen_at  TEXT NOT NULL,
        last_seen_at   TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_entries_quarter ON entries(quarter_key, entry_date DESC)',
      `CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
];

const BACKFILL_KEY = 'backfill_complete';
const HIST_PREFIX = 'hist:';
/** ISO 8601 without fractions, like the Swift ISO8601DateFormatter. */
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Row { fingerprint: string; entry_date: string; quarter_key: string; product: string; title: string; page_url: string; anchor: string; body_markdown: string; body_html: string }

export class ChangelogStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Inserts entries not seen before (first write wins); returns only the new ones. One transaction. */
  async insert(entries: readonly ReleaseEntry[], now: Date = new Date()): Promise<ReleaseEntry[]> {
    const at = stamp(now);
    const inserted: ReleaseEntry[] = [];
    await this.db.run('BEGIN');
    try {
      for (const e of entries) {
        const { changes } = await this.db.run(
          `INSERT OR IGNORE INTO entries
             (fingerprint, entry_date, quarter_key, product, title, page_url, anchor, body_markdown, body_html, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.fingerprint, e.date, e.quarterKey, e.product, e.title, e.pageURL, e.anchor, e.bodyMarkdown, e.bodyHTML, at, at],
        );
        if (changes > 0) inserted.push(e);
      }
      await this.db.run('COMMIT');
    } catch (err) {
      await this.db.run('ROLLBACK').catch(() => {});
      throw err;
    }
    return inserted;
  }

  /** Which of the fingerprints are stored (batched under SQLite's variable limit). */
  async knownFingerprints(fingerprints: readonly string[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (let i = 0; i < fingerprints.length; i += 500) {
      const chunk = fingerprints.slice(i, i + 500);
      const rows = await this.db.all<{ fingerprint: string }>(
        `SELECT fingerprint FROM entries WHERE fingerprint IN (${chunk.map(() => '?').join(', ')})`, chunk);
      for (const r of rows) known.add(r.fingerprint);
    }
    return known;
  }

  /** One quarter, newest first, title as the same-day tiebreak. */
  async entriesForQuarter(key: string): Promise<ReleaseEntry[]> {
    const rows = await this.db.all<Row>(
      `SELECT fingerprint, entry_date, quarter_key, product, title, page_url, anchor, body_markdown, body_html
       FROM entries WHERE quarter_key = ? ORDER BY entry_date DESC, title ASC`, [key]);
    return rows.map(r => ({
      fingerprint: r.fingerprint, date: r.entry_date, quarterKey: r.quarter_key, product: r.product, title: r.title,
      pageURL: r.page_url, anchor: r.anchor, bodyMarkdown: r.body_markdown, bodyHTML: r.body_html,
    }));
  }

  async quarterKeys(): Promise<string[]> {
    return (await this.db.all<{ quarter_key: string }>('SELECT DISTINCT quarter_key FROM entries ORDER BY quarter_key DESC')).map(r => r.quarter_key);
  }

  async count(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM entries'))?.n ?? 0);
  }

  async isBackfillComplete(): Promise<boolean> {
    return (await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [BACKFILL_KEY]))?.value === '1';
  }

  async markBackfillComplete(): Promise<void> {
    await this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')", [BACKFILL_KEY]);
  }

  // ---- History walk ----

  /** Anchors stored for one page: the (page, anchor) dedup between
   *  index-sourced and history-sourced entries, whose titles differ. */
  async existingAnchors(pageURL: string): Promise<Set<string>> {
    return new Set((await this.db.all<{ anchor: string }>('SELECT anchor FROM entries WHERE page_url = ?', [pageURL])).map(r => r.anchor));
  }

  /** True when the page has an empty-anchor entry: a dedicated release page already captured whole. */
  async hasWholePageEntry(pageURL: string): Promise<boolean> {
    return (await this.db.get("SELECT 1 AS one FROM entries WHERE page_url = ? AND anchor = '' LIMIT 1", [pageURL])) !== undefined;
  }

  /** The most common stored product for the page, so history titles match index titles. */
  async productForPage(pageURL: string): Promise<string | null> {
    const row = await this.db.get<{ product: string }>(
      `SELECT product, COUNT(*) AS n FROM entries WHERE page_url = ?
       GROUP BY product ORDER BY n DESC, product ASC LIMIT 1`, [pageURL]);
    return row?.product ?? null;
  }

  /** Every page URL ever stored: history-walk seeds. */
  async knownPageURLs(): Promise<string[]> {
    return (await this.db.all<{ page_url: string }>('SELECT DISTINCT page_url FROM entries ORDER BY page_url ASC')).map(r => r.page_url);
  }

  /** The candidates whose walk marker is absent or holds a different cutoff
   *  (a changed cutoff re-walks). Order preserved. */
  async historyPagesNeedingWalk(candidates: readonly string[], cutoff: string): Promise<string[]> {
    if (candidates.length === 0) return [];
    const rows = await this.db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key LIKE '${HIST_PREFIX}%'`);
    const walked = new Map(rows.map(r => [r.key.slice(HIST_PREFIX.length), r.value]));
    return candidates.filter(c => walked.get(c) !== cutoff);
  }

  async markHistoryWalked(pageURL: string, cutoff: string): Promise<void> {
    await this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [`${HIST_PREFIX}${pageURL}`, cutoff]);
  }
}
