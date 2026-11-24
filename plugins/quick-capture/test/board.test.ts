// Ported case for case from BoardParserTests.swift and FixtureManifestTests.swift
// (the golden fixtures are byte-exact copies of the Swift repo's).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ColumnNotFoundError, columnNames, containsCard, cardLineTexts, insertCard, render, splitLines } from '../src/board.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bytes = (name: string) => fs.readFileSync(path.join(dir, name));

interface Case { name: string; input: string; expected?: string; column: string; card?: string; error?: string }
const manifest = JSON.parse(bytes('manifest.json').toString('utf8')) as { cases: Case[] };

describe('golden fixtures (byte-exact, CRLF included)', () => {
  it('the manifest still has 13 cases', () => { expect(manifest.cases).toHaveLength(13); });

  for (const c of manifest.cases) {
    it(c.name, () => {
      const content = bytes(c.input).toString('utf8');
      const card = c.card ?? 'New idea ✨ #test';
      if (c.error === 'columnNotFound') {
        expect(() => insertCard(card, c.column, content)).toThrow(ColumnNotFoundError);
        expect(() => insertCard(card, c.column, content)).toThrow(`Column not found: ${c.column}`);
        return;
      }
      const output = insertCard(card, c.column, content);
      expect(Buffer.from(output, 'utf8').equals(bytes(c.expected!))).toBe(true);

      // One-line-diff invariant: output = input with exactly N lines inserted at ONE position, and they are the card lines.
      const from = splitLines(content); const to = splitLines(output); const cards = cardLineTexts(card);
      expect(to).toHaveLength(from.length + cards.length);
      const positions: number[] = [];
      for (let i = 0; i <= from.length; i++) {
        const prefix = from.slice(0, i).every((l, k) => l.text === to[k]!.text && l.term === to[k]!.term);
        const suffix = from.slice(i).every((l, k) => l.text === to[i + cards.length + k]!.text && l.term === to[i + cards.length + k]!.term);
        if (prefix && suffix) positions.push(i);
      }
      expect(positions).toHaveLength(1);
      cards.forEach((text, k) => expect(to[positions[0]! + k]!.text).toBe(text));
    });
  }
});

describe('columnNames', () => {
  it('returns depth-2 titles only', () => {
    expect(columnNames('## Backlog\n##Today\n### Deep work\n## Today\n## Done ##')).toEqual(['Backlog', 'Today', 'Done ##']);
  });
  it('is empty for content without headings', () => { expect(columnNames('- [ ] just a card\nno headings here')).toEqual([]); });
});

describe('containsCard', () => {
  const content = '## Backlog\n\n- [ ] Fix the flaky test\n\n## Today\n\n- [ ] Ship the thing';
  it('is true only within the target section', () => {
    expect(containsCard('Ship the thing', 'Today', content)).toBe(true);
    expect(containsCard('Fix the flaky test', 'Today', content)).toBe(false); // exists only in ANOTHER column
    expect(containsCard('Ship the thing', 'Done', content)).toBe(false);
    expect(containsCard('Ship the thing', 'Nope', content)).toBe(false);     // missing column: false, no throw
  });
  it('matches an inserted multiline card by exact lines; a bare continuation line is not a card start', () => {
    const out = insertCard('First line\nSecond line', 'Today', '## Today\n- [ ] Existing\n');
    expect(containsCard('First line\nSecond line', 'Today', out)).toBe(true);
    expect(containsCard('First line', 'Today', out)).toBe(true);
    expect(containsCard('Second line', 'Today', out)).toBe(false);
    expect(containsCard('Existing', 'Today', out)).toBe(true);
  });
});

