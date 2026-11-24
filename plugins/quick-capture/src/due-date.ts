// Due-date tokens for the kanban board (port of the Swift DueDateFormatter / KanbanBoardSettings).
// obsidian-kanban stores a moment.js format string (`date-format`, the live board's is "MM-DD-YY") and a trigger glyph
// (`date-trigger`, default "@"); a due date is the token `@{11-14-26}`, and the board only shows a badge when the
// braced text is in exactly that format.
//
// Differences from Swift, by design:
//  * dates are civil values {year, month, day}: a due date has no time, so no time-zone arithmetic can shift it;
//  * the moment.js tokens are formatted directly. Swift had to translate them to ICU (an artifact of its
//    DateFormatter, where `DD` means day-of-YEAR and naive use wrote @{11-317-26});
//  * ranges and carets are UTF-16 offsets, which is what a browser text field reports.
import { settingsObject, splitLines } from './board.js';

export interface CivilDate { readonly year: number; readonly month: number; readonly day: number }
export interface BoardDateSettings { readonly dateFormat: string; readonly dateTrigger: string }
export interface Range { readonly location: number; readonly length: number }

/** obsidian-kanban's own defaults, used when the board's settings omit the keys (or there is no settings block). */
export const DEFAULT_BOARD_SETTINGS: BoardDateSettings = { dateFormat: 'YYYY-MM-DD', dateTrigger: '@' };

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Any problem (missing block, malformed JSON, missing or empty keys) falls back to the defaults per key: capturing
 *  with a due date must never fail because the settings block is odd. */
export function parseBoardSettings(boardContent: string): BoardDateSettings {
  const o = settingsObject(splitLines(boardContent));
  return { dateFormat: nonEmpty(o?.['date-format']) ?? DEFAULT_BOARD_SETTINGS.dateFormat, dateTrigger: nonEmpty(o?.['date-trigger']) ?? DEFAULT_BOARD_SETTINGS.dateTrigger };
}

