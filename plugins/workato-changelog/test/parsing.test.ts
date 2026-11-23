// Ported from ChangelogHTMLParserTests, HTMLToMarkdownTests and ChangelogNoteRendererTests.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { descSlice, fingerprint, parse } from '../src/parser.js';
import { decodeEntities, htmlToMarkdown } from '../src/html-to-markdown.js';
import { renderNote } from '../src/renderer.js';
import { formatEntryDate, parseEntryDate, quarterKey, type ChangelogEntry } from '../src/model.js';
import { fixture } from './support.js';

describe('parser: page 1 fixture', () => {
  const entries = parse(fixture('changelog-page-1.html'));

  it('yields 10 entries with exact dates, titles, badges', () => {
    expect(entries).toHaveLength(10);
    expect(entries.map(e => formatEntryDate(e.date))).toEqual([
      'Nov 3, 2026', 'Oct 20, 2026', 'Oct 14, 2026', 'Oct 7, 2026', 'Oct 6, 2026',
      'Sep 30, 2026', 'Sep 18, 2026', 'Sep 9, 2026', 'Sep 9, 2026', 'Sep 8, 2026',
    ]);
    expect(entries[0]!.title).toBe('Community Connectors: What’s new in October 2026');
    expect(entries.every(e => e.badge === 'Released')).toBe(true);
  });
  it('a multi-category post keeps every label in page order', () => {
    const onPrem = entries.find(e => e.title === 'On-Prem Agent 33.1')!;
    expect(onPrem.categories).toEqual(['On-prem agent', 'SAP']);
    expect(onPrem.quarterKey).toBe('2026-Q4');
    expect(entries.find(e => e.title.startsWith('Native SOAP Services'))!.categories).toEqual(['API platform', 'Builder Experience']);
  });
  it('a post without a terms block has empty categories', () => {
    expect(entries[0]!.categories).toEqual([]);
  });
  it('entities in titles decode', () => {
    expect(entries[9]!.title).toBe('Native SOAP Services, Workato Resources & XML Streaming');
    expect(entries[9]!.quarterKey).toBe('2026-Q3');
  });
  it('bodies convert to markdown without template markup; the nested-div body survives', () => {
    for (const e of entries) {
      expect(e.bodyMarkdown).not.toBe('');
      expect(e.bodyHTML).not.toBe('');
      expect(e.bodyMarkdown).not.toContain('ui-markdown');
      expect(e.bodyMarkdown).not.toContain('</div>');
      expect(e.bodyMarkdown).not.toContain('<p');
    }
    expect(entries.find(e => e.title === 'API Platform: Shorter Authorization Tokens')!.bodyMarkdown).toContain('API Platform');
  });
  it('fingerprints are 64-char hex, unique, and normalize case and whitespace', () => {
    expect(new Set(entries.map(e => e.fingerprint)).size).toBe(entries.length);
    expect(entries.every(e => /^[0-9a-f]{64}$/.test(e.fingerprint))).toBe(true);
    expect(fingerprint('2026-11-03', 'On-Prem  Agent 33.1')).toBe(fingerprint('2026-11-03', 'on-prem agent 33.1'));
  });
  it('fingerprints use the Swift formula exactly (the imported database is keyed on them)', () => {
    const expected = crypto.createHash('sha256').update('2026-11-03|on-prem agent 33.1').digest('hex');
    expect(fingerprint('2026-11-03', '  On-Prem\n\tAgent   33.1 ')).toBe(expected);
  });
});

