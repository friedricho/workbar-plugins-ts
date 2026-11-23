// Ported from HTMLToMarkdownTests, IndexHTMLParserTests,
// ReleaseSectionParserTests, HistorySectionParserTests, DiscoveryParserTests
// and ChangelogNoteRendererTests. Counts are pinned from the live-captured
// fixtures so template drift fails loudly.
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/html-to-markdown.js';
import { derivedProduct, discoverPageLinks, extractHistory, extractSection, fingerprint, HOME_URL, parseIndex, productName, RELEASE_NOTES_ROOT } from '../src/parsers.js';
import { renderNote } from '../src/renderer.js';
import { fixture, makeEntry } from './support.js';

describe('htmlToMarkdown', () => {
  it('anchors become markdown links', () => {
    expect(htmlToMarkdown('<p>See <a href="https://x.test/docs">the docs</a> now</p>')).toBe('See [the docs](https://x.test/docs) now');
  });
  it('Antora permalink anchors leave no empty link behind', () => {
    expect(htmlToMarkdown('<h2 id="3-0-1"><a class="anchor" href="#3-0-1"></a>3.0.1</h2>')).toBe('3.0.1');
  });
  it('emphasis and list items', () => {
    expect(htmlToMarkdown('<ul><li><p><strong>Bold</strong> one</p></li><li><p><em>Two</em></p></li></ul>')).toBe('- **Bold** one\n- *Two*');
  });
  it('headings become plain lines, not glued to neighbors', () => {
    expect(htmlToMarkdown('<h3 id="whats-new" class="discrete">What&#8217;s New</h3><div class="ulist"><ul><li><p>Thing.</p></li></ul></div>')).toBe('What’s New\n\n- Thing.');
  });
  it('a table becomes one line per row with pipe-joined cells', () => {
    const html = `<table class="tableblock">
<colgroup><col><col></colgroup>
<thead><tr><th class="tableblock">Software</th><th class="tableblock">Version</th></tr></thead>
<tbody>
<tr><td class="tableblock"><p class="tableblock">Mule runtime engine</p></td>
<td class="tableblock"><p class="tableblock">4.6.0 and later</p></td></tr>
</tbody>
</table>`;
    expect(htmlToMarkdown(html)).toBe('Software | Version\nMule runtime engine | 4.6.0 and later');
  });
  it('a newline between <li> and its <p> doesn’t orphan the dash', () => {
    expect(htmlToMarkdown('<ul><li>\n<p>First.</p></li><li>\n<p>Second.</p></li></ul>')).toBe('- First.\n- Second.');
  });
  it('entities decode after tag stripping', () => {
    expect(htmlToMarkdown('<p>Resources &#038; XML &lt;streaming&gt;</p>')).toBe('Resources & XML <streaming>');
  });
  it('nested divs collapse to paragraphs; blank runs collapse', () => {
    expect(htmlToMarkdown('<div><div><p>One</p></div><div><p>Two</p></div></div>')).toBe('One\n\nTwo');
  });
});

