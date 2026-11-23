// Port of WorkatoModels.swift. Dates are calendar days kept as "YYYY-MM-DD"
// strings (the storage form), so no time zone can shift a day.

export interface WorkatoConfig {
  /** Absolute path of the vault folder the quarter notes are written into. */
  readonly vaultFolder: string;
  /** Safety cap on pages fetched in one run (the archive is ~68 pages). */
  readonly maxPages: number;
}
export const isComplete = (c: WorkatoConfig): boolean => c.vaultFolder !== '';

export interface ChangelogEntry {
  /** Dedup key: sha256 of "YYYY-MM-DD|normalized title" (no per-post permalinks). */
  readonly fingerprint: string;
  /** "2026-11-03". */
  readonly date: string;
  /** "2026-Q4": the quarter note this entry renders into. */
  readonly quarterKey: string;
  readonly title: string;
  readonly categories: readonly string[];
  /** Badge text, e.g. "Released"; empty when the post has none. */
  readonly badge: string;
  readonly bodyMarkdown: string;
  /** Raw source HTML, kept so a later converter can re-render without re-scraping. */
  readonly bodyHTML: string;
}

export interface ScrapeSummary {
  readonly pagesFetched: number;
  readonly entriesNew: number;
  readonly entriesTotal: number;
  /** Quarter notes (re)written this run, sorted. */
  readonly quartersWritten: readonly string[];
  /** True when the walk reached the end of the archive (empty page or 404). */
  readonly reachedEndOfHistory: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 3, 2026" (the page's "MMM d, yyyy") → "2026-11-03", or null. */
export function parseEntryDate(text: string): string | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month === 0 || day < 1 || day > new Date(year, month, 0).getDate()) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "2026-11-03" → "Nov 3, 2026". */
export function formatEntryDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

/** "2026-Q4" for the calendar quarter containing the day. */
export function quarterKey(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor(((m ?? 1) - 1) / 3) + 1}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hour12 = (h: number) => ((h + 11) % 12) + 1;

/** "MMM d, yyyy, h:mm a" in local time (the note's "Generated" line). */
export function formatGenerated(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hour12(d.getHours())}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** "MMM d, h:mm a" in local time (menu and status lines). */
export function formatStatusTime(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hour12(d.getHours())}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