describe('parser: 2019 template and tolerance', () => {
  it('the deep fixture parses identically', () => {
    const entries = parse(fixture('changelog-page-deep.html'));
    expect(entries).toHaveLength(6);
    expect(entries[0]!.title).toBe('New Airtable connector');
    expect(entries[0]!.quarterKey).toBe('2019-Q2');
    const last = entries.at(-1)!;
    expect(last.title).toBe('Recipe lifecycle management automation with manifests and APIs');
    expect(last.categories).toEqual(['Operations']);
    expect(formatEntryDate(last.date)).toBe('Apr 28, 2019');
  });
  it('a post with an unparseable date is skipped, others survive', () => {
    const html = `
      <div class="workato-changelog-post">
        <div class="workato-changelog-date workato-changelog-meta">someday</div>
        <span class="workato-changelog-quarter">Released</span>
        <h3 class="workato-changelog-title">Broken</h3>
        <div class="workato-changelog-desc"><p>x</p></div>
      </div>
      <div class="workato-changelog-post">
        <div class="workato-changelog-date workato-changelog-meta">Jan 5, 2026</div>
        <span class="workato-changelog-quarter">Released</span>
        <h3 class="workato-changelog-title">Fine</h3>
        <div class="workato-changelog-desc"><p>y</p></div>
      </div>`;
    const entries = parse(html);
    expect(entries.map(e => [e.title, e.quarterKey])).toEqual([['Fine', '2026-Q1']]);
  });
  it('a page without posts yields nothing', () => {
    expect(parse('<html><body>No posts here</body></html>')).toEqual([]);
  });
  it('descSlice falls back to the rest of the slice when never closed', () => {
    expect(descSlice('<div class="workato-changelog-desc"><p>open<div>nested')).toBe('<p>open<div>nested');
  });
  it('dates: page format, impossible days rejected; quarters map months', () => {
    expect(parseEntryDate('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseEntryDate('Feb 30, 2026')).toBeNull();
    expect(parseEntryDate('November 3, 2026')).toBeNull();
    for (const [text, q] of [['Jan 1, 2026', '2026-Q1'], ['Mar 31, 2026', '2026-Q1'], ['Apr 1, 2026', '2026-Q2'], ['Jul 4, 2026', '2026-Q3'], ['Dec 31, 2026', '2026-Q4']] as const) {
      expect(quarterKey(parseEntryDate(text)!)).toBe(q);
    }
  });
});

describe('HTML to Markdown', () => {
  it.each([
    ['<p class="ui-markdown__paragraph ui-z80ra4">One</p><p>Two</p>', 'One\n\nTwo'],
    ['<a href="https://example.com" target="_blank">Ex</a>', '[Ex](https://example.com)'],
    ['<a href="https://x.test"><span>Inner</span></a>', '[Inner](https://x.test)'],
    ['<b>bold</b> and <strong>strong</strong> and <em>em</em>', '**bold** and **strong** and *em*'],
    ['<ul><li>a</li><li><b>b</b></li></ul>', '- a\n- **b**'],
    ['a<br>b', 'a\nb'],
    ['<div><div>inner</div></div>', 'inner'],
    ['Fish &amp; Chips &#8212; &#8220;q&#8221; &#038; more', 'Fish & Chips — “q” & more'],
    ['&lt;b&gt;not bold&lt;/b&gt;', '<b>not bold</b>'],
    ['<p>a</p>\n\n\n<p>b</p>', 'a\n\nb'],
  ])('%j → %j', (html, md) => {
    expect(htmlToMarkdown(html)).toBe(md);
  });
  it('decodes numeric entities', () => {
    expect(decodeEntities('a&#8217;b')).toBe('a’b');
    expect(decodeEntities('&#038;')).toBe('&');
  });
});

describe('note renderer', () => {
  const now = new Date(2026, 10, 12, 9, 41);
  const entry = (title: string, date = '2026-11-03', extra: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
    fingerprint: fingerprint(date, title), date, quarterKey: quarterKey(date), title, categories: [], badge: 'Released',
    bodyMarkdown: `${title} body.`, bodyHTML: '<p>x</p>', ...extra,
  });

  it('golden render: header, banner, entries newest-first with separators', () => {
    const note = renderNote('2026-Q4', [
      entry('Older entry', '2026-10-20', { categories: ['API platform'], bodyMarkdown: 'Older body.' }),
      entry('Newer entry', '2026-11-03', { categories: ['On-prem agent', 'SAP'], bodyMarkdown: 'Newer body.' }),
    ], now);
    expect(note).toBe([
      '# Workato Changelog — 2026 Q4',
      '',
      '_Generated Nov 12, 2026, 9:41 AM · 2 entries · auto-generated from the WorkBar WorkatoChangelog database — do not edit; this file is regenerated._',
      '',
      '## Newer entry',
      '',
      '_Nov 3, 2026 · Released · On-prem agent, SAP_',
      '',
      'Newer body.',
      '',
      '---',
      '',
      '## Older entry',
      '',
      '_Oct 20, 2026 · Released · API platform_',
      '',
      'Older body.',
      '',
    ].join('\n'));
  });
  it('same-day entries order by title', () => {
    const note = renderNote('2026-Q3', [entry('Zulu', '2026-09-09'), entry('Alpha', '2026-09-09')], now);
    expect(note.indexOf('## Alpha')).toBeLessThan(note.indexOf('## Zulu'));
  });
  it('missing badge and categories drop out of the metadata line', () => {
    const note = renderNote('2026-Q4', [entry('Bare', '2026-11-03', { badge: '' })], now);
    expect(note).toContain('_Nov 3, 2026_');
    expect(note).not.toContain('_Nov 3, 2026 ·');
  });
  it('an empty body leaves no trailing blank section', () => {
    expect(renderNote('2026-Q4', [entry('Bodiless', '2026-11-03', { bodyMarkdown: '' })], now).endsWith('_Nov 3, 2026 · Released_\n')).toBe(true);
  });
});