describe('index parser', () => {
  const entries = parseIndex(fixture('by-date-index.html'));

  it('parses every entry from the real index', () => {
    expect(entries).toHaveLength(1324);
    expect(new Set(entries.map(e => e.fingerprint)).size).toBe(1324);
  });
  it('first entry: exact fields, resolved URL, versioned product', () => {
    expect(entries[0]).toEqual({
      fingerprint: fingerprint('2026-11-10', 'EDIFACT EDI Connector 3.0.1'),
      date: '2026-11-10', quarterKey: '2026-Q4', product: 'EDIFACT EDI Connector', title: 'EDIFACT EDI Connector 3.0.1',
      pageURL: 'https://docs.mulesoft.com/release-notes/connector/edifact-edi-connector-release-notes', anchor: '3-0-1',
      bodyMarkdown: '', bodyHTML: '',
    });
  });
  it('last entry is in the oldest month section (year attribution)', () => {
    const last = entries.at(-1)!;
    expect(last.title).toBe('Mule runtime engine patch update for Runtime Fabric');
    expect(last.product).toBe(last.title);
    expect(last.date).toBe('2025-09-02');
    expect(last.quarterKey).toBe('2025-Q3');
    expect(last.anchor).toBe('september-2-2025');
  });
  it('entries without a fragment link a whole dedicated release page', () => {
    const noAnchor = entries.filter(e => e.anchor === '');
    expect(noAnchor).toHaveLength(184);
    const maven = noAnchor.find(e => e.title === 'Mule Maven Plugin 4.10.4')!;
    expect(maven.product).toBe('Mule Maven Plugin');
    expect(maven.pageURL).toBe('https://docs.mulesoft.com/release-notes/mule-maven-plugin/mule-maven-plugin-4.10.4-release-notes');
    expect(maven.date).toBe('2026-11-04');
  });
  it('productName strips a trailing dotted version only', () => {
    expect(productName('EDIFACT EDI Connector 3.0.1')).toBe('EDIFACT EDI Connector');
    expect(productName('Anypoint Exchange')).toBe('Anypoint Exchange');
    expect(productName('Mule Maven Plugin 4.10.4')).toBe('Mule Maven Plugin');
  });
  it('an anchor before any day marker is skipped, never fabricated', () => {
    const html = `<article class="doc ">
<h2 id="november-2026"><a class="anchor" href="#november-2026"></a>November 2026</h2>
<div class="ulist"><ul><li>
<p><a href="../connector/a-release-notes#1-0-0" class="xref page">Connector A 1.0.0</a></p>
</li></ul></div>
<div class="paragraph">
<p>November 10</p>
</div>
<div class="ulist"><ul><li>
<p><a href="../connector/b-release-notes#2-0-0" class="xref page">Connector B 2.0.0</a></p>
</li></ul></div>
</article>`;
    expect(parseIndex(html).map(e => e.title)).toEqual(['Connector B 2.0.0']);
  });
  it('a day marker that won’t parse skips its entries', () => {
    const html = `<article class="doc ">
<h2 id="november-2026">November 2026</h2>
<div class="paragraph">
<p>November 40</p>
</div>
<div class="ulist"><ul><li>
<p><a href="../connector/a-release-notes#1-0-0" class="xref page">Connector A 1.0.0</a></p>
</li></ul></div>
</article>`;
    expect(parseIndex(html)).toEqual([]);
  });
  it('nav chrome and non-xref links are excluded', () => {
    expect(entries.some(e => e.title === 'Homepage')).toBe(false);
    expect(entries.every(e => e.pageURL.startsWith('https://docs.mulesoft.com/release-notes/'))).toBe(true);
  });
  it('fingerprints match the Swift values (sha256 of "date|normalized title")', () => {
    // Computed independently: printf '2026-11-10|edifact edi connector 3.0.1' | sha256sum
    const expected = '29b4fb11414be2d849931df13d4814bb298e988c0a25f4c2e8d81bddc9cedb60';
    expect(fingerprint('2026-11-10', 'EDIFACT EDI Connector 3.0.1')).toBe(expected);
    expect(fingerprint('2026-11-10', '  EDIFACT   EDI\nConnector 3.0.1 ')).toBe(expected);
  });
});

describe('release section parser', () => {
  it('version-anchored section: body converted, table kept, extent stops at the next h2', () => {
    const s = extractSection(fixture('product-versioned.html'), '3-0-1')!;
    expect(s.markdown).toContain('security fixes');
    expect(s.markdown.startsWith('>')).toBe(false);
    expect(s.markdown).not.toContain('3.0.1\n');
    expect(s.markdown).toContain('Mule runtime engine | 4.6.0 and later');
    expect(s.markdown).not.toContain('October');
    expect(s.markdown).not.toContain('[](#');
    expect(s.html).not.toBe('');
  });
  it('date-anchored section: body converted, extent stops at the next date', () => {
    const s = extractSection(fixture('product-dated.html'), 'november-9-2026')!;
    expect(s.markdown).toContain('scanner to discover');
    expect(s.markdown).toContain('[Adding a Scanner for Microsoft 365 Copilot]');
    expect(s.markdown).not.toContain('October 21');
  });
  it('an empty anchor takes the whole dedicated release page minus its h1', () => {
    const s = extractSection(fixture('release-page.html'), '')!;
    expect(s.markdown).toContain('November 4, 2026');
    expect(s.markdown).toContain('What’s New');
    expect(s.markdown).not.toContain('Mule Maven Plugin 4.10.4 Release Notes');
  });
  it('a missing anchor returns null (template drift: the caller tolerates)', () => {
    expect(extractSection(fixture('product-versioned.html'), '9-9-9')).toBeNull();
  });
});

