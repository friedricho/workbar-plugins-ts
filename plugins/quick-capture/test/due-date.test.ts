// Ported from DueDateTests.swift. The live board's real settings (MM-DD-YY, trigger @) and its `Test @{11-13-26}`
// card are the executable spec: these must never drift from what obsidian-kanban parses.
// Differences by design: dates are civil {year, month, day} values (a due date has no time), and instead of the Swift
// moment->ICU format translation (an artifact of Swift's DateFormatter, whose `DD` means day-of-YEAR) the formatter
// writes moment tokens directly; the translation tests became output tests that pin the same behavior.
import { describe, expect, it } from 'vitest';
import {
  applyPick, dateFromToken, dateFromTokenIn, DEFAULT_BOARD_SETTINGS, formatMoment, friendlyText, isTrigger, nextMonday,
  parseBoardSettings, todayIn, tokenFor, tokenRange, tomorrowIn, typeAheadOptions, type BoardDateSettings, type CivilDate,
} from '../src/due-date.js';

const NY = 'America/New_York';
const live: BoardDateSettings = { dateFormat: 'MM-DD-YY', dateTrigger: '@' };
const day = (year: number, month: number, d: number): CivilDate => ({ year, month, day: d });
/** The instant of a New York wall-clock time in November 2026 (EST, UTC-5: DST ended Nov 1). */
const nyNov = (d: number, hour = 9) => new Date(Date.UTC(2026, 10, d, hour + 5));
const NOW = nyNov(13); // pins the two-digit-year window

const boardWithSettings = `## Today

- [ ] Test @{11-13-26}

%% kanban:settings
\`\`\`json
{"kanban-plugin":"board","new-card-insertion-method":"prepend",
 "date-format":"MM-DD-YY","date-display-format":"MM-DD-YY",
 "move-dates":true,"archive-with-date":true}
\`\`\`
%%`;

describe('parseBoardSettings', () => {
  it('reads the live board’s format', () => { expect(parseBoardSettings(boardWithSettings)).toEqual(live); });
  it('falls back to obsidian-kanban’s defaults without a settings block', () => {
    expect(parseBoardSettings('## Today\n\n- [ ] card\n')).toEqual(DEFAULT_BOARD_SETTINGS);
    expect(DEFAULT_BOARD_SETTINGS).toEqual({ dateFormat: 'YYYY-MM-DD', dateTrigger: '@' });
  });
  it('falls back to the defaults on malformed JSON (capturing must never fail on an odd settings block)', () => {
    expect(parseBoardSettings('%% kanban:settings\n```json\n{not json at all\n```\n%%')).toEqual(DEFAULT_BOARD_SETTINGS);
  });
  it('reads a custom trigger', () => {
    expect(parseBoardSettings('%% kanban:settings\n```json\n{"kanban-plugin":"board","date-format":"YYYY-MM-DD","date-trigger":"due"}\n```\n%%'))
      .toEqual({ dateFormat: 'YYYY-MM-DD', dateTrigger: 'due' });
  });
  it('empty or non-string values fall back per key', () => {
    expect(parseBoardSettings('%% kanban:settings\n```\n{"date-format":"","date-trigger":5}\n```\n%%')).toEqual(DEFAULT_BOARD_SETTINGS);
    expect(parseBoardSettings('%% kanban:settings\n```\n{"date-format":"DD/MM/YYYY"}\n```\n%%')).toEqual({ dateFormat: 'DD/MM/YYYY', dateTrigger: '@' });
  });
});

describe('formatMoment (pins what the Swift moment→ICU translation pinned)', () => {
  const d = day(2026, 11, 13); // a Friday
  it('formats the common board formats', () => {
    expect(formatMoment(d, 'MM-DD-YY')).toBe('11-13-26');
    expect(formatMoment(d, 'YYYY-MM-DD')).toBe('2026-11-13');
    expect(formatMoment(d, 'YYYY-MM-DD HH:mm')).toBe('2026-11-13 00:00'); // a due date is the start of the day
    expect(formatMoment(d, 'MMM D, YY')).toBe('Nov 13, 26');
    expect(formatMoment(d, 'dddd, MMMM Do')).toBe('Friday, November 13'); // no ordinal suffix, like the Swift port
    expect(formatMoment(d, 'ddd MMM D')).toBe('Fri Nov 13');
  });
  it('DD is the day of the MONTH (in ICU it would be the day of the year: @{11-317-26})', () => {
    expect(formatMoment(day(2026, 11, 9), 'MM-DD-YY')).toBe('11-09-26');
    expect(formatMoment(day(2026, 11, 9), 'M/D')).toBe('11/9');
    expect(formatMoment(day(2026, 12, 31), 'DD')).toBe('31');
  });
  it('unknown runs pass through untouched, so an exotic format renders visibly raw, never a silently wrong date', () => {
    expect(formatMoment(d, 'QQ-SS-Z')).toBe('QQ-SS-Z');
    expect(formatMoment(d, '')).toBe('');
    expect(formatMoment(d, '[due] YYYY')).toBe('[due] 2026');
  });
  it('pads years and takes the last two digits for YY', () => {
    expect(formatMoment(day(2005, 3, 4), 'YYYY-MM-DD')).toBe('2005-03-04');
    expect(formatMoment(day(2005, 3, 4), 'YY')).toBe('05');
  });
});

