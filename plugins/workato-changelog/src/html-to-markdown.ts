// Port of HTMLToMarkdown.swift: ordered regex passes for the limited tag set
// in Workato changelog bodies. Entity decoding runs LAST so an encoded &lt;
// can never become a fake tag mid-pipeline.

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

export function htmlToMarkdown(html: string): string {
  let text = html;
  // 1. Anchors → [text](href), before any tag stripping (pass 5 strips tags inside link text).
  text = text.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href: string, inner: string) => `[${inner}](${href})`);
  // 2. Emphasis.
  text = text.replace(/<\/?(?:b|strong)\b[^>]*>/g, '**');
  text = text.replace(/<\/?(?:i|em)\b[^>]*>/g, '*');
  // 3. List items → "- " lines; list containers drop.
  text = text.replace(/<li\b[^>]*>/g, '\n- ');
  text = text.replace(/<\/?(?:ul|ol)\b[^>]*>/g, '\n');
  text = text.replace(/<\/li>/g, '');
  // 4. Block boundaries.
  text = text.replace(/<br\b[^>]*\/?>/g, '\n');
  text = text.replace(/<\/(?:p|div)>/g, '\n\n');
  text = text.replace(/<(?:p|div)\b[^>]*>/g, '');
  // 5. Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, '');
  // 6. Entities, after tag handling.
  text = decodeEntities(text);
  // 7. Whitespace.
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