describe('history section parser', () => {
  const edifact = fixture('product-versioned.html');
  const exchange = fixture('product-dated.html');
  const maven = fixture('release-page.html');

  it('version-anchored page: every strong-dated h2 yields a section, the cutoff drops 2018', () => {
    const { sections, undated } = extractHistory(edifact, 'EDIFACT EDI Connector', '2019-01-01');
    expect(sections).toHaveLength(24);
    expect(undated).toBe(1);
    expect(sections[0]).toMatchObject({ anchor: '3-0-1', title: 'EDIFACT EDI Connector 3.0.1', date: '2026-11-10' });
    expect(sections[0]!.markdown).toContain('security fixes');
    expect(sections.at(-1)).toMatchObject({ anchor: '2-1-0', title: 'EDIFACT EDI Connector 2.1.0', date: '2020-04-20' });
  });
  it('a later cutoff drops more sections', () => {
    const { sections } = extractHistory(edifact, 'EDIFACT EDI Connector', '2021-01-01');
    expect(sections).toHaveLength(19);
    expect(sections.some(s => s.title === 'EDIFACT EDI Connector 2.1.0')).toBe(false);
  });
  it('date-anchored and month-anchored h2s attribute from the anchor', () => {
    const { sections, undated } = extractHistory(exchange, 'Anypoint Exchange', '2019-01-01');
    expect(sections).toHaveLength(66);
    expect(undated).toBe(13);
    expect(sections.find(s => s.anchor === 'november-9-2026')).toMatchObject({ title: 'Anypoint Exchange — November 9, 2026', date: '2026-11-09' });
    const month = sections.find(s => s.anchor === 'july-2026')!;
    expect(month).toMatchObject({ title: 'Anypoint Exchange — July 2026', date: '2026-07-01' });
    expect(month.markdown).not.toBe('');
  });
  it('a dedicated single-release page yields one whole-page section', () => {
    const { sections } = extractHistory(maven, 'Mule Maven Plugin 4.10.4', '2019-01-01');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ anchor: 'november-4-2026', title: 'Mule Maven Plugin 4.10.4 — November 4, 2026' });
    expect(sections[0]!.markdown).toContain('November 4, 2026');
    expect(sections[0]!.markdown).toContain('What’s New');
    expect(sections[0]!.markdown).not.toContain('Mule Maven Plugin 4.10.4 Release Notes');
  });
  it('an h2 with no date anywhere is skipped, never fabricated', () => {
    const html = `<html><body>
<article class="doc ">
<h1>Some Product Release Notes</h1>
<h2 id="see-also">See Also</h2>
<div class="paragraph"><p>Links, no dates.</p></div>
</article>
</body></html>`;
    expect(extractHistory(html, 'Some Product', '2019-01-01')).toEqual({ sections: [], undated: 1 });
  });
  it('derivedProduct: the h1 minus a trailing " Release Notes"', () => {
    expect(derivedProduct(edifact)).toBe('EDIFACT EDI Connector');
    expect(derivedProduct(maven)).toBe('Mule Maven Plugin 4.10.4');
    expect(derivedProduct('<html></html>')).toBeNull();
  });
});

describe('discovery parser', () => {
  it('home lists the product pages, absolute, in-tree only', () => {
    const links = discoverPageLinks(fixture('discovery-home.html'), HOME_URL);
    expect(links).toHaveLength(53);
    expect(links.every(l => l.startsWith(RELEASE_NOTES_ROOT))).toBe(true);
    expect(links.some(l => l.includes('composer'))).toBe(false);
    expect(links.some(l => l.includes('#'))).toBe(false);
    expect(links[0]).toBe('https://docs.mulesoft.com/release-notes/accelerators/accelerators-release-notes');
  });
  it('the connectors landing lists its 168 child pages', () => {
    const links = discoverPageLinks(fixture('discovery-landing.html'), 'https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes');
    expect(links).toHaveLength(168);
    expect(links.every(l => l.startsWith(RELEASE_NOTES_ROOT))).toBe(true);
    expect(links[0]).toBe('https://docs.mulesoft.com/release-notes/connector/a2a-connector-release-notes-mule-4');
  });
  it('out-of-tree links are cut, fragments stripped, duplicates collapse', () => {
    const html = `<html><body>
<article class="doc ">
<div class="ulist"><ul>
<li><p><a href="../composer/ms-composer-release-notes" class="xref page">Composer</a></p></li>
<li><p><a href="https://other.test/x" class="xref page">Off-site</a></p></li>
<li><p><a href="gamma-release-notes#july-2026" class="xref page">Gamma</a></p></li>
<li><p><a href="gamma-release-notes" class="xref page">Gamma again</a></p></li>
<li><p><a href="delta-release-notes">No xref class</a></p></li>
</ul></div>
</article>
</body></html>`;
    expect(discoverPageLinks(html, HOME_URL)).toEqual(['https://docs.mulesoft.com/release-notes/gamma-release-notes']);
  });
});