describe('tokens', () => {
  it('matches the live board’s Test card for Nov 13 2026', () => { expect(tokenFor(day(2026, 11, 13), live)).toBe('@{11-13-26}'); });
  it('uses the kanban default format', () => { expect(tokenFor(day(2026, 11, 13), DEFAULT_BOARD_SETTINGS)).toBe('@{2026-11-13}'); });
  it('uses a custom trigger', () => { expect(tokenFor(day(2026, 11, 13), { dateFormat: 'MM-DD-YY', dateTrigger: 'due' })).toBe('due{11-13-26}'); });

  it('round-trips', () => { expect(dateFromToken(tokenFor(day(2026, 11, 14), live), live, NOW)).toEqual(day(2026, 11, 14)); });
  it('finds the token inside card text', () => { expect(dateFromTokenIn('fix the leak @{11-14-26}', live, NOW)).toEqual(day(2026, 11, 14)); });
  it('garbage is null (hand-typed garbage stays plain text on the board)', () => {
    for (const bad of ['@{banana}', '@{99-99-99}', '@{}', 'no token here', '@{11-14}', '@{11-14-26-1}', '@{13-01-26}', '@{00-10-26}']) {
      expect(dateFromToken(bad, live, NOW), bad).toBeNull();
    }
  });
  it('impossible dates are null: Feb 30, Apr 31, non-leap Feb 29', () => {
    for (const bad of ['@{02-30-26}', '@{04-31-26}', '@{02-29-27}']) expect(dateFromToken(bad, live, NOW), bad).toBeNull();
    expect(dateFromToken('@{02-29-28}', live, NOW)).toEqual(day(2028, 2, 29)); // a real leap day
  });
  it('the leap-year century rule: 1900 and 2100 are NOT leap years, 2000 and 2400 are', () => {
    const iso: BoardDateSettings = { dateFormat: 'YYYY-MM-DD', dateTrigger: '@' };
    expect(dateFromToken('@{1900-02-29}', iso, NOW)).toBeNull();
    expect(dateFromToken('@{2100-02-29}', iso, NOW)).toBeNull();
    expect(dateFromToken('@{2000-02-29}', iso, NOW)).toEqual(day(2000, 2, 29));
    expect(dateFromToken('@{2400-02-29}', iso, NOW)).toEqual(day(2400, 2, 29));
  });
  it('two-digit years use moment.js’s FIXED pivot (documented): 68 and below are 20xx, above 68 are 19xx, whatever today is', () => {
    expect(dateFromToken('@{01-01-26}', live, NOW)).toEqual(day(2026, 1, 1));
    expect(dateFromToken('@{12-31-45}', live, NOW)).toEqual(day(2045, 12, 31));
    expect(dateFromToken('@{01-01-68}', live, NOW)).toEqual(day(2068, 1, 1));  // 68 is the last 20xx
    expect(dateFromToken('@{01-01-69}', live, NOW)).toEqual(day(1969, 1, 1));  // 69 is the first 19xx
    expect(dateFromToken('@{01-01-99}', live, NOW)).toEqual(day(1999, 1, 1));
    expect(dateFromToken('@{01-01-00}', live, NOW)).toEqual(day(2000, 1, 1));
    // …and it does not move with the clock (a relative window would disagree with the board in some years).
    expect(dateFromToken('@{01-01-69}', live, new Date(Date.UTC(2090, 5, 1)))).toEqual(day(1969, 1, 1));
  });
  it('parses each supported format back', () => {
    const d = day(2026, 11, 13);
    for (const fmt of ['YYYY-MM-DD', 'MM-DD-YY', 'M/D/YYYY', 'MMM D, YYYY', 'MMMM D YYYY', 'dddd, MMMM Do', 'DD.MM.YYYY', 'ddd MMM D YYYY']) {
      const s: BoardDateSettings = { dateFormat: fmt, dateTrigger: '@' };
      const parsed = dateFromToken(tokenFor(d, s), s, NOW);
      expect(parsed, fmt).not.toBeNull();
      expect(parsed!.month, fmt).toBe(11);
      expect(parsed!.day, fmt).toBe(13);
    }
  });
  it('a format with no year parses to the current year (the board is the authority on what it shows)', () => {
    const s: BoardDateSettings = { dateFormat: 'MMM D', dateTrigger: '@' };
    expect(dateFromToken('@{Nov 13}', s, NOW)).toEqual(day(2026, 11, 13));
  });
  it('month names are case-insensitive but must be real months', () => {
    const s: BoardDateSettings = { dateFormat: 'MMM D YYYY', dateTrigger: '@' };
    expect(dateFromToken('@{nov 13 2026}', s, NOW)).toEqual(day(2026, 11, 13));
    expect(dateFromToken('@{Foo 13 2026}', s, NOW)).toBeNull();
  });
});