// ---------------------------------------------------------------- calendar helpers

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number): number => (m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
const valid = (d: CivilDate): boolean => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= daysIn(d.year, d.month);

/** Day of week, 0 = Sunday, from the civil date alone (no time zone involved). */
export const weekdayOf = (d: CivilDate): number => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();

export function addDays(d: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

// ---------------------------------------------------------------- moment.js formatting and parsing

/** Longest token first, so `YYYY` wins over `YY` and `Do` over `D`. */
const TOKENS = ['YYYY', 'MMMM', 'dddd', 'MMM', 'ddd', 'YY', 'MM', 'Do', 'DD', 'HH', 'hh', 'dd', 'mm', 'D', 'M', 'H', 'h', 'm', 'Y'] as const;

type Piece = { kind: 'token'; token: (typeof TOKENS)[number] } | { kind: 'literal'; text: string };

function pieces(format: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  while (i < format.length) {
    const token = TOKENS.find(t => format.startsWith(t, i));
    if (token) { out.push({ kind: 'token', token }); i += token.length; continue; }
    const last = out[out.length - 1];
    if (last?.kind === 'literal') last.text += format[i]; else out.push({ kind: 'literal', text: format[i]! });
    i++;
  }
  return out;
}

/** Formats a date in a moment.js format. Unrecognized runs pass through untouched (an exotic board format then renders
 *  visibly raw on the board, never as a silently wrong date). A due date is the start of its day, so time tokens are zero. */
export function formatMoment(d: CivilDate, format: string): string {
  const wd = weekdayOf(d);
  return pieces(format).map(p => {
    if (p.kind === 'literal') return p.text;
    switch (p.token) {
      case 'YYYY': return pad(d.year, 4);
      case 'YY': return pad(d.year % 100);
      case 'Y': return String(d.year);
      case 'MMMM': return MONTHS[d.month - 1]!;
      case 'MMM': return MONTHS[d.month - 1]!.slice(0, 3);
      case 'MM': return pad(d.month);
      case 'M': return String(d.month);
      case 'dddd': return DAYS[wd]!;
      case 'ddd': return DAYS[wd]!.slice(0, 3);
      case 'dd': return DAYS[wd]!.slice(0, 2);
      case 'DD': return pad(d.day);
      case 'Do': case 'D': return String(d.day);
      case 'HH': case 'hh': case 'mm': return '00';
      case 'H': case 'h': case 'm': return '0';
    }
  }).join('');
}

/** moment.js's documented FIXED pivot for two-digit years: 68 and below are 20xx, above 68 are 19xx, whatever today is.
 *  (It is not relative to the current year, and the board's own parser uses this rule, so we must agree with it.) */
const expandYear = (yy: number): number => (yy > 68 ? 1900 + yy : 2000 + yy);

/** Parses text written in a moment.js format back to a date, or null when it does not match the format. */
export function parseMoment(text: string, format: string, now: Date): CivilDate | null {
  let year: number | undefined; let month: number | undefined; let day: number | undefined;
  let pos = 0;
  const digits = (min: number, max: number): number | null => {
    const m = new RegExp(`^\\d{${min},${max}}`).exec(text.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return Number(m[0]);
  };
  const name = (names: readonly string[], abbreviated: boolean): number | null => {
    const rest = text.slice(pos).toLowerCase();
    const i = names.findIndex(n => rest.startsWith((abbreviated ? n.slice(0, 3) : n).toLowerCase()));
    if (i < 0) return null;
    pos += abbreviated ? 3 : names[i]!.length;
    return i;
  };
  const ps = pieces(format);
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k]!;
    if (p.kind === 'literal') { if (!text.startsWith(p.text, pos)) return null; pos += p.text.length; continue; }
    // Two adjacent numeric tokens with no separator would be ambiguous; fixed-width tokens parse exactly their width.
    switch (p.token) {
      case 'YYYY': { const v = digits(4, 4); if (v === null) return null; year = v; break; }
      case 'YY': { const v = digits(2, 2); if (v === null) return null; year = expandYear(v); break; }
      case 'Y': { const v = digits(1, 4); if (v === null) return null; year = v; break; }
      case 'MM': { const v = digits(2, 2); if (v === null) return null; month = v; break; }
      case 'M': { const v = digits(1, 2); if (v === null) return null; month = v; break; }
      case 'DD': { const v = digits(2, 2); if (v === null) return null; day = v; break; }
      case 'D': { const v = digits(1, 2); if (v === null) return null; day = v; break; }
      case 'Do': { const v = digits(1, 2); if (v === null) return null; day = v; const sfx = /^(st|nd|rd|th)/i.exec(text.slice(pos)); if (sfx) pos += 2; break; }
      case 'MMMM': { const v = name(MONTHS, false); if (v === null) return null; month = v + 1; break; }
      case 'MMM': { const v = name(MONTHS, true); if (v === null) return null; month = v + 1; break; }
      case 'dddd': { if (name(DAYS, false) === null) return null; break; }
      case 'ddd': { if (name(DAYS, true) === null) return null; break; }
      case 'dd': { if (name(DAYS.map(d => d.slice(0, 2).padEnd(3, ' ')), true) === null && !/^[A-Za-z]{2}/.test(text.slice(pos))) return null; pos += 2; break; }
      case 'HH': case 'hh': case 'mm': { if (digits(2, 2) === null) return null; break; }
      case 'H': case 'h': case 'm': { if (digits(1, 2) === null) return null; break; }
    }
  }
  if (pos !== text.length || month === undefined || day === undefined) return null;
  const d: CivilDate = { year: year ?? now.getUTCFullYear(), month, day };
  return valid(d) ? d : null;
}

// ---------------------------------------------------------------- tokens

/** `@{11-14-26}`: the trigger plus the braced date in the board's own format. */
export const tokenFor = (d: CivilDate, s: BoardDateSettings): string => `${s.dateTrigger}{${formatMoment(d, s.dateFormat)}}`;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first `<trigger>{…}` token in the text (UTF-16 offsets), or null. Tokens never span a newline. */
export function tokenRange(text: string, s: BoardDateSettings): Range | null {
  if (s.dateTrigger === '') return null;
  const m = new RegExp(escapeRegex(s.dateTrigger) + '\\{[^}\\n]*\\}').exec(text);
  return m ? { location: m.index, length: m[0].length } : null;
}

/** Parses a date back out of a token, or null when the braced text does not parse in the board's format. */
export function dateFromToken(token: string, s: BoardDateSettings, now: Date = new Date()): CivilDate | null {
  const prefix = s.dateTrigger + '{';
  if (!token.startsWith(prefix) || !token.endsWith('}') || token.length <= prefix.length + 1) return null;
  return parseMoment(token.slice(prefix.length, -1), s.dateFormat, now);
}

export function dateFromTokenIn(text: string, s: BoardDateSettings, now: Date = new Date()): CivilDate | null {
  const r = tokenRange(text, s);
  return r ? dateFromToken(text.slice(r.location, r.location + r.length), s, now) : null;
}

/** Whether the character at `location` is a picker trigger: the board's trigger glyph, NOT inside an existing token.
 *  Mid-word counts, like the Kanban plugin itself. Only single-character triggers can be detected positionally. */
export function isTrigger(location: number, text: string, s: BoardDateSettings): boolean {
  if ([...s.dateTrigger].length !== 1 || location < 0 || location >= text.length) return false;
  if (text.slice(location, location + s.dateTrigger.length) !== s.dateTrigger) return false;
  const t = tokenRange(text, s);
  return !(t && location >= t.location && location < t.location + t.length);
}

/** The picker's text surgery: replaces `triggerRange` (the just-typed trigger, or the existing token on a re-pick) with
 *  the token for `date`, removing any other token first (one due date per card). Returns the new text and the caret just
 *  past the token, or null for an out-of-bounds range. */
export function applyPick(text: string, triggerRange: Range, date: CivilDate, s: BoardDateSettings): { text: string; caretOffset: number } | null {
  const { location, length } = triggerRange;
  if (location < 0 || length < 0 || location + length > text.length) return null;
  const token = tokenFor(date, s);
  let out = text;
  let loc = location;
  const existing = tokenRange(text, s);
  if (existing && !(existing.location === location && existing.length === length)) {
    let removal = existing;
    // Swallow one space directly before the old token so the line does not keep a double space where it sat.
    if (existing.location > 0 && text[existing.location - 1] === ' ') removal = { location: existing.location - 1, length: existing.length + 1 };
    if (removal.location < location) loc -= removal.length;
    out = out.slice(0, removal.location) + out.slice(removal.location + removal.length);
  }
  out = out.slice(0, loc) + token + out.slice(loc + length);
  return { text: out, caretOffset: loc + token.length };
}

// ---------------------------------------------------------------- chips and the type-ahead list

/** The civil date of `now` in a time zone. */
export function todayIn(now: Date, timeZone: string): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const n = (t: string) => Number(parts.find(p => p.type === t)!.value);
  return { year: n('year'), month: n('month'), day: n('day') };
}
export const tomorrowIn = (now: Date, timeZone: string): CivilDate => addDays(todayIn(now, timeZone), 1);

