// What the bar shows in each mode, and how tall the panel must be. Pure data: the page just applies it.
import { describe, expect, it } from 'vitest';
import { barView, ERROR_HEIGHT, fieldHeight, GRID_HEIGHT, hintFor, panelHeight, typeAheadHeight } from '../src/view-model.js';
import type { PickerView } from '../src/editor.js';

const grid: PickerView = { title: 'November 2026', weekdays: [], rows: [], chips: [], typeAhead: null };
const ahead = (n: number): PickerView => ({ ...grid, typeAhead: Array.from({ length: n }, (_, i) => ({ label: `L${i}`, friendly: '', selected: i === 0 })) });

describe('barView', () => {
  it('editing: field, hint and gear; no flash, setup or error', () => {
    expect(barView('editing', undefined, null).show).toEqual({ field: true, hint: true, gear: true, flash: false, setup: false, error: false, picker: false });
  });
  it('submitting: the field stays visible but read-only (it keeps the user’s text and focus)', () => {
    const v = barView('submitting', undefined, null);
    expect(v.show.field).toBe(true);
    expect(v.fieldDisabled).toBe(true);
    expect(barView('editing', undefined, null).fieldDisabled).toBe(false);
  });
  it('success: ONLY the flash, with the plugin’s message', () => {
    const v = barView('success', 'Added to Today · due Fri, Nov 27', null);
    expect(v.show).toEqual({ field: false, hint: false, gear: false, flash: true, setup: false, error: false, picker: false });
    expect(v.flash).toBe('Added to Today · due Fri, Nov 27');
  });
  it('error: the field AND the loud message, editable again so the user can fix and retry', () => {
    const v = barView('error', 'Couldn’t save the board: disk full', null);
    expect(v.show).toMatchObject({ field: true, error: true });
    expect(v.error).toBe('Couldn’t save the board: disk full');
    expect(v.fieldDisabled).toBe(false);
  });
  it('unconfigured: the set-up row, with no field', () => {
    expect(barView('unconfigured', undefined, null).show).toEqual({ field: false, hint: false, gear: false, flash: false, setup: true, error: false, picker: false });
  });
  it('the picker shows only while editing (never over the flash or the set-up row)', () => {
    expect(barView('editing', undefined, grid).show.picker).toBe(true);
    expect(barView('error', 'x', grid).show.picker).toBe(true);
    expect(barView('success', 'x', grid).show.picker).toBe(false);
    expect(barView('unconfigured', undefined, grid).show.picker).toBe(false);
  });
  it('a missing message still shows something readable, never an empty flash or an empty error', () => {
    expect(barView('success', undefined, null).flash).not.toBe('');
    expect(barView('error', undefined, null).error).not.toBe('');
  });
});

describe('hintFor', () => {
  it('says what Enter and Escape do right now', () => {
    expect(hintFor(null)).toBe('⏎ to add · ⇧⏎ newline · ⎋ cancel');
    expect(hintFor(grid)).toBe('⏎ pick date · ⎋ close');
    expect(hintFor(ahead(2))).toBe('↑↓ choose · ⏎ pick · ⎋ close');
  });
});

describe('heights', () => {
  it('the field grows to three lines, then scrolls', () => {
    expect([0, 1, 2, 3, 4, 50].map(fieldHeight)).toEqual([22, 22, 44, 66, 66, 66]);
  });
  it('a single line is the 46 px bar the manifest declares (so the first resize never shrinks it)', () => { expect(panelHeight({ fieldLines: 1, showError: false, picker: null })).toBe(46); });
  it('two and three lines grow by one line each', () => {
    expect(panelHeight({ fieldLines: 2, showError: false, picker: null })).toBe(60);
    expect(panelHeight({ fieldLines: 3, showError: false, picker: null })).toBe(82);
    expect(panelHeight({ fieldLines: 9, showError: false, picker: null })).toBe(82); // capped at three lines
  });
  it('adds the error line and the open picker (grid, or the narrowed list sized by its rows)', () => {
    expect(panelHeight({ fieldLines: 1, showError: true, picker: null })).toBe(46 + ERROR_HEIGHT);
    expect(panelHeight({ fieldLines: 1, showError: false, picker: grid })).toBe(46 + GRID_HEIGHT);
    expect(panelHeight({ fieldLines: 1, showError: false, picker: ahead(2) })).toBe(46 + typeAheadHeight(2));
    expect(typeAheadHeight(3)).toBe(88);
    expect(panelHeight({ fieldLines: 3, showError: true, picker: grid })).toBe(66 + 16 + ERROR_HEIGHT + GRID_HEIGHT);
  });
  it('never smaller than the declared bar', () => { expect(panelHeight({ fieldLines: 0, showError: false, picker: null })).toBe(46); });
});
