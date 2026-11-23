// Port of PendoStore.swift: every fetched response is kept in the plugin's
// SQLite database alongside the Markdown report. Fetches are all-time, so
// repeats dedup on the fingerprint (first write wins: a response event is
// immutable). Poll definitions refresh every run; first_seen_at survives.
// Same schema as Swift, so the importer can copy pendofeedback.sqlite.
import crypto from 'node:crypto';
import type { Migration, SqlDatabase } from '@workbar/sdk';
import { accountID, browserTime, pollID, pollResponse, visitorID, type PendoRow, type PollMap } from './model.js';
import { responseText } from './renderer.js';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    label: 'create responses and polls',
    statements: [
      `CREATE TABLE IF NOT EXISTS responses (
        fingerprint    TEXT PRIMARY KEY,
        guide_id       TEXT NOT NULL,
        poll_id        TEXT NOT NULL DEFAULT '',
        poll_response  TEXT NOT NULL DEFAULT '',
        response_text  TEXT NOT NULL DEFAULT '',
        visitor_id     TEXT NOT NULL DEFAULT '',
        account_id     TEXT NOT NULL DEFAULT '',
        browser_time   TEXT,
        raw_json       TEXT NOT NULL,
        first_seen_at  TEXT NOT NULL,
        last_seen_at   TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS idx_responses_guide_poll ON responses(guide_id, poll_id, browser_time DESC)',
      `CREATE TABLE IF NOT EXISTS polls (
        guide_id      TEXT NOT NULL,
        poll_id       TEXT NOT NULL,
        question      TEXT NOT NULL DEFAULT '',
        choices_json  TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        PRIMARY KEY (guide_id, poll_id)
      )`,
    ],
  },
];

/** ISO 8601 UTC without fractions (Swift's ISO8601DateFormatter, withInternetDateTime). */
export const isoStamp = (secondsSince1970: number) => new Date(Math.floor(secondsSince1970) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The response's natural key, hashed: guide, poll, response, visitor,
 *  account and browserTime (epoch ms), joined with U+001F. Byte-identical
 *  to the Swift fingerprint. */
export function fingerprint(guideID: string, r: PendoRow): string {
  const t = browserTime(r);
  const basis = [guideID, pollID(r) ?? '', pollResponse(r) ?? '', visitorID(r) ?? '', accountID(r) ?? '', t === null ? '' : String(Math.trunc(t * 1000))].join('\u001f');
  return crypto.createHash('sha256').update(basis, 'utf8').digest('hex');
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
  : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
  : v;

/** Deterministic JSON (sorted keys, `/` escaped) like JSONSerialization with .sortedKeys. */
export const rawJSON = (raw: unknown): string => JSON.stringify(sortKeys(raw)).replace(/\//g, '\\/');

export class PendoStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Upserts the poll definitions and inserts the responses, in one
   *  transaction. Returns how many responses were new. */
  async record(guideID: string, rows: readonly PendoRow[], map: PollMap, now: Date = new Date()): Promise<number> {
    const at = isoStamp(now.getTime() / 1000);
    let inserted = 0;
    await this.db.run('BEGIN');
    try {
      for (const id of map.orderedIDs) {
        const poll = map.polls.get(id);
        if (!poll) continue;
        await this.db.run(
          `INSERT INTO polls (guide_id, poll_id, question, choices_json, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(guide_id, poll_id) DO UPDATE SET
             question = excluded.question, choices_json = excluded.choices_json, last_seen_at = excluded.last_seen_at`,
          [guideID, id, poll.question, rawJSON(poll.choices), at, at]);
      }
      for (const r of rows) {
        const t = browserTime(r);
        const { changes } = await this.db.run(
          `INSERT OR IGNORE INTO responses
             (fingerprint, guide_id, poll_id, poll_response, response_text, visitor_id, account_id, browser_time, raw_json, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fingerprint(guideID, r), guideID, pollID(r) ?? '', pollResponse(r) ?? '', responseText(r, map),
            visitorID(r) ?? '', accountID(r) ?? '', t === null ? null : isoStamp(t), rawJSON(r.raw), at, at]);
        if (changes > 0) inserted++;
      }
      await this.db.run('COMMIT');
    } catch (err) {
      await this.db.run('ROLLBACK').catch(() => {});
      throw err;
    }
    return inserted;
  }

  async responseCount(): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM responses'))?.n ?? 0);
  }

  async pollCount(guideID: string): Promise<number> {
    return Number((await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM polls WHERE guide_id = ?', [guideID]))?.n ?? 0);
  }
}
