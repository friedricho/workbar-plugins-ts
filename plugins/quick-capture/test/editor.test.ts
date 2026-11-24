// The capture bar's brain, tested without a browser: text + caret + keys in, effects + what to show out.
// Ported from the behavior of the Swift CaptureView / PanelTextView / CaptureViewModel (key routing while the picker is
// open, type-ahead, token surgery, ⌫ deleting a token whole, Escape layering, ⏎ vs ⇧⏎). Differences, by design:
//   * ranges and carets are UTF-16 offsets (what a browser text field reports);
//   * the picker closes when the caret moves away from the trigger (Swift left a stale picker open);
//   * clicking or arrowing into a token re-opens the picker only when the caret is strictly INSIDE it.
import { describe, expect, it } from 'vitest';
import { CaptureEditor, addMonths, monthCells, type Effect, type EditorEnv } from '../src/editor.js';
import type { BoardDateSettings, CivilDate } from '../src/due-date.js';

const live: BoardDateSettings = { dateFormat: 'MM-DD-YY', dateTrigger: '@' };
const NOW = new Date('2026-11-13T19:00:00Z'); // Friday 2026-11-13 in New York
const env = (settings: BoardDateSettings = live): EditorEnv => ({ settings, now: () => NOW, timeZone: 'America/New_York' });
const day = (year: number, month: number, d: number): CivilDate => ({ year, month, day: d });
const key = (k: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) => ({ key: k, ...mods });

/** An editor with `text` typed and the caret at its end (typing goes through input(), like the real field). */
function typed(text: string, settings = live): CaptureEditor {
  const e = new CaptureEditor(env(settings));
  let acc = '';
  for (const ch of [...text]) { acc += ch; e.input(acc, { start: acc.length, end: acc.length }); }
  return e;
}
const effects = (u: { effects: Effect[] }) => u.effects;

describe('opening the picker', () => {
  it('typing the trigger opens it, targeting just that character, with today highlighted', () => {
    const e = typed('fix the leak @');
    expect(e.picker).toMatchObject({ triggerRange: { location: 13, length: 1 }, typedWord: 0, query: '', matches: [], day: day(2026, 11, 13), month: day(2026, 11, 13) });
  });
  it('mid-word counts, like the Kanban plugin', () => { expect(typed('a@').picker).not.toBeNull(); });
  it('typing a trigger inside an existing token does not open it', () => {
    const e = new CaptureEditor(env());
    e.input('a @{11-14-26} b', { start: 5, end: 5 }); // caret inside the token, on a char that is not the trigger
    expect(e.picker).toBeNull();
  });
  it('a multi-character trigger can never open the picker (it cannot be detected positionally)', () => {
    expect(typed('fix due', { dateFormat: 'MM-DD-YY', dateTrigger: 'due' }).picker).toBeNull();
  });
  it('an emoji before the trigger shifts the range correctly (UTF-16)', () => {
    expect(typed('✨ @').picker!.triggerRange).toEqual({ location: 2, length: 1 });
    expect(typed('👩‍💻 @').picker!.triggerRange).toEqual({ location: '👩‍💻 '.length, length: 1 });
  });
  it('a selection (not a caret) never opens it, even when the character just before it is a trigger', () => {
    const e = new CaptureEditor(env());
    e.input('a@bc', { start: 2, end: 4 }); // "bc" is selected and sits right after "@"
    expect(e.picker).toBeNull();
    e.input('a@bc', { start: 2, end: 2 }); // the same position as a plain caret DOES open it
    expect(e.picker).not.toBeNull();
  });
  it('seeds the grid from an existing token when re-picking', () => {
    const e = new CaptureEditor(env());
    e.input('fix @{11-20-26} now', { start: 9, end: 9 });
    expect(e.moved({ start: 9, end: 9 }).effects).toEqual([]);
    expect(e.picker).toMatchObject({ triggerRange: { location: 4, length: 11 }, day: day(2026, 11, 20), month: day(2026, 11, 20) });
  });
});

