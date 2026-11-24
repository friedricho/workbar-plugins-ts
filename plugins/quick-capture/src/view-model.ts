// What the capture bar shows for a given mode, as plain data: the page's script only has to apply it to the DOM.
// Pure, so every mode's rules (what is visible, the hint text, whether the field is editable) are unit-tested.
import type { Mode } from './protocol.js';
import type { PickerView } from './editor.js';

export interface BarView {
  readonly mode: Mode;
  /** Which parts of the bar are visible. */
  readonly show: { readonly field: boolean; readonly hint: boolean; readonly gear: boolean; readonly flash: boolean; readonly setup: boolean; readonly error: boolean; readonly picker: boolean };
  readonly fieldDisabled: boolean;
  readonly hint: string;
  readonly flash: string;
  readonly error: string;
}

/** The key hint under the bar's right edge: what Enter and Escape do right now. */
export function hintFor(picker: PickerView | null): string {
  if (picker) return picker.typeAhead ? '↑↓ choose · ⏎ pick · ⎋ close' : '⏎ pick date · ⎋ close';
  return '⏎ to add · ⇧⏎ newline · ⎋ cancel';
}

export function barView(mode: Mode, message: string | undefined, picker: PickerView | null): BarView {
  const editing = mode === 'editing' || mode === 'submitting' || mode === 'error';
  return {
    mode,
    show: {
      field: editing, hint: editing, gear: editing, flash: mode === 'success', setup: mode === 'unconfigured',
      error: mode === 'error', picker: editing && picker !== null,
    },
    // While a card is being written the field is read-only (not disabled: a disabled field loses focus, and the
    // user's text must stay put and selectable if the write fails).
    fieldDisabled: mode === 'submitting',
    hint: hintFor(picker),
    flash: mode === 'success' ? (message ?? 'Added') : '',
    error: mode === 'error' ? (message ?? 'Couldn’t save the card') : '',
  };
}

/** Height of the field for `lineCount` lines: auto-grows to a cap of three, then scrolls (the Swift bar's rule). */
export const LINE_HEIGHT = 22;
export const MAX_LINES = 3;
export const fieldHeight = (lineCount: number): number => LINE_HEIGHT * Math.min(Math.max(lineCount, 1), MAX_LINES);

/** The panel's height, from what is showing: the row, plus the error line, plus the open picker.
 *  The picker's grid is always six rows, so its height is stable across months. */
export const ROW_PADDING = 16;   // 8px above and below the row
/** The row is never shorter than one line plus 8: with the padding that is the 46 px bar the manifest declares. */
export const ROW_MIN = LINE_HEIGHT + 8;
export const ERROR_HEIGHT = 56;
export const GRID_HEIGHT = 232;
export const typeAheadHeight = (count: number): number => 10 + count * 26;

export function panelHeight(o: { fieldLines: number; showError: boolean; picker: PickerView | null }): number {
  let h = Math.max(ROW_MIN, fieldHeight(o.fieldLines)) + ROW_PADDING;
  if (o.showError) h += ERROR_HEIGHT;
  if (o.picker) h += o.picker.typeAhead ? typeAheadHeight(o.picker.typeAhead.length) : GRID_HEIGHT;
  return h;
}