describe('tokenRange', () => {
  it('locates the first token only', () => {
    expect(tokenRange('a @{11-14-26} b', live)).toEqual({ location: 2, length: 11 });
    expect(tokenRange('no tokens', live)).toBeNull();
    expect(tokenRange('a @{1} @{2}', live)).toEqual({ location: 2, length: 4 });
  });
  it('tokens never span a newline', () => { expect(tokenRange('@{11-14\n-26}', live)).toBeNull(); });
  it('locations are UTF-16 offsets (what the editor’s selection uses): an emoji before the token counts as 2', () => {
    expect(tokenRange('✨ @{11-14-26}', live)).toEqual({ location: 2, length: 11 });
    expect(tokenRange('👩‍💻 @{11-14-26}', live)).toEqual({ location: '👩‍💻 '.length, length: 11 });
  });
  it('a trigger with regex metacharacters is matched literally', () => {
    expect(tokenRange('x $.*{11-14-26} y', { dateFormat: 'MM-DD-YY', dateTrigger: '$.*' })).toEqual({ location: 2, length: 13 });
    expect(tokenRange('x aXXb{11-14-26}', { dateFormat: 'MM-DD-YY', dateTrigger: '$.*' })).toBeNull();
  });
  it('an empty trigger finds nothing', () => { expect(tokenRange('{11-14-26}', { dateFormat: 'MM-DD-YY', dateTrigger: '' })).toBeNull(); });
});

describe('isTrigger', () => {
  it('true outside an existing token, mid-word included (like the Kanban plugin)', () => {
    expect(isTrigger(4, 'fix @ the leak', live)).toBe(true);
    expect(isTrigger(0, '@idea', live)).toBe(true);
  });
  it('false inside a token, out of bounds, or for a multi-character trigger', () => {
    const text = 'a @{11-14-26} b';
    for (let i = 2; i <= 12; i++) expect(isTrigger(i, text, live), String(i)).toBe(false);
    expect(isTrigger(15, text, live)).toBe(false);
    expect(isTrigger(-1, text, live)).toBe(false);
    expect(isTrigger(4, 'fix due the leak', { dateFormat: 'MM-DD-YY', dateTrigger: 'due' })).toBe(false);
  });
  it('false when the character at that position is not the trigger', () => { expect(isTrigger(1, 'a b', live)).toBe(false); });
});

describe('applyPick', () => {
  it('replaces the typed trigger', () => {
    const r = applyPick('fix the leak @', { location: 13, length: 1 }, day(2026, 11, 14), live)!;
    expect(r.text).toBe('fix the leak @{11-14-26}');
    expect(r.caretOffset).toBe(r.text.length);
  });
  it('replaces an existing token: one due date per card', () => {
    const r = applyPick('fix the leak @{11-14-26} tonight', { location: 13, length: 11 }, day(2026, 11, 16), live)!;
    expect(r.text).toBe('fix the leak @{11-16-26} tonight');
    expect(r.caretOffset).toBe(24);
  });
  it('removes an old token elsewhere in the text, swallowing one preceding space', () => {
    expect(applyPick('hi @{11-14-26} call @ dad', { location: 20, length: 1 }, day(2026, 11, 15), live)!.text).toBe('hi call @{11-15-26} dad');
    expect(applyPick('call @ dad @{11-14-26}', { location: 5, length: 1 }, day(2026, 11, 15), live)!.text).toBe('call @{11-15-26} dad');
  });
  it('is null for an out-of-bounds range', () => {
    expect(applyPick('short', { location: 3, length: 9 }, day(2026, 11, 14), live)).toBeNull();
    expect(applyPick('short', { location: -1, length: 1 }, day(2026, 11, 14), live)).toBeNull();
    expect(applyPick('short', { location: 2, length: -1 }, day(2026, 11, 14), live)).toBeNull();
  });
  it('replaces the trigger plus a typed word whole ("@today")', () => {
    const r = applyPick('fix the leak @today', { location: 13, length: 6 }, day(2026, 11, 13), live)!;
    expect(r.text).toBe('fix the leak @{11-13-26}');
    expect(r.caretOffset).toBe(24);
  });
  it('the caret and ranges are UTF-16 offsets: an emoji before the trigger shifts them correctly', () => {
    const text = '✨ @';
    const r = applyPick(text, { location: 2, length: 1 }, day(2026, 11, 14), live)!;
    expect(r.text).toBe('✨ @{11-14-26}');
    expect(r.caretOffset).toBe(r.text.length);
  });
  it('the old token in the middle: text on both sides is preserved', () => {
    expect(applyPick('a @{11-14-26} b @ c', { location: 16, length: 1 }, day(2026, 11, 15), live)!.text).toBe('a b @{11-15-26} c');
  });
});

