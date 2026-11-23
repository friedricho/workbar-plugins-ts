// Test helpers: real SQLite (node:sqlite, migrations applied like the host's
// StorageService) and a fake HttpClient recording every request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { HttpClient, Migration, SqlDatabase } from '@workbar/sdk';

export const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
export const fixtureJSON = (name: string) => JSON.parse(fixture(`${name}.json`)) as Record<string, unknown>;

export function openTestDb(migrations: readonly Migration[], file = ':memory:'): SqlDatabase & { raw: DatabaseSync } {
  const db = new DatabaseSync(file);
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    for (const s of m.statements) db.exec(s);
    db.exec(`PRAGMA user_version = ${m.version}`);
    db.exec('COMMIT');
  }
  const p = (params?: readonly unknown[]) => (params ?? []) as SQLInputValue[];
  return {
    raw: db,
    all: async <T>(sql: string, params?: readonly unknown[]) => db.prepare(sql).all(...p(params)) as T[],
    get: async <T>(sql: string, params?: readonly unknown[]) => db.prepare(sql).get(...p(params)) as T | undefined,
    run: async (sql: string, params?: readonly unknown[]) => ({ changes: Number(db.prepare(sql).run(...p(params)).changes) }),
    close: async () => db.close(),
  };
}

export interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

/** A fake HttpClient: `handler` answers (default 200 "[]"); `error` throws; `delayMs` stalls. */
export function fakeHttp(o: { handler?: (c: Call) => [status: number, text: string]; error?: Error; delayMs?: number } = {}): HttpClient & { calls: Call[]; handler: ((c: Call) => [number, string]) | undefined } {
  const calls: Call[] = [];
  const http = {
    calls,
    handler: o.handler,
    fetch: async (url: string, init: { method?: string; headers?: Readonly<Record<string, string>>; body?: string } = {}) => {
      const call: Call = { url, method: init.method ?? 'GET', headers: { ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) };
      calls.push(call);
      if (o.error) throw o.error;
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
      const [status, text] = http.handler?.(call) ?? [200, '[]'];
      return { status, text, headers: {} };
    },
  };
  return http;
}

export const GUIDE_JSON = `{"id": "g1", "name": "Autopilot Early Access Guide",
 "polls": [{"id": "p1", "question": "How useful is Autopilot?",
            "idResponses": [{"id": "c1", "label": "Very useful"}]}]}`;
export const ROWS_JSON = `[{"pollId": "p1", "pollResponse": "c1", "visitorId": "visitor-abc",
  "accountId": "acct-1", "browserTime": "2026-11-11T09:14:00Z"}]`;

/** Serves one guide and one response set. */
export const servingHttp = () => fakeHttp({ handler: c => [200, new URL(c.url).pathname.endsWith('/api/v1/guide') ? GUIDE_JSON : ROWS_JSON] });
