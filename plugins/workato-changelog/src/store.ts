// Port of ChangelogStore.swift. The schema is unchanged, so the importer can
// copy the Swift plugin's workatochangelog.sqlite and runs continue from it.
import type { Migration, SqlDatabase } from '@workbar/sdk';
import type { ChangelogEntry } from './model.js';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: 'create entries and meta',
    statements: [
      `CREATE TABLE IF NOT EXISTS entries (
        fingerprint    TEXT PRIMARY KEY,
        entry_date     TEXT NOT NULL,
        quarter_key    TEXT NOT NULL,
        title          TEXT NOT NULL,
        categories     TEXT NOT NULL DEFAULT '[]',
        badge          TEXT NOT NULL DEFAULT '',
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
/** ISO 8601 without fractions, like the Swift ISO8601DateFormatter. */
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Row { fingerprint: string; entry_date: string; quarter_key: string; title: string; categories: string; badge: string; body_markdown: string; body_html: string }

export class ChangelogStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Inserts entries not seen before; returns only the new ones. One transaction. */
  async insert(entries: readonly ChangelogEntry[], now: Date = new Date()): Promise<ChangelogEntry[]> {
    const at = stamp(now);
    const inserted: ChangelogEntry[] = [];
    await this.db.run('BEGIN');
    try {
      for (const e of entries) {
        const { changes } = await this.db.run(
          `INSERT OR IGNORE INTO entries
             (fingerprint, entry_date, quarter_key, title, categories, badge, body_markdown, body_html, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.fingerprint, e.date, e.quarterKey, e.title, JSON.stringify(e.categories), e.badge, e.bodyMarkdown, e.bodyHTML, at, at],
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

  async entriesForQuarter(key: string): Promise<ChangelogEntry[]> {
    const rows = await this.db.all<Row>(
      `SELECT fingerprint, entry_date, quarter_key, title, categories, badge, body_markdown, body_html
       FROM entries WHERE quarter_key = ? ORDER BY entry_date DESC, title ASC`, [key]);
    return rows.map(r => ({
      fingerprint: r.fingerprint, date: r.entry_date, quarterKey: r.quarter_key, title: r.title,
      categories: parseCategories(r.categories), badge: r.badge, bodyMarkdown: r.body_markdown, bodyHTML: r.body_html,
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
}

function parseCategories(json: string): string[] {
  try { const v: unknown = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }
  catch { return []; }
}
