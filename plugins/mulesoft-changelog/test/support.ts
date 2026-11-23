// Test helpers: real SQLite (node:sqlite, migrations applied like the host's
// StorageService), a fake site behind the real MuleSoftClient, synthetic
// Antora pages, and makeEntry (the Swift TestSupport).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { HttpClient, Migration, SqlDatabase } from '@workbar/sdk';
import { MuleSoftClient } from '../src/client.js';
import { fingerprint, HOME_URL, INDEX_URL, productName } from '../src/parsers.js';
import { quarterKey, type ReleaseEntry } from '../src/model.js';

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

/** The real client over a fake HttpClient: the index URL serves `index`, the
 *  home serves `home` (404 when undefined), other URLs come from `pages`
 *  (404 when missing); `throwingOn` URLs fail at the transport. */
export function siteClient(site: { index: string; indexStatus?: number; home?: string; pages?: Record<string, string>; throwingOn?: readonly string[]; error?: Error }): MuleSoftClient & { calls: string[] } {
  const calls: string[] = [];
  const http: HttpClient = {
    fetch: async url => {
      calls.push(url);
      if (site.error) throw site.error;
      if (url === INDEX_URL) return { status: site.indexStatus ?? 200, text: site.index, headers: {} };
      if (url === HOME_URL && site.home !== undefined) return { status: 200, text: site.home, headers: {} };
      if (site.throwingOn?.includes(url)) throw new Error('The Internet connection appears to be offline.');
      const html = site.pages?.[url];
      return html === undefined ? { status: 404, text: 'not found', headers: {} } : { status: 200, text: html, headers: {} };
    },
  };
  return Object.assign(new MuleSoftClient(http), { calls });
}

/** One index page with a November 2026 section; each day lists (href, title) links. */
export function indexHTML(sections: Array<[day: string, entries: Array<[href: string, title: string]>]>): string {
  const body = sections.map(([day, entries]) => `<div class="paragraph">
<p>${day}</p>
</div>
<div class="ulist"><ul>
${entries.map(([href, title]) => `<li><p><a href="${href}" class="xref page">${title}</a></p></li>`).join('\n')}
</ul></div>`).join('\n');
  return `<html><body>
<article class="mega-menu-item-header">chrome</article>
<article class="doc ">
<h1>Release Notes by Date</h1>
<h2 id="november-2026"><a class="anchor" href="#november-2026"></a>November 2026</h2>
${body}
</article>
</body></html>`;
}

/** A product page: one h2 per (anchor, body); the heading echoes the anchor. */
export function productPage(sections: Array<[anchor: string, body: string]>): string {
  return historyPage('Product Release Notes', sections.map(([a, b]) => [a, a, b]));
}

/** A product page with explicit h2 headings ("3.0.1"). */
export function historyPage(h1: string, sections: Array<[anchor: string, heading: string, body: string]>): string {
  const body = sections.map(([anchor, heading, b]) => `<h2 id="${anchor}"><a class="anchor" href="#${anchor}"></a>${heading}</h2>\n${b}`).join('\n');
  return `<html><body>
<article class="doc ">
<h1>${h1}</h1>
${body}
</article>
</body></html>`;
}

/** The release-notes home with the given product links (no h2s). */
export function homeHTML(links: Array<[href: string, title: string]> = []): string {
  return `<html><body>
<article class="doc ">
<h1>Release Notes</h1>
<div class="ulist"><ul>
${links.map(([href, title]) => `<li><p><a href="${href}" class="xref page">${title}</a></p></li>`).join('\n')}
</ul></div>
</article>
</body></html>`;
}

export const para = (text: string) => `<div class="paragraph"><p>${text}</p></div>`;

/** A sample entry; defaults make a valid 2026-Q4 entry. */
export function makeEntry(o: Partial<Omit<ReleaseEntry, 'fingerprint' | 'quarterKey'>> = {}): ReleaseEntry {
  const title = o.title ?? 'Sample Connector 1.2.3';
  const date = o.date ?? '2026-11-10';
  return {
    fingerprint: fingerprint(date, title), date, quarterKey: quarterKey(date),
    product: o.product ?? productName(title), title,
    pageURL: o.pageURL ?? 'https://docs.mulesoft.com/release-notes/connector/sample-release-notes',
    anchor: o.anchor ?? '1-2-3', bodyMarkdown: o.bodyMarkdown ?? 'Body text', bodyHTML: o.bodyHTML ?? '<p>Body text</p>',
  };
}
