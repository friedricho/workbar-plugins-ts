// Ports of IndexHTMLParser, ReleaseSectionParser, HistorySectionParser and
// DiscoveryParser (Swift). Pure, no I/O. Fixture-verified against the fixed
// Antora template docs.mulesoft.com uses.
import crypto from 'node:crypto';
import { decodeAndStrip, htmlToMarkdown } from './html-to-markdown.js';
import { parseLongDate, quarterKey, type ReleaseEntry } from './model.js';

export const INDEX_URL = 'https://docs.mulesoft.com/release-notes/quick-refs/by-date-index';
/** The by-product index: the history walk's discovery seed. */
export const HOME_URL = 'https://docs.mulesoft.com/release-notes/';
/** Discovery keeps only links under this root (the home page also links out, e.g. ../composer/…). */
export const RELEASE_NOTES_ROOT = 'https://docs.mulesoft.com/release-notes/';

// ---- Index ----------------------------------------------------------------

/** The `<article class="doc ">` content: the LAST article match on the page
 *  (earlier ones are mega-menu chrome). */
export function docArticle(html: string): string | null {
  const matches = [...html.matchAll(/<article class="doc[^"]*">([\s\S]*?)<\/article>/g)];
  return matches.at(-1)?.[1] ?? null;
}

/** Dedup identity: sha256 of "YYYY-MM-DD|normalized title", lowercase hex. */
export function fingerprint(date: string, title: string): string {
  const normalized = title.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  return crypto.createHash('sha256').update(`${date}|${normalized}`, 'utf8').digest('hex');
}

/** "EDIFACT EDI Connector 3.0.1" → "EDIFACT EDI Connector"; a title with no
 *  trailing dotted version is its own product. */
export function productName(title: string): string {
  const m = /\s+\d+(?:\.\d+)+[A-Za-z.-]*$/.exec(title);
  return m ? title.slice(0, m.index).trim() : title;
}

/** The by-date index → entries with empty bodies (the runner fills them).
 *  Month h2 sections set the year, day markers set the day, and each
 *  `class="xref page"` link is one entry. Unparseable dates are skipped,
 *  never fabricated. */
export function parseIndex(html: string): ReleaseEntry[] {
  const article = docArticle(html);
  if (article === null) return [];
  const headings = [...article.matchAll(/<h2[^>]*>(?:<a\b[^>]*>\s*<\/a>)?\s*([A-Z][a-z]+)\s+(\d{4})\s*<\/h2>/g)];
  const entries: ReleaseEntry[] = [];
  headings.forEach((h, i) => {
    const year = h[2]!;
    const start = h.index! + h[0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : article.length;
    const section = article.slice(start, end);
    let currentDay = '';
    for (const m of section.matchAll(/<div class="paragraph">\s*<p>([A-Z][a-z]+ \d{1,2})<\/p>|<a href="(\.\.\/[^"]+)" class="xref page">([\s\S]*?)<\/a>/g)) {
      if (m[1] !== undefined) { currentDay = m[1]; continue; }
      if (!currentDay) continue; // a link before any day marker
      const title = decodeAndStrip(m[3]!);
      const date = parseLongDate(`${currentDay}, ${year}`);
      if (!title || !date) continue;
      const [pagePart, anchor = ''] = splitOnce(m[2]!, '#');
      let pageURL: string;
      try { pageURL = new URL(pagePart, INDEX_URL).href; } catch { continue; }
      entries.push({
        fingerprint: fingerprint(date, title), date, quarterKey: quarterKey(date),
        product: productName(title), title, pageURL, anchor, bodyMarkdown: '', bodyHTML: '',
      });
    }
  });
  return entries;
}

function splitOnce(s: string, sep: string): [string, string?] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutH1 = (article: string) => article.replace(/<h1\b[\s\S]*?<\/h1>/g, '');

// ---- One entry's section --------------------------------------------------

/** The entry's section from a product page: `<h2 id="anchor">` up to the next
 *  `<h2` (the h2 itself consumed), or for an empty anchor the whole dedicated
 *  release page minus its h1. Null when the anchor is missing (template drift). */
export function extractSection(html: string, anchor: string): { markdown: string; html: string } | null {
  const article = docArticle(html);
  if (article === null) return null;
  if (anchor === '') {
    const body = withoutH1(article);
    return { markdown: htmlToMarkdown(body), html: body };
  }
  const m = new RegExp(`<h2 id="${escapeRegex(anchor)}"[^>]*>[\\s\\S]*?</h2>`).exec(article);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /<h2\b/.exec(article.slice(start));
  const section = article.slice(start, next ? start + next.index : article.length);
  return { markdown: htmlToMarkdown(section), html: section };
}

// ---- Every dated section (history walk) -----------------------------------

export interface HistorySection {
  readonly anchor: string;
  readonly date: string;
  readonly title: string;
  readonly markdown: string;
  readonly html: string;
}

const MONTH_NAMES = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);

