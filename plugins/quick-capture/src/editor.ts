// The capture bar's brain: everything about editing a card and picking a due date, with no DOM. The page
// (src/views/panel.ts) forwards the field's events here and applies what comes back. This is the Swift CaptureViewModel +
// PanelTextView key routing, as a pure state machine so every rule is unit-tested without a browser.
//
// Differences from Swift, by design: offsets are UTF-16 (what a browser reports); the picker also closes when the caret
// moves away from the trigger (Swift could leave a stale one open); re-opening the picker on a token needs the caret
// strictly INSIDE it.
import {
  addDays, applyPick, dateFromTokenIn, friendlyText, isTrigger, MONTHS, nextMonday, todayIn, tokenRange, tomorrowIn, typeAheadOptions,
  weekdayOf, type BoardDateSettings, type CivilDate, type DueDateOption, type Range,
} from './due-date.js';
import type { Mode } from './protocol.js';

export interface Selection { readonly start: number; readonly end: number }
export interface KeyInput { readonly key: string; readonly shift?: boolean; readonly ctrl?: boolean; readonly alt?: boolean; readonly meta?: boolean }
export type Effect = { readonly type: 'submit'; readonly text: string } | { readonly type: 'hide' };

export interface EditorEnv {
  readonly settings: BoardDateSettings;
  /** The clock (the plugin's, so "today" agrees with the success line). */
  readonly now: () => Date;
  readonly timeZone: string;
}

/** What a key or click did: whether the editor consumed it (the page then calls preventDefault), things for the page to
 *  do, and, when the text itself changed, the new text and caret to put in the field. */
export interface Update { handled: boolean; effects: Effect[]; dom?: { text: string; selection: Selection } }

export interface PickerState {
  /** What a pick replaces: the just-typed trigger, or the whole existing token on a re-pick. */
  triggerRange: Range;
  /** Characters typed after the trigger (a partial "tod"); a pick consumes them too. */
  typedWord: number;
  query: string;
  matches: DueDateOption[];
  index: number;
  /** The month the grid shows, and the highlighted day (the arrow-key cursor). */
  month: CivilDate;
  day: CivilDate;
}

export interface PickerView {
  title: string;
  weekdays: string[];
  rows: Array<Array<{ date: CivilDate; selected: boolean; today: boolean } | null>>;
  chips: Array<{ label: string; date: CivilDate }>;
  typeAhead: Array<{ label: string; friendly: string; selected: boolean }> | null;
}

const same = (a: CivilDate, b: CivilDate): boolean => a.year === b.year && a.month === b.month && a.day === b.day;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Moves by whole months, keeping the day of the month where the target month has it, else its last day. */
export function addMonths(d: CivilDate, n: number): CivilDate {
  const idx = d.year * 12 + (d.month - 1) + n;
  const year = Math.floor(idx / 12); const month = (idx % 12 + 12) % 12 + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

/** Six Monday-first rows of cells for the month of `d` (blanks are null), so the bar's height is stable across months. */
export function monthCells(d: CivilDate): Array<Array<CivilDate | null>> {
  const lead = (weekdayOf({ year: d.year, month: d.month, day: 1 }) + 6) % 7; // Monday = 0
  const cells: Array<CivilDate | null> = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= daysInMonth(d.year, d.month); i++) cells.push({ year: d.year, month: d.month, day: i });
  while (cells.length < 42) cells.push(null);
  return Array.from({ length: 6 }, (_, r) => cells.slice(r * 7, r * 7 + 7));
}

export class CaptureEditor {
  text = '';
  selection: Selection = { start: 0, end: 0 };
  picker: PickerState | null = null;
  mode: Mode = 'editing';

  constructor(private e: EditorEnv) {}

  setEnv(e: EditorEnv): void { this.e = e; }
  setMode(m: Mode): void { this.mode = m; if (m === 'unconfigured') this.picker = null; }

  /** A fresh capture: every show starts empty. */
  reset(): void { this.text = ''; this.selection = { start: 0, end: 0 }; this.picker = null; }

  private today(): CivilDate { return todayIn(this.e.now(), this.e.timeZone); }

  // ------------------------------------------------------------ events from the field

  /** The field's text changed (typing, paste, undo). */
  input(text: string, selection: Selection): void {
    if (this.mode === 'unconfigured') return;
    this.text = text; this.selection = selection;
    const { start, end } = selection;
    if (start === end && start > 0 && isTrigger(start - 1, text, this.e.settings)) { this.open({ location: start - 1, length: 1 }); return; }
    if (!this.picker) return;
    const t = this.picker.triggerRange;
    if (start === end && start >= t.location + t.length) { this.typed(text.slice(t.location + t.length, start)); return; }
    this.close();
  }

  /** The caret moved by keyboard (arrows in the field). Strictly inside a due-date token re-opens the picker for a re-pick. */
  moved(selection: Selection): Update {
    this.selection = selection;
    this.reopenOrClose();
    return { handled: false, effects: [] };
  }

  /** A mouse click placed the caret. */
  clicked(selection: Selection): void { this.selection = selection; this.reopenOrClose(); }

  private reopenOrClose(): void {
    const { start, end } = this.selection;
    const token = tokenRange(this.text, this.e.settings);
    if (start === end && token && start > token.location && start < token.location + token.length) { this.open(token); return; }
    if (!this.picker) return;
    const t = this.picker.triggerRange;
    // Still in the span the picker drives (the trigger and the word typed after it)? Keep it. Anywhere else: close.
    if (!(start === end && start >= t.location + t.length && start <= t.location + t.length + this.picker.typedWord)) this.close();
  }