describe('type-ahead after the trigger', () => {
  it('narrows as letters are typed, tracks the typed word, and closes when nothing matches', () => {
    const e = typed('go @');
    expect(e.picker!.matches).toEqual([]);
    e.input('go @t', { start: 5, end: 5 });
    expect(e.picker!.matches.map(m => m.label)).toEqual(['Today', 'Tomorrow']);
    expect(e.picker).toMatchObject({ query: 't', typedWord: 1, index: 0 });
    e.input('go @tod', { start: 7, end: 7 });
    expect(e.picker!.matches.map(m => m.label)).toEqual(['Today']);
    e.input('go @todx', { start: 8, end: 8 });
    expect(e.picker).toBeNull();
  });
  it('backspacing to the bare trigger returns to the full grid (the picker stays open)', () => {
    const e = typed('go @to');
    e.input('go @', { start: 4, end: 4 });
    expect(e.picker).toMatchObject({ query: '', matches: [], typedWord: 0 });
  });
  it('is case-insensitive and matches "next m" with its space', () => {
    const e = typed('@Next M');
    expect(e.picker!.matches.map(m => m.label)).toEqual(['Next Monday']);
  });
  it('Enter picks the highlighted survivor; the token replaces the trigger AND the typed word; the picker closes', () => {
    const e = typed('fix @tom');
    const u = e.keydown(key('Enter'));
    expect(u.handled).toBe(true);
    expect(u.effects).toEqual([]);
    expect(u.dom).toEqual({ text: 'fix @{11-14-26}', selection: { start: 15, end: 15 } });
    expect(e.text).toBe('fix @{11-14-26}');
    expect(e.picker).toBeNull();
  });
  it('↑ and ↓ move through the narrowed list and wrap around', () => {
    const e = typed('@t'); // Today, Tomorrow
    e.keydown(key('ArrowDown')); expect(e.picker!.index).toBe(1);
    e.keydown(key('ArrowDown')); expect(e.picker!.index).toBe(0); // wraps
    e.keydown(key('ArrowUp')); expect(e.picker!.index).toBe(1);   // wraps backward
    expect(e.keydown(key('Enter')).dom!.text).toBe('@{11-14-26}'); // Tomorrow
  });
  it('← and → are swallowed while a query is active (there is no grid to move in)', () => {
    const e = typed('@t');
    for (const k of ['ArrowLeft', 'ArrowRight']) { const u = e.keydown(key(k)); expect(u.handled, k).toBe(true); expect(u.dom, k).toBeUndefined(); }
    // Net-zero left+right would hide a cursor that moved, so also press → twice on its own.
    e.keydown(key('ArrowRight')); e.keydown(key('ArrowRight'));
    expect(e.picker!.day).toEqual(day(2026, 11, 13)); // the (hidden) grid cursor never moved
    expect(e.picker!.index).toBe(0);
  });
  it('after the query is cleared the grid cursor is where it was, not where ←/→ would have taken it', () => {
    const e = typed('@t');
    e.keydown(key('ArrowRight')); e.keydown(key('ArrowRight')); e.keydown(key('ArrowRight'));
    e.input('@', { start: 1, end: 1 });
    expect(e.picker).toMatchObject({ query: '', day: day(2026, 11, 13) });
    expect(e.keydown(key('Enter')).dom!.text).toBe('@{11-13-26}');
  });
  it('the highlighted index is kept in range when the list shrinks', () => {
    const e = typed('@t');
    e.keydown(key('ArrowDown')); // Tomorrow
    e.input('@to', { start: 3, end: 3 }); // still two
    expect(e.picker!.index).toBe(1);
    e.input('@tod', { start: 4, end: 4 }); // one left
    expect(e.picker!.index).toBe(0);
  });
});