describe('insertCard', () => {
  it('formats a multiline card with two-space continuation', () => {
    expect(insertCard('First line\nSecond line\nThird line', 'Today', '## Today\n- [ ] A\n'))
      .toBe('## Today\n- [ ] First line\n  Second line\n  Third line\n- [ ] A\n');
  });
  it('throws a typed column-not-found error', () => {
    expect(() => insertCard('X', 'Today', '## Other\n- [ ] x\n')).toThrow(new ColumnNotFoundError('Today'));
  });
  it('malformed settings JSON falls back to prepend', () => {
    const content = '## Today\n\n- [ ] Existing card\n\n%% kanban:settings\n```\n{"new-card-insertion-method": "append\n```\n%%';
    expect(insertCard('New', 'Today', content).startsWith('## Today\n\n- [ ] New\n- [ ] Existing card\n')).toBe(true);
  });
  it('##Today (no space) is not a column but DOES end a section', () => {
    const content = '## Today\n- [ ] A\n##Done\n- [ ] B\n';
    expect(columnNames(content)).toEqual(['Today']);
    expect(insertCard('New', 'Today', content)).toBe('## Today\n- [ ] New\n- [ ] A\n##Done\n- [ ] B\n');
    expect(() => insertCard('X', 'Done', content)).toThrow(ColumnNotFoundError);
  });
  it('a bare ## is not a column but DOES end a section', () => {
    const content = '## Today\n- [ ] A\n##\n- [ ] B\n';
    expect(columnNames(content)).toEqual(['Today']);
    expect(insertCard('New', 'Today', content)).toBe('## Today\n- [ ] New\n- [ ] A\n##\n- [ ] B\n');
  });
  it('an unrecognized insertion method ("side-load") falls back to prepend', () => {
    const content = '## Today\n\n- [ ] A\n\n%% kanban:settings\n```\n{"new-card-insertion-method":"side-load"}\n```\n%%';
    expect(insertCard('New', 'Today', content).startsWith('## Today\n\n- [ ] New\n- [ ] A\n')).toBe(true);
  });
  it('EOF append after an unterminated line: a LF/CRLF tie resolves to LF; the new final line is unterminated', () => {
    // 5 LF lines and 5 CRLF lines: a genuine tie.
    const settings = '%% kanban:settings\r\n```\r\n{"new-card-insertion-method":"append"}\r\n```\r\n%%\r\n';
    const content = '## Archive\n- [ ] old\n- [ ] older\n' + settings + '## Today\n- [ ] A\n- [ ] B';
    const out = insertCard('New', 'Today', content);
    expect(out).toBe('## Archive\n- [ ] old\n- [ ] older\n' + settings + '## Today\n- [ ] A\n- [ ] B\n- [ ] New');
    expect(out.endsWith('\n')).toBe(false);
  });
  it('EOF append in a CRLF-dominant file gains \\r\\n on the previously unterminated line', () => {
    const settings = '%% kanban:settings\r\n```\r\n{"new-card-insertion-method":"append"}\r\n```\r\n%%\r\n';
    const content = '## Archive\r\n- [ ] old\r\n' + settings + '## Today\r\n- [ ] A\r\n- [ ] B';
    expect(insertCard('New', 'Today', content)).toBe('## Archive\r\n- [ ] old\r\n' + settings + '## Today\r\n- [ ] A\r\n- [ ] B\r\n- [ ] New');
  });
  it('the empty-section rule skips exactly ONE blank line, however many follow', () => {
    expect(insertCard('New', 'Today', '## Today\n\n\n\n## Done\n- [ ] x\n')).toBe('## Today\n\n- [ ] New\n\n\n## Done\n- [ ] x\n');
  });
  it('every inserted line takes the terminator before the insert point (CRLF, multiline)', () => {
    expect(insertCard('One\nTwo', 'Today', '## Today\r\n- [ ] A\r\n')).toBe('## Today\r\n- [ ] One\r\n  Two\r\n- [ ] A\r\n');
  });
  it('a bare %% line ends a section even without a settings opener', () => {
    expect(insertCard('New', 'Today', '## Today\n- [ ] A\n%%\n- [ ] B\n')).toBe('## Today\n- [ ] New\n- [ ] A\n%%\n- [ ] B\n');
  });
});

describe('line model', () => {
  it('preserves terminators', () => {
    const lines = splitLines('a\r\nb\nc');
    expect(lines).toEqual([{ text: 'a', term: '\r\n' }, { text: 'b', term: '\n' }, { text: 'c', term: '' }]);
    expect(render(lines)).toBe('a\r\nb\nc');
  });
  it('a trailing newline makes no extra empty line', () => { expect(splitLines('a\n')).toEqual([{ text: 'a', term: '\n' }]); });
  it('a lone \\r is ordinary content', () => { expect(splitLines('a\rb\n')).toEqual([{ text: 'a\rb', term: '\n' }]); });
  it('an empty file has no lines', () => { expect(splitLines('')).toEqual([]); });
});