/** The FOLLOWING week's Monday: today counts as THIS Monday, so a Monday always jumps a full week ahead. */
export function nextMonday(now: Date, timeZone: string): CivilDate {
  const today = todayIn(now, timeZone);
  let ahead = (1 - weekdayOf(today) + 7) % 7;
  if (ahead === 0) ahead = 7;
  return addDays(today, ahead);
}

/** Human badge text for the success flash: "Sat, Nov 14". */
export function friendlyText(d: CivilDate, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(d.year, d.month - 1, d.day)));
}

export interface DueDateOption { readonly label: string; readonly date: CivilDate }

/** The picker's list narrowed by what was typed after the trigger: a case-insensitive prefix match on the label (so
 *  "next m" finds Next Monday). An empty result is the caller's signal to close the picker. */
export function typeAheadOptions(prefix: string, now: Date, timeZone: string): DueDateOption[] {
  const all: DueDateOption[] = [
    { label: 'Today', date: todayIn(now, timeZone) },
    { label: 'Tomorrow', date: tomorrowIn(now, timeZone) },
    { label: 'Next Monday', date: nextMonday(now, timeZone) },
  ];
  const p = prefix.toLowerCase();
  return p === '' ? all : all.filter(o => o.label.toLowerCase().startsWith(p));
}