describe('the grid', () => {
  it('Enter picks the highlighted day (today by default)', () => {
    expect(typed('call @').keydown(key('Enter')).dom!.text).toBe('call @{11-13-26}');
  });
  it('arrows move the cursor a day or a week, and never leave the visible month', () => {
    const e = typed('@');
    e.keydown(key('ArrowRight')); expect(e.picker!.day).toEqual(day(2026, 11, 14));
    e.keydown(key('ArrowDown')); expect(e.picker!.day).toEqual(day(2026, 11, 21));
    e.keydown(key('ArrowLeft')); expect(e.picker!.day).toEqual(day(2026, 11, 20));
    e.keydown(key('ArrowUp')); expect(e.picker!.day).toEqual(day(2026, 11, 13));
    for (let i = 0; i < 5; i++) e.keydown(key('ArrowDown')); // Nov 13 + 28 = Dec 11: blocked at Nov 27
    expect(e.picker!.day).toEqual(day(2026, 11, 27));
    for (let i = 0; i < 5; i++) e.keydown(key('ArrowUp'));
    expect(e.picker!.day).toEqual(day(2026, 11, 6));
    for (let i = 0; i < 9; i++) e.keydown(key('ArrowLeft'));
    expect(e.picker!.day).toEqual(day(2026, 11, 1)); // the first of the month is the floor
    e.keydown(key('ArrowLeft')); expect(e.picker!.day).toEqual(day(2026, 11, 1));
  });
  it('‹ › flip the month; the cursor keeps its day-of-month, clamped to a shorter month', () => {
    const e = typed('@');
    e.changeMonth(1); expect(e.picker).toMatchObject({ month: day(2026, 12, 13), day: day(2026, 12, 13) });
    e.changeMonth(1); expect(e.picker!.month).toEqual(day(2027, 1, 13));
    e.changeMonth(-3); expect(e.picker!.month).toEqual(day(2026, 10, 13));
    const jan31 = new CaptureEditor({ ...env(), now: () => new Date('2027-01-31T17:00:00Z') });
    jan31.input('@', { start: 1, end: 1 });
    jan31.changeMonth(1);
    expect(jan31.picker).toMatchObject({ month: day(2027, 2, 28), day: day(2027, 2, 28) });
  });
  it('picking in another month works (Enter after flipping)', () => {
    const e = typed('due @');
    e.changeMonth(1);
    expect(e.keydown(key('Enter')).dom!.text).toBe('due @{12-13-26}');
  });
  it('a click on a chip or a day picks it (replacing the trigger and any typed word)', () => {
    const e = typed('x @tom');
    expect(e.pick(day(2026, 11, 16)).dom!.text).toBe('x @{11-16-26}');
    expect(e.picker).toBeNull();
  });
  it('a click when the picker is closed does nothing', () => {
    const e = typed('plain');
    expect(e.pick(day(2026, 11, 16)).dom).toBeUndefined();
    expect(e.text).toBe('plain');
  });
  it('re-picking replaces the existing token: one due date per card', () => {
    const e = new CaptureEditor(env());
    e.input('fix @{11-14-26} tonight', { start: 10, end: 10 });
    e.moved({ start: 10, end: 10 });
    expect(e.pick(day(2026, 11, 16)).dom).toEqual({ text: 'fix @{11-16-26} tonight', selection: { start: 15, end: 15 } });
  });
});