describe('note renderer', () => {
  const now = new Date(1_800_000_000_000);

  it('header, banner and entry layout', () => {
    const note = renderNote('2026-Q4', [makeEntry({
      title: 'EDIFACT EDI Connector 3.0.1', pageURL: 'https://docs.mulesoft.com/release-notes/connector/edifact-edi-connector-release-notes',
      anchor: '3-0-1', bodyMarkdown: 'Includes security fixes.',
    })], now);
    expect(note.startsWith('# MuleSoft Release Notes — 2026 Q4\n')).toBe(true);
    expect(note).toContain('auto-generated from the WorkBar MuleSoftChangelog database — do not edit');
    expect(note).toContain('1 entries');
    expect(note).toContain('## EDIFACT EDI Connector 3.0.1\n');
    expect(note).toContain('_Nov 10, 2026 · EDIFACT EDI Connector · [source](https://docs.mulesoft.com/release-notes/connector/edifact-edi-connector-release-notes#3-0-1)_');
    expect(note).toContain('Includes security fixes.');
  });
  it('newest first, title as the same-day tiebreak, --- between entries', () => {
    const note = renderNote('2026-Q4', [
      makeEntry({ title: 'Older 1.0.0', date: '2026-10-01' }),
      makeEntry({ title: 'Beta 1.0.0', date: '2026-11-03' }),
      makeEntry({ title: 'Alpha 1.0.0', date: '2026-11-03' }),
    ], now);
    const at = (s: string) => note.indexOf(s);
    expect(at('## Alpha 1.0.0')).toBeLessThan(at('## Beta 1.0.0'));
    expect(at('## Beta 1.0.0')).toBeLessThan(at('## Older 1.0.0'));
    expect(note.split('\n---\n')).toHaveLength(3);
  });
  it('the product drops out of the metadata when it equals the title', () => {
    const note = renderNote('2025-Q3', [makeEntry({
      title: 'Mule runtime engine patch update for Runtime Fabric', date: '2025-09-02',
      pageURL: 'https://docs.mulesoft.com/release-notes/runtime-fabric/runtime-fabric-release-notes', anchor: 'september-2-2025',
    })], now);
    expect(note).toContain('_Sep 2, 2025 · [source](https://docs.mulesoft.com/release-notes/runtime-fabric/runtime-fabric-release-notes#september-2-2025)_');
  });
  it('a no-anchor entry links the page itself, not a dangling #', () => {
    const note = renderNote('2026-Q4', [makeEntry({
      title: 'Mule Maven Plugin 4.10.4', date: '2026-11-04',
      pageURL: 'https://docs.mulesoft.com/release-notes/mule-maven-plugin/mule-maven-plugin-4.10.4-release-notes', anchor: '',
    })], now);
    expect(note).toContain('[source](https://docs.mulesoft.com/release-notes/mule-maven-plugin/mule-maven-plugin-4.10.4-release-notes)');
    expect(note).not.toContain('release-notes#)');
  });
  it('an entry with no body renders header and metadata only', () => {
    const note = renderNote('2026-Q4', [makeEntry({ bodyMarkdown: '', bodyHTML: '' })], now);
    expect(note).toContain('## Sample Connector 1.2.3');
    expect(note).not.toContain('Body text');
  });
  it('the generated-at stamp follows the injected clock and time zone', () => {
    // 1_800_000_000 s = Jan 15, 2027 08:00 UTC.
    expect(renderNote('2026-Q4', [makeEntry()], now, 'UTC')).toContain('_Generated Jan 15, 2027, 8:00 AM ·');
  });
});
