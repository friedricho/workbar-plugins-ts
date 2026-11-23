// Port of MuleSoftModels.swift. Dates are calendar days kept as "YYYY-MM-DD"
// strings (the storage form), so no time zone can shift a day, and they
// compare correctly as strings.

export interface MuleSoftConfig {
  /** Absolute path of the vault folder the quarter notes are written into. */
  readonly vaultFolder: string;
  /** Safety cap on product pages fetched in one run (the backfill needs ~360). */
  readonly maxProductPages: number;
  /** Oldest entry date the history walk keeps ("YYYY-MM-DD"), or null to
   *  disable the walk. It gates insertion only: stored entries are never deleted. */
  readonly historyStart?: string | null;
  /** Safety cap on history-walk page fetches in one run. */
  readonly maxHistoryPages?: number;
}
export const isComplete = (c: MuleSoftConfig): boolean => c.vaultFolder !== '';

/** One release-notes entry. `fingerprint` (sha256 of date + normalized title)
 *  is the dedup key; `pageURL` + `anchor` are the source reference. */
export interface ReleaseEntry {
  readonly fingerprint: string;
  /** "2026-11-10". */
  readonly date: string;
  /** "2026-Q4": the quarter note this entry renders into. */
  readonly quarterKey: string;
  /** The title minus a trailing version ("EDIFACT EDI Connector 3.0.1" → "EDIFACT EDI Connector"). */
  readonly product: string;
  readonly title: string;
  /** Absolute URL of the product/release page (no fragment). */
  readonly pageURL: string;
  /** Fragment into the page ("3-0-1", "november-9-2026"), or "" for a whole dedicated release page. */
  readonly anchor: string;
  readonly bodyMarkdown: string;
  /** Raw source HTML, kept so a later converter can re-render without re-scraping. */
  readonly bodyHTML: string;
}

export interface ScrapeSummary {
  /** Product pages fetched by the index phase (the index itself is not counted). */
  readonly pagesFetched: number;
  /** Pages that failed (network/404); retried on the next run. */
  readonly pagesFailed: number;
  readonly entriesNew: number;
  readonly entriesTotal: number;
  /** Quarter notes (re)written this run, sorted. */
  readonly quartersWritten: readonly string[];
  /** True when every unknown entry's page was attempted (not cut off by the cap). */
  readonly indexFullyProcessed: boolean;
  /** Pages fetched by the history walk (fold-ins are not counted). */
  readonly historyPagesFetched: number;
  /** Entries inserted by the history phase (fold-in + walk). */
  readonly historyEntriesNew: number;
}

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = LONG_MONTHS.map(m => m.slice(0, 3));
const pad = (n: number) => String(n).padStart(2, '0');

/** "November 10, 2026" ("MMMM d, yyyy", strict) → "2026-11-10", or null. */
export function parseLongDate(text: string): string | null {
  const m = /^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  if (!m) return null;
  const month = LONG_MONTHS.indexOf(m[1]!) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month === 0 || day < 1 || day > new Date(year, month, 0).getDate()) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** "2026-11-10" → "Nov 10, 2026". */
export function formatEntryDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${SHORT_MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}

/** "2026-Q4" for the calendar quarter containing the day. */
export function quarterKey(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor(((m ?? 1) - 1) / 3) + 1}`;
}

/** "MMM d, yyyy, h:mm a" (the note's "Generated" line), local time unless a time zone is given. */
export function formatGenerated(d: Date, timeZone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toUpperCase()}`;
}

const hour12 = (h: number) => ((h + 11) % 12) + 1;

/** "MMM d, h:mm a" in local time (menu and status lines). */
export function formatStatusTime(d: Date): string {
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}, ${hour12(d.getHours())}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
