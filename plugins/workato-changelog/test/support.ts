// Test helpers: a real SQLite database (node:sqlite, migrations applied like
// the host's StorageService) and a scripted Workato client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Migration, SqlDatabase } from '@workbar/sdk';
import { WorkatoClient, WorkatoClientError } from '../src/client.js';

export const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

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

type PageResult = string | null | Error;

/** A WorkatoClient whose pages come from a script: page n → HTML, null (404) or an error. */
export class ScriptedClient extends WorkatoClient {
  readonly requested: number[] = [];
  constructor(private readonly pages: (page: number) => PageResult) {
    super({ fetch: async () => { throw new Error('unused'); } });
  }
  override async fetchPage(page: number): Promise<string | null> {
    this.requested.push(page);
    const r = this.pages(page);
    if (r instanceof Error) throw r;
    return r;
  }
}

export const networkError = () => new WorkatoClientError('network', 'getaddrinfo ENOTFOUND www.workato.com');

/** A synthetic page with the given posts (date text, title), in the 2026 template. */
export function page(posts: Array<[date: string, title: string]>): string {
  return '<html><body>' + posts.map(([d, t]) => `
    <div class="workato-changelog-post">
      <div class="workato-changelog-date workato-changelog-meta">${d}</div>
      <span class="workato-changelog-quarter">Released</span>
      <h3 class="workato-changelog-title">${t}</h3>
      <div class="workato-changelog-desc"><p>${t} body</p></div>
    </div>`).join('') + '</body></html>';
}