describe('monthCells (always six Monday-first rows)', () => {
  it('lays out November 2026: it starts on a Sunday, so six blanks lead', () => {
    const cells = monthCells(day(2026, 11, 13));
    expect(cells).toHaveLength(6);
    expect(cells.every(r => r.length === 7)).toBe(true);
    expect(cells[0]!.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(cells[0]![6]).toEqual(day(2026, 11, 1));
    expect(cells.flat().filter(Boolean)).toHaveLength(30);
    expect(cells.flat().filter(Boolean).at(-1)).toEqual(day(2026, 11, 30));
  });
  it('a month that starts on a Monday has no leading blanks (June 2026)', () => { expect(monthCells(day(2026, 6, 10))[0]![0]).toEqual(day(2026, 6, 1)); });
  it('February in a leap and a non-leap year', () => {
    expect(monthCells(day(2028, 2, 1)).flat().filter(Boolean)).toHaveLength(29);
    expect(monthCells(day(2027, 2, 1)).flat().filter(Boolean)).toHaveLength(28);
  });
  it('a 31-day month starting on a Sunday still fits in six rows (March 2026 starts on a Sunday)', () => {
    expect(monthCells(day(2026, 3, 1)).flat().filter(Boolean)).toHaveLength(31);
  });
});

describe('addMonths', () => {
  it('rolls the year and clamps the day', () => {
    expect(addMonths(day(2026, 12, 31), 1)).toEqual(day(2027, 1, 31));
    expect(addMonths(day(2027, 1, 31), 1)).toEqual(day(2027, 2, 28));
    expect(addMonths(day(2028, 1, 31), 1)).toEqual(day(2028, 2, 29));
    expect(addMonths(day(2026, 1, 15), -1)).toEqual(day(2025, 12, 15));
    expect(addMonths(day(2026, 3, 31), -1)).toEqual(day(2026, 2, 28));
    expect(addMonths(day(2026, 6, 15), 25)).toEqual(day(2028, 7, 15));
  });
});

describe('Escape layers: close the picker first, then dismiss the bar', () => {
  it('with the picker open, Escape closes only the picker; the next Escape hides', () => {
    const e = typed('@');
    expect(e.keydown(key('Escape'))).toMatchObject({ handled: true, effects: [] });
    expect(e.picker).toBeNull();
    expect(e.keydown(key('Escape'))).toMatchObject({ handled: true, effects: [{ type: 'hide' }] });
  });
  it('Escape hides in every mode', () => {
    for (const mode of ['editing', 'submitting', 'success', 'error', 'unconfigured'] as const) {
      const e = new CaptureEditor(env()); e.setMode(mode);
      expect(effects(e.keydown(key('Escape'))), mode).toEqual([{ type: 'hide' }]);
    }
  });
});

describe('Enter', () => {
  it('submits the TRIMMED text', () => {
    const e = typed('  buy milk \n');
    expect(effects(e.keydown(key('Enter')))).toEqual([{ type: 'submit', text: 'buy milk' }]);
  });
  it('empty or whitespace-only text never writes: it just dismisses', () => {
    expect(effects(new CaptureEditor(env()).keydown(key('Enter')))).toEqual([{ type: 'hide' }]);
    expect(effects(typed('   \n ').keydown(key('Enter')))).toEqual([{ type: 'hide' }]);
  });
  it('Shift+Enter is a newline (left to the field); Ctrl/Alt/Meta+Enter are not submits either', () => {
    const e = typed('a');
    for (const mods of [{ shift: true }, { ctrl: true }, { alt: true }, { meta: true }]) {
      const u = e.keydown(key('Enter', mods));
      expect(u, JSON.stringify(mods)).toEqual({ handled: false, effects: [] });
    }
  });
  it('multi-line text is submitted with its inner newlines intact', () => {
    expect(effects(typed('one\ntwo').keydown(key('Enter')))).toEqual([{ type: 'submit', text: 'one\ntwo' }]);
  });
  it('is ignored while a submit is in flight or the success flash shows (double-submit protection), but allowed again after an error', () => {
    for (const mode of ['submitting', 'success'] as const) {
      const e = typed('x'); e.setMode(mode);
      expect(e.keydown(key('Enter')), mode).toEqual({ handled: true, effects: [] });
    }
    const err = typed('x'); err.setMode('error');
    expect(effects(err.keydown(key('Enter')))).toEqual([{ type: 'submit', text: 'x' }]);
  });
  it('does nothing when not configured (there is no field to submit)', () => {
    const e = new CaptureEditor(env()); e.setMode('unconfigured');
    expect(e.keydown(key('Enter'))).toEqual({ handled: true, effects: [] });
  });
  it('an Enter that picks a date never also submits', () => {
    const e = typed('x @');
    expect(effects(e.keydown(key('Enter')))).toEqual([]);
    expect(e.text).toBe('x @{11-13-26}');
  });
  it('once the picker closed, the next Enter submits the card', () => {
    const e = typed('x @');
    e.keydown(key('Enter'));
    expect(effects(e.keydown(key('Enter')))).toEqual([{ type: 'submit', text: 'x @{11-13-26}' }]);
  });
});

describe('⌫ treats the due-date token as one unit', () => {
  const withToken = (caret: number, text = 'fix @{11-14-26} now') => { const e = new CaptureEditor(env()); e.input(text, { start: caret, end: caret }); return e; };
  it('caret at the END of the token deletes the whole token', () => {
    const e = withToken(15);
    expect(e.keydown(key('Backspace')).dom).toEqual({ text: 'fix  now', selection: { start: 4, end: 4 } });
  });
  it('caret INSIDE the token deletes the whole token', () => {
    expect(withToken(9).keydown(key('Backspace')).dom).toEqual({ text: 'fix  now', selection: { start: 4, end: 4 } });
  });
  it('caret just BEFORE the token is ordinary text: ⌫ is left to the field (deletes the space)', () => {
    const e = withToken(4);
    expect(e.keydown(key('Backspace'))).toEqual({ handled: false, effects: [] });
  });
  it('a selection is left to the field', () => {
    const e = new CaptureEditor(env()); e.input('fix @{11-14-26} now', { start: 6, end: 12 });
    expect(e.keydown(key('Backspace')).handled).toBe(false);
  });
  it('with no token in the text, ⌫ is the field’s', () => { expect(typed('plain').keydown(key('Backspace')).handled).toBe(false); });
  it('⌫ on a token the picker is open for closes the picker (nothing is left to pick a date into)', () => {
    const e = new CaptureEditor(env());
    e.input('fix @{11-14-26} now', { start: 9, end: 9 });
    e.moved({ start: 9, end: 9 });
    expect(e.picker).not.toBeNull();
    e.keydown(key('Backspace'));
    expect(e.picker).toBeNull();
    expect(e.text).toBe('fix  now');
  });
  it('a token at the very start works, and the picker is not left open afterwards', () => {
    const e = new CaptureEditor(env()); e.input('@{11-14-26}', { start: 11, end: 11 });
    expect(e.keydown(key('Backspace')).dom).toEqual({ text: '', selection: { start: 0, end: 0 } });
    expect(e.picker).toBeNull();
  });
  it('a malformed token that merely LOOKS like one is still one unit (the board shows raw text; the user can remove it whole)', () => {
    expect(withToken(10, 'x @{banana} y').keydown(key('Backspace')).dom!.text).toBe('x  y');
  });
});

describe('moving into a token re-opens the picker', () => {
  it('arrowing strictly inside opens it for a re-pick; the edges are ordinary text positions', () => {
    const text = 'fix @{11-14-26} now';
    for (const [caret, opens] of [[4, false], [5, true], [10, true], [14, true], [15, false], [19, false]] as const) {
      const e = new CaptureEditor(env()); e.input(text, { start: caret, end: caret }); e.moved({ start: caret, end: caret });
      expect(e.picker !== null, `caret ${caret}`).toBe(opens);
    }
  });
  it('a click strictly inside opens it too, and a click outside closes an open picker', () => {
    const e = new CaptureEditor(env()); e.input('fix @{11-14-26} now', { start: 19, end: 19 });
    e.clicked({ start: 10, end: 10 });
    expect(e.picker).not.toBeNull();
    e.clicked({ start: 19, end: 19 });
    expect(e.picker).toBeNull();
  });
  it('typing INSIDE a token does not pop the picker open (only arrows and clicks do, as in Swift)', () => {
    const e = new CaptureEditor(env()); e.input('fix @{11-14-26} now', { start: 10, end: 10 });
    expect(e.picker).toBeNull();
  });
});

describe('the picker closes when the caret leaves the trigger', () => {
  it('a click before or far after it closes it; a click right after the typed word keeps it', () => {
    const e = typed('go @to');
    e.clicked({ start: 6, end: 6 }); expect(e.picker).not.toBeNull();
    e.clicked({ start: 1, end: 1 }); expect(e.picker).toBeNull();
  });
  it('a selection closes it', () => {
    const e = typed('go @');
    e.clicked({ start: 0, end: 4 });
    expect(e.picker).toBeNull();
  });
});

describe('reset and environment', () => {
  it('reset clears the text, the selection and the picker (every show starts fresh)', () => {
    const e = typed('draft @t'); e.setMode('error');
    e.reset();
    expect(e).toMatchObject({ text: '', picker: null });
    expect(e.selection).toEqual({ start: 0, end: 0 });
  });
  it('the board’s settings can change between shows (a different trigger or format)', () => {
    const e = typed('x');
    e.setEnv(env({ dateFormat: 'YYYY-MM-DD', dateTrigger: '!' }));
    e.input('x !', { start: 3, end: 3 });
    expect(e.picker).not.toBeNull();
    expect(e.keydown(key('Enter')).dom!.text).toBe('x !{2026-11-13}');
  });
  it('the due-date format of a pick follows the board: YYYY-MM-DD', () => {
    const e = new CaptureEditor(env({ dateFormat: 'YYYY-MM-DD', dateTrigger: '@' }));
    e.input('@', { start: 1, end: 1 });
    expect(e.keydown(key('Enter')).dom!.text).toBe('@{2026-11-13}');
  });
});

describe('what the page shows', () => {
  it('exposes the month title, today and the selected day for the grid', () => {
    const e = typed('@');
    const v = e.pickerView()!;
    expect(v.title).toBe('November 2026');
    expect(v.weekdays).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    const flat = v.rows.flat().filter(c => c !== null);
    expect(flat.find(c => c!.today)!.date).toEqual(day(2026, 11, 13));
    expect(flat.find(c => c!.selected)!.date).toEqual(day(2026, 11, 13));
    expect(v.chips.map(c => c.label)).toEqual(['Today', 'Tomorrow', 'Next Monday']);
    expect(v.typeAhead).toBeNull();
  });
  it('with a query it shows the narrowed list (label, friendly date, highlighted) instead of the grid', () => {
    const e = typed('@t');
    const v = e.pickerView()!;
    expect(v.typeAhead).toEqual([{ label: 'Today', friendly: 'Fri, Nov 13', selected: true }, { label: 'Tomorrow', friendly: 'Sat, Nov 14', selected: false }]);
  });
  it('is null when no picker is open', () => { expect(typed('x').pickerView()).toBeNull(); });
});

describe('unconfigured', () => {
  it('typing is ignored, and only Escape does anything', () => {
    const e = new CaptureEditor(env()); e.setMode('unconfigured');
    e.input('@', { start: 1, end: 1 });
    expect(e.picker).toBeNull();
    expect(e.text).toBe('');
  });
});
