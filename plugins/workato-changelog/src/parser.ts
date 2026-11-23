// Port of ChangelogHTMLParser.swift: page HTML → entries. Pure, no I/O.
// Split the page on the post marker (each post runs to the next marker),
// then extract each field with a per-field regex, except the desc body,
// whose nested divs need a depth scan. A post whose date or title won't
// parse is SKIPPED, never fabricated.
import crypto from 'node:crypto';
import type { ChangelogEntry } from './model.js';
import { parseEntryDate, quarterKey } from './model.js';
import { decodeEntities, htmlToMarkdown } from './html-to-markdown.js';

export function parse(html: string): ChangelogEntry[] {
  return postSlices(html).map(entryFrom).filter((e): e is ChangelogEntry => e !== null);
}

export function postSlices(html: string): string[] {
  const marker = /<div class="[^"]*\bworkato-changelog-post\b[^"]*">/g;
  const starts = [...html.matchAll(marker)].map(m => m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

function entryFrom(slice: string): ChangelogEntry | null {
  const dateText = capture(/class="[^"]*\bworkato-changelog-date\b[^"]*">\s*([\s\S]*?)\s*<\/div>/, slice);
  const date = dateText === null ? null : parseEntryDate(decodeAndStrip(dateText));
  if (!date) return null;
  const rawTitle = capture(/class="workato-changelog-title">\s*([\s\S]*?)\s*<\/h3>/, slice);
  if (rawTitle === null) return null;
  const title = decodeAndStrip(rawTitle);
  if (!title) return null;
  const badgeRaw = capture(/class="workato-changelog-quarter">\s*([\s\S]*?)\s*<\/span>/, slice);
  const bodyHTML = descSlice(slice) ?? '';
  return {
    fingerprint: fingerprint(date, title),
    date,
    quarterKey: quarterKey(date),
    title,
    categories: categoriesFrom(slice),
    badge: badgeRaw === null ? '' : decodeAndStrip(badgeRaw),
    bodyMarkdown: htmlToMarkdown(bodyHTML),
    bodyHTML,
  };
}

/** Category labels from the terms block (0..n anchors, page order). */
function categoriesFrom(slice: string): string[] {
  const block = capture(/class="[^"]*\bworkato-changelog-terms\b[^"]*">([\s\S]*?)<\/div>/, slice);
  if (block === null) return [];
  return [...block.matchAll(/<a\b[^>]*class="[^"]*workato-changelog-term[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/g)]
    .map(m => decodeAndStrip(m[1] ?? ''))
    .filter(Boolean);
}

/** The desc body can't be a regex (nested divs): find the open tag, then
 *  depth-scan (`<div` +1, `</div>` −1) until depth is 0. A never-closed body
 *  (malformed page) falls back to the rest of the slice. */
export function descSlice(slice: string): string | null {
  const cls = slice.indexOf('class="workato-changelog-desc"');
  if (cls < 0) return null;
  const openEnd = slice.indexOf('>', cls + 'class="workato-changelog-desc"'.length);
  if (openEnd < 0) return null;
  const start = openEnd + 1;
  let depth = 1;
  let i = start;
  while (i < slice.length) {
    if (slice.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) return slice.slice(start, i);
      i += 6;
    } else if (slice.startsWith('<div', i) && !/[\p{L}\p{N}]/u.test(slice[i + 4] ?? ' ')) {
      depth++;
      i += 4;
    } else {
      i++;
    }
  }
  return slice.slice(start);
}

/** sha256("YYYY-MM-DD|title lowercased with whitespace collapsed"), lowercase hex.
 *  Must match the Swift plugin byte for byte: the imported database is keyed on it. */
export function fingerprint(date: string, title: string): string {
  const normalized = title.toLowerCase().split(/\s+/u).filter(Boolean).join(' ');
  return crypto.createHash('sha256').update(`${date}|${normalized}`, 'utf8').digest('hex');
}

function decodeAndStrip(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
}

function capture(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
}
