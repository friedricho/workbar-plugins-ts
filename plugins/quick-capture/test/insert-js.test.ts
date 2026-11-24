// insert.js runs INSIDE Obsidian (via `obsidian eval`), so it must stay a verbatim copy of the Swift repo's file
// and must agree with board.ts on every input. Two checks:
//  1. the Swift repo's own insert.test.mjs (node:test) passes against this copy;
//  2. differential: board.ts and insert.js produce identical output (or both throw) on generated boards.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ColumnNotFoundError, insertCard } from '../src/board.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { qc_insert } = createRequire(import.meta.url)(path.join(here, '..', 'resources', 'insert.js')) as { qc_insert(c: string, col: string, card: string): string };

describe('insert.js', () => {
  it('passes the Swift repo’s insert.test.mjs unchanged', async () => {
    const result = await new Promise<{ code: number | null; out: string }>(resolve =>
      execFile(process.execPath, ['--test', path.join(here, 'insert.test.mjs')], { timeout: 60_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(stdout) + String(stderr) })));
    // Node's reporter prints "# fail 0" (TAP) or "ℹ fail 0" (spec), depending on version and TTY.
    expect(result.out).toMatch(/(?:#|ℹ) fail 0\b/);
    expect(result.code).toBe(0);
  });
});

/** A small deterministic PRNG, so a failure reproduces from its seed. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

const PIECES = [
  '## Today', '## Backlog', '## Done', '##Today', '##', '### Today', '## Today #', '##\tToday', '## Today  ', '#', '## ', '##Done',
  '- [ ] card', '- [x] done', '  continuation', '', '', '   ', 'plain text', '---', 'kanban-plugin: board',
  '%% kanban:settings', '```', '{"kanban-plugin":"board","new-card-insertion-method":"append"}',
  '{"new-card-insertion-method":"prepend"}', '{"new-card-insertion-method":"side-load"}', '{"new-card-insertion-method": "append', '%%', '%% other',
  'ünïcode ✨', 'tab\there', ' ## Today', '﻿## Today', '## Today\u2028x',
];
const TERMS = ['\n', '\r\n', '\n', '\n', '\r\n', '\r'];
const CARDS = ['New idea ✨ #test', 'x', 'one\ntwo', 'a\n\nb', '', '\n', 'trailing\n', 'émoji 👩‍💻', '- [ ] looks like a card', '## not a heading'];
const COLUMNS = ['Today', 'Backlog', 'Done', 'today', 'Nope', 'Today #', ''];

function board(rand: () => number): string {
  const n = Math.floor(rand() * 16);
  let out = '';
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(rand() * PIECES.length)]! + (i === n - 1 && rand() < 0.4 ? '' : TERMS[Math.floor(rand() * TERMS.length)]!);
  return out;
}

const run = (f: () => string): { ok: true; out: string } | { ok: false } => { try { return { ok: true, out: f() }; } catch { return { ok: false }; } };

describe('board.ts agrees with insert.js', () => {
  it('on 6000 generated boards (output byte-identical, or both reject the column)', () => {
    const rand = rng(20261123);
    let inserted = 0; let rejected = 0;
    for (let i = 0; i < 6000; i++) {
      const content = board(rand);
      const column = COLUMNS[Math.floor(rand() * COLUMNS.length)]!;
      const card = CARDS[Math.floor(rand() * CARDS.length)]!;
      const ts = run(() => insertCard(card, column, content));
      const js = run(() => qc_insert(content, column, card));
      if (ts.ok !== js.ok || (ts.ok && js.ok && ts.out !== js.out)) {
        throw new Error(`disagreement #${i}\ncolumn=${JSON.stringify(column)} card=${JSON.stringify(card)}\nboard=${JSON.stringify(content)}\nts=${JSON.stringify(ts)}\njs=${JSON.stringify(js)}`);
      }
      if (ts.ok) inserted++; else rejected++;
    }
    // Both branches really were exercised.
    expect(inserted).toBeGreaterThan(500);
    expect(rejected).toBeGreaterThan(500);
  });

  it('a rejected column is a ColumnNotFoundError in board.ts and "QC column not found" in insert.js', () => {
    expect(() => insertCard('x', 'Nope', '## Today\n')).toThrow(ColumnNotFoundError);
    expect(() => qc_insert('## Today\n', 'Nope', 'x')).toThrow('QC column not found: Nope');
  });
});