  // ------------------------------------------------------------ the picker

  private open(range: Range): void {
    const existing = dateFromTokenIn(this.text, this.e.settings, this.e.now());
    const start = existing ?? this.today();
    this.picker = { triggerRange: range, typedWord: 0, query: '', matches: [], index: 0, month: start, day: start };
  }

  private close(): void { this.picker = null; }

  /** The word typed after the trigger: every keystroke refilters; no match closes the picker; empty returns to the grid. */
  private typed(word: string): void {
    const p = this.picker!;
    if (word === '') { p.query = ''; p.matches = []; p.index = 0; p.typedWord = 0; return; }
    const matches = typeAheadOptions(word, this.e.now(), this.e.timeZone);
    if (matches.length === 0) { this.close(); return; }
    p.query = word; p.matches = matches; p.typedWord = word.length;
    if (p.index >= matches.length) p.index = 0;
  }

  changeMonth(delta: number): void {
    const p = this.picker;
    if (!p) return;
    p.month = addMonths({ ...p.month, day: p.day.day }, delta);
    p.day = p.month;
  }

  /** Picks a day (⏎, a chip, a grid cell): replaces the trigger PLUS any typed word with the token, then closes. */
  pick(date: CivilDate): Update {
    const p = this.picker;
    if (!p) return { handled: false, effects: [] };
    const range: Range = { location: p.triggerRange.location, length: p.triggerRange.length + p.typedWord };
    this.close(); // first: the new text must not re-trigger the picker
    const r = applyPick(this.text, range, date, this.e.settings);
    if (!r) return { handled: true, effects: [] };
    this.text = r.text; this.selection = { start: r.caretOffset, end: r.caretOffset };
    return { handled: true, effects: [], dom: { text: r.text, selection: this.selection } };
  }

  private moveDay(delta: number): void {
    const p = this.picker!;
    const next = addDays(p.day, delta);
    if (next.year === p.month.year && next.month === p.month.month) p.day = next; // never leaves the visible month
  }

  // ------------------------------------------------------------ keys

  keydown(k: KeyInput): Update {
    const none: Update = { handled: false, effects: [] };
    const handled = (effects: Effect[] = []): Update => ({ handled: true, effects });

    // While the picker is open its keys come first. ⎋ closes ONLY the picker; a second ⎋ dismisses the bar.
    const p = this.picker;
    if (p) {
      const typeAhead = p.query !== '';
      switch (k.key) {
        case 'ArrowLeft': case 'ArrowRight':
          if (!typeAhead) this.moveDay(k.key === 'ArrowLeft' ? -1 : 1);
          return handled();
        case 'ArrowDown': case 'ArrowUp': {
          const down = k.key === 'ArrowDown';
          if (typeAhead) p.index = (p.index + (down ? 1 : -1) + p.matches.length) % p.matches.length;
          else this.moveDay(down ? 7 : -7);
          return handled();
        }
        case 'Enter':
          if (!k.shift && !k.ctrl && !k.alt && !k.meta) return this.pick(typeAhead ? p.matches[p.index]!.date : p.day);
          break;
        case 'Escape': this.close(); return handled();
      }
    }

    if (k.key === 'Escape') return handled([{ type: 'hide' }]); // cancels in every mode

    if (k.key === 'Enter') {
      // Only the four real modifiers change what Enter means (⇧⏎ is a newline).
      if (k.shift || k.ctrl || k.alt || k.meta) return none;
      if (this.mode === 'unconfigured' || this.mode === 'submitting' || this.mode === 'success') return handled(); // never a second submit
      const text = this.text.trim();
      return handled([text === '' ? { type: 'hide' } : { type: 'submit', text }]); // empty text never writes: it just dismisses
    }

    if (k.key === 'Backspace' && !k.shift && !k.ctrl && !k.alt && !k.meta) return this.backspace() ?? none;
    return none;
  }

  /** ⌫ with the caret inside or at the end of a due-date token deletes the WHOLE token: the badge is one editing unit,
   *  never a half-deleted `@{11-1`. (Caret just BEFORE it is an ordinary position: the field deletes a character.) */
  private backspace(): Update | null {
    const { start, end } = this.selection;
    const token = tokenRange(this.text, this.e.settings);
    if (!token || start !== end || start <= token.location || start > token.location + token.length) return null;
    this.text = this.text.slice(0, token.location) + this.text.slice(token.location + token.length);
    this.selection = { start: token.location, end: token.location };
    this.close();
    return { handled: true, effects: [], dom: { text: this.text, selection: this.selection } };
  }

  // ------------------------------------------------------------ what to show

  pickerView(): PickerView | null {
    const p = this.picker;
    if (!p) return null;
    const today = this.today();
    const now = this.e.now(); const tz = this.e.timeZone;
    return {
      title: `${MONTHS[p.month.month - 1]} ${p.month.year}`,
      weekdays: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
      rows: monthCells(p.month).map(r => r.map(c => (c ? { date: c, selected: same(c, p.day), today: same(c, today) } : null))),
      chips: [{ label: 'Today', date: today }, { label: 'Tomorrow', date: tomorrowIn(now, tz) }, { label: 'Next Monday', date: nextMonday(now, tz) }],
      typeAhead: p.query === '' ? null : p.matches.map((m, i) => ({ label: m.label, friendly: friendlyText(m.date), selected: i === p.index })),
    };
  }
}