describe('quick chips', () => {
  it('today and tomorrow are relative to the New York calendar, not the machine’s or UTC', () => {
    const lateFriday = nyNov(13, 23); // 11 pm Friday in New York = 04:00 UTC Saturday
    expect(todayIn(lateFriday, NY)).toEqual(day(2026, 11, 13));
    expect(tomorrowIn(lateFriday, NY)).toEqual(day(2026, 11, 14));
  });
  it('the same instant is a different day in another zone', () => {
    const lateFriday = nyNov(13, 23);
    expect(todayIn(lateFriday, 'Asia/Tokyo')).toEqual(day(2026, 11, 14));
    expect(todayIn(lateFriday, 'UTC')).toEqual(day(2026, 11, 14));
  });
  it('next Monday from a Monday jumps a full week (today counts as THIS Monday)', () => {
    expect(nextMonday(nyNov(9), NY)).toEqual(day(2026, 11, 16)); // 2026-11-09 is a Monday
  });
  it('next Monday from a Friday is three days ahead; from a Sunday, one', () => {
    expect(nextMonday(nyNov(13), NY)).toEqual(day(2026, 11, 16));
    expect(nextMonday(nyNov(15), NY)).toEqual(day(2026, 11, 16));
  });
  it('next Monday from Tuesday through Saturday lands on the same following Monday', () => {
    for (const d of [10, 11, 12, 13, 14]) expect(nextMonday(nyNov(d), NY), String(d)).toEqual(day(2026, 11, 16));
  });
  it('arithmetic crosses month and year ends and DST changes', () => {
    expect(tomorrowIn(new Date(Date.UTC(2026, 11, 31, 17)), NY)).toEqual(day(2027, 1, 1));
    expect(tomorrowIn(new Date(Date.UTC(2028, 1, 28, 17)), NY)).toEqual(day(2028, 2, 29));
    expect(tomorrowIn(new Date(Date.UTC(2026, 2, 7, 17)), NY)).toEqual(day(2026, 3, 8));   // the day DST starts in the US
    expect(nextMonday(new Date(Date.UTC(2026, 2, 6, 17)), NY)).toEqual(day(2026, 3, 9));   // Fri Mar 6 → Mon Mar 9, over the spring-forward
    expect(nextMonday(new Date(Date.UTC(2026, 9, 30, 17)), NY)).toEqual(day(2026, 11, 2));  // Fri Oct 30 → Mon Nov 2, over the fall-back
  });
});

describe('friendlyText', () => {
  it('matches the success-flash shape: "Sat, Nov 14" (Nov 14 2026 is a Saturday; the Swift plan doc said Fri)', () => {
    expect(friendlyText(day(2026, 11, 14), 'en-US')).toBe('Sat, Nov 14');
    expect(friendlyText(day(2026, 1, 1), 'en-US')).toBe('Thu, Jan 1');
  });
});

describe('typeAheadOptions', () => {
  const labels = (prefix: string) => typeAheadOptions(prefix, nyNov(13), NY).map(o => o.label);
  it('an empty prefix returns the full list in display order', () => { expect(labels('')).toEqual(['Today', 'Tomorrow', 'Next Monday']); });
  it('narrows by case-insensitive prefix', () => {
    expect(labels('t')).toEqual(['Today', 'Tomorrow']);
    expect(labels('TOD')).toEqual(['Today']); // Tomorrow spells t-o-m
    expect(labels('tomo')).toEqual(['Tomorrow']);
    expect(labels('TOMORROW')).toEqual(['Tomorrow']);
    expect(labels('next')).toEqual(['Next Monday']);
    expect(labels('Next M')).toEqual(['Next Monday']); // the space matches
  });
  it('option dates match the chip helpers', () => {
    const o = Object.fromEntries(typeAheadOptions('', nyNov(13), NY).map(x => [x.label, x.date]));
    expect(o).toEqual({ Today: day(2026, 11, 13), Tomorrow: day(2026, 11, 14), 'Next Monday': day(2026, 11, 16) });
  });
  it('no match is empty: the caller’s signal to close the picker', () => {
    for (const w of ['todays', 'x', '{', '@', 'next week', 'tommorow']) expect(labels(w), w).toEqual([]);
  });
});