function firstStrongDate(body: string): string | null {
  const m = /<strong>([A-Z][a-z]+ \d{1,2}, \d{4})<\/strong>/.exec(body);
  return m ? parseLongDate(m[1]!) : null;
}

/** `month-day-year` ("november-9-2026") or, without day precision,
 *  `month-year` ("july-2026") → the 1st. The month must be a real month name. */
function anchorDate(anchor: string, dayPrecision: boolean): string | null {
  const m = (dayPrecision ? /^([a-z]+)-(\d{1,2})-(\d{4})$/ : /^([a-z]+)-(\d{4})$/).exec(anchor);
  if (!m || !MONTH_NAMES.has(m[1]!)) return null;
  const month = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  const day = dayPrecision ? m[2]! : '1';
  const year = dayPrecision ? m[3]! : m[2]!;
  return parseLongDate(`${month} ${day}, ${year}`);
}

/** Every `<h2 id>` section dated `earliest` or later, in document order, plus
 *  the count of sections skipped for carrying no date. Date attribution:
 *  (a) the first `<strong>Month D, YYYY</strong>` → versioned title
 *  "Product 3.0.1" (identical to the index title, so fingerprints dedup);
 *  (b) a `month-day-year` anchor; (c) a `month-year` anchor → the 1st;
 *  (d) otherwise skipped. A page with exactly one dated section is a
 *  dedicated release page: its body is the whole article minus the h1. */
export function extractHistory(html: string, product: string, earliest: string): { sections: HistorySection[]; undated: number } {
  const article = docArticle(html);
  if (article === null) return { sections: [], undated: 0 };
  const headings = [...article.matchAll(/<h2 id="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/g)];
  const raw = headings.map((h, i) => {
    const start = h.index! + h[0].length;
    const end = i + 1 < headings.length ? headings[i + 1]!.index! : article.length;
    return { anchor: h[1]!, heading: decodeAndStrip(h[2]!), body: article.slice(start, end) };
  });
  const dated: Array<{ section: typeof raw[number]; date: string; versioned: boolean }> = [];
  let undated = 0;
  for (const section of raw) {
    const strong = firstStrongDate(section.body);
    const day = strong ? null : anchorDate(section.anchor, true);
    const month = strong || day ? null : anchorDate(section.anchor, false);
    const date = strong ?? day ?? month;
    if (date) dated.push({ section, date, versioned: strong !== null });
    else undated++;
  }
  const wholePage = dated.length === 1 ? withoutH1(article) : null;
  const sections: HistorySection[] = [];
  for (const { section, date, versioned } of dated) {
    if (date < earliest) continue; // the cutoff gates insertion
    const title = product === '' ? section.heading : versioned ? `${product} ${section.heading}` : `${product} — ${section.heading}`;
    const body = wholePage ?? section.body;
    sections.push({ anchor: section.anchor, date, title, markdown: htmlToMarkdown(body), html: body });
  }
  return { sections, undated };
}

/** "EDIFACT EDI Connector Release Notes" → "EDIFACT EDI Connector": the
 *  product name for a page with no stored entries. Null without an h1. */
export function derivedProduct(html: string): string | null {
  const article = docArticle(html);
  const m = article === null ? null : /<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(article);
  if (!m) return null;
  let name = decodeAndStrip(m[1]!);
  if (name.endsWith(' Release Notes')) name = name.slice(0, -' Release Notes'.length);
  return name === '' ? null : name;
}

// ---- Discovery ------------------------------------------------------------

/** Product-page links in a page's doc article, resolved against the page's
 *  URL, kept only under the release-notes root; fragments stripped,
 *  duplicates collapsed, order preserved. */
export function discoverPageLinks(html: string, pageURL: string): string[] {
  const article = docArticle(html);
  if (article === null) return [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const m of article.matchAll(/<a href="([^"]+)" class="xref page">/g)) {
    let resolved: URL;
    try { resolved = new URL(m[1]!, pageURL); } catch { continue; }
    resolved.hash = '';
    const stripped = resolved.href;
    if (!stripped.startsWith(RELEASE_NOTES_ROOT) || seen.has(stripped)) continue;
    seen.add(stripped);
    links.push(stripped);
  }
  return links;
}
