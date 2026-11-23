// Port of the MuleSoft HTMLToMarkdown.swift: ordered regex passes for the
// tag set in MuleSoft's Antora release-notes pages (the Workato set plus
// Antora permalink anchors, headings and compatibility tables). Entity
// decoding runs LAST so an encoded &lt; can never become a fake tag.

const NAMED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'], // first: every other entity contains "&"
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#039;', "'"],
  ['&nbsp;', ' '],
  ['&hellip;', '…'],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&lsquo;', '‘'],
  ['&rsquo;', '’'],
  ['&ldquo;', '“'],
  ['&rdquo;', '”'],
];

export function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, replacement] of NAMED_ENTITIES) result = result.split(entity).join(replacement);
  // Generic numeric: &#8217; / &#038;
  return result.replace(/&#(\d+);/g, (whole, digits: string) => {
    const code = Number(digits);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** Tags stripped, entities decoded, trimmed: link text and headings. */
export function decodeAndStrip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
}

/** One table → "cell | cell" lines (compatibility matrices keep their
 *  information without pretending to be Markdown tables). */
function convertTable(table: string): string {
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/g) ?? [];
  return rows.map(row => (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g) ?? [])
    .map(cell => cell.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(c => c !== ''))
    .filter(cells => cells.length > 0)
    .map(cells => cells.join(' | '))
    .join('\n');
}

export function htmlToMarkdown(html: string): string {
  let text = html;
  // 0. Antora permalink anchors carry no text: drop them before pass 2 makes empty links.
  text = text.replace(/<a\b[^>]*class="anchor"[^>]*>\s*<\/a>/g, '');
  // 1. Tables as whole blocks (they don't nest here), so the paragraph pass can't shred a row.
  text = text.replace(/<table\b[\s\S]*?<\/table>/g, t => `\n\n${convertTable(t)}\n\n`);
  // 2. Anchors → [text](href), before any tag stripping.
  text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href: string, inner: string) => `[${inner}](${href})`);
  // 3. Emphasis.
  text = text.replace(/<\/?(?:b|strong)\b[^>]*>/g, '**');
  text = text.replace(/<\/?(?:i|em)\b[^>]*>/g, '*');
  // 4. List items → "- " lines; list containers drop.
  text = text.replace(/<li\b[^>]*>/g, '\n- ');
  text = text.replace(/<\/?(?:ul|ol)\b[^>]*>/g, '\n');
  text = text.replace(/<\/li>/g, '');
  // 5. Block boundaries; headings become plain lines.
  text = text.replace(/<br\b[^>]*\/?>/g, '\n');
  text = text.replace(/<\/?(?:h[1-6])\b[^>]*>/g, '\n\n');
  text = text.replace(/<\/(?:p|div|pre)>/g, '\n\n');
  text = text.replace(/<(?:p|div|pre)\b[^>]*>/g, '');
  // 6. Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, '');
  // 7. Entities, after tag handling.
  text = decodeEntities(text);
  // 8. Whitespace. A dash alone on its line (Antora puts a newline between
  //    <li> and its <p>) pulls the text up, before the trailing-space strip
  //    eats the space; then blank lines between dash items tighten up.
  text = text.replace(/\n-[ \t]*\n/g, '\n- ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/(?<=\n- [^\n]{0,1000})\n\n(?=- )/g, '\n');
  return text.trim();
}
