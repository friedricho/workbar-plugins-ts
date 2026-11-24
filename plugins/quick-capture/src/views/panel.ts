// The capture bar page: forwards the field's events to the CaptureEditor (src/editor.ts) and renders what comes back.
// All the rules live in the editor and view-model, which are unit-tested; this file is only DOM plumbing.
// Bundled to views/panel.js (one plain script: the host serves views with script-src 'self').
import { CaptureEditor, type Effect, type PickerView, type Selection } from '../editor.js';
import type { BoardDateSettings, CivilDate } from '../due-date.js';
import type { Mode, StateMessage } from '../protocol.js';
import { barView, fieldHeight, panelHeight } from '../view-model.js';

interface Bridge {
  post(m: unknown): void;
  hide(): void;
  onMessage(l: (m: unknown) => void): () => void;
  onShown(l: () => void): () => void;
}
const bridge = (window as unknown as { workbarPanel: Bridge }).workbarPanel;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const field = $<HTMLTextAreaElement>('field');
const picker = $('picker');
const bar = $('bar');

let settings: BoardDateSettings = { dateFormat: 'YYYY-MM-DD', dateTrigger: '@' };
let tz = 'UTC';
let clockOffset = 0; // plugin clock minus page clock, so "today" agrees with the plugin's success line
let mode: Mode = 'editing';
let message: string | undefined;
let lastHeight = 0;

const env = () => ({ settings, now: () => new Date(Date.now() + clockOffset), timeZone: tz });
const editor = new CaptureEditor(env());

const selection = (): Selection => ({ start: field.selectionStart, end: field.selectionEnd });

function lineCount(): number {
  // Measure the wrapped height, not the number of "\n": a long line wraps. scrollHeight is exact once the height is reset.
  field.style.height = 'auto';
  return Math.max(1, Math.round(field.scrollHeight / 22));
}

function render(): void {
  const pv: PickerView | null = editor.pickerView();
  const v = barView(mode, message, pv);
  bar.dataset.mode = mode;
  $('glyph').hidden = !(v.show.field || v.show.setup);
  field.hidden = !v.show.field;
  field.readOnly = v.fieldDisabled;
  $('hint').hidden = !v.show.hint; $('hint').textContent = v.hint;
  $('gear').hidden = !v.show.gear;
  $('flash').hidden = !v.show.flash; $('flash').textContent = v.flash;
  $('setup').hidden = !v.show.setup; $('setup-button').hidden = !v.show.setup;
  $('error').hidden = !v.show.error; $('error-text').textContent = v.error;
  picker.hidden = !v.show.picker;
  if (v.show.picker && pv) renderPicker(pv);
  const lines = v.show.field ? lineCount() : 1;
  if (v.show.field) field.style.height = `${fieldHeight(lines)}px`;
  const h = panelHeight({ fieldLines: lines, showError: v.show.error, picker: v.show.picker ? pv : null });
  if (h !== lastHeight) { lastHeight = h; bridge.post({ type: 'resize', height: h }); }
}

const el = (tag: string, cls: string, text?: string): HTMLElement => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const keepFocus = (b: HTMLElement) => b.addEventListener('mousedown', e => e.preventDefault()); // a click must never steal the field's focus

function renderPicker(pv: PickerView): void {
  picker.replaceChildren();
  if (pv.typeAhead) {
    const list = el('div', 'ahead');
    pv.typeAhead.forEach((o, i) => {
      const row = el('button', `ahead-row${o.selected ? ' selected' : ''}`); row.setAttribute('type', 'button');
      row.append(el('span', 'ahead-label', o.label), el('span', 'ahead-date', o.friendly));
      keepFocus(row);
      row.addEventListener('click', () => apply(editor.pick(editor.picker!.matches[i]!.date)));
      list.append(row);
    });
    picker.append(list);
    return;
  }
  const head = el('div', 'picker-head', undefined);
  const prev = el('button', 'arrow', '‹'); const next = el('button', 'arrow', '›');
  for (const [b, d] of [[prev, -1], [next, 1]] as const) { b.setAttribute('type', 'button'); keepFocus(b); b.addEventListener('click', () => { editor.changeMonth(d); render(); }); }
  head.append(el('span', 'picker-title', pv.title), prev, next);
  const weekdays = el('div', 'weekdays'); for (const w of pv.weekdays) weekdays.append(el('span', '', w));
  picker.append(head, weekdays);
  for (const row of pv.rows) {
    const week = el('div', 'week');
    for (const c of row) {
      if (!c) { week.append(el('span', 'blank')); continue; }
      const b = el('button', `cell${c.selected ? ' selected' : ''}${c.today ? ' today' : ''}`, String(c.date.day)); b.setAttribute('type', 'button');
      keepFocus(b); b.addEventListener('click', () => apply(editor.pick(c.date as CivilDate)));
      week.append(b);
    }
    picker.append(week);
  }
  const chips = el('div', 'chips');
  for (const c of pv.chips) { const b = el('button', 'chip', c.label); b.setAttribute('type', 'button'); keepFocus(b); b.addEventListener('click', () => apply(editor.pick(c.date)));  chips.append(b); }
  picker.append(chips);
}

function apply(u: { effects: Effect[]; dom?: { text: string; selection: Selection } }): void {
  if (u.dom) { field.value = u.dom.text; field.setSelectionRange(u.dom.selection.start, u.dom.selection.end); editor.text = u.dom.text; }
  for (const e of u.effects) {
    if (e.type === 'submit') bridge.post({ type: 'submit', text: e.text });
    else bridge.hide();
  }
  render();
}

field.addEventListener('input', () => { editor.input(field.value, selection()); render(); });
field.addEventListener('keydown', e => {
  if (e.isComposing) return; // an IME is mid-word: Enter confirms the composition, never submits
  const u = editor.keydown({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
  if (u.handled) e.preventDefault();
  apply(u);
});
// Arrow/Home/End/click move the caret AFTER the key's default action: read the selection then.
field.addEventListener('keyup', e => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') { editor.moved(selection()); render(); } });
field.addEventListener('mouseup', () => { editor.clicked(selection()); render(); });

$('gear').addEventListener('click', () => bridge.post({ type: 'openSettings' }));
$('setup-button').addEventListener('click', () => bridge.post({ type: 'openSettings' }));
$('error-settings').addEventListener('click', () => bridge.post({ type: 'openSettings' }));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.activeElement !== field) { e.preventDefault(); bridge.hide(); } });

bridge.onMessage(raw => {
  const m = raw as Partial<StateMessage> | null;
  if (!m || m.type !== 'state' || typeof m.mode !== 'string') return;
  const fresh = m.mode === 'editing' && mode !== 'error' && mode !== 'submitting'; // a new show starts empty; an error keeps the text
  mode = m.mode as Mode; message = m.message;
  settings = { dateFormat: m.dateFormat ?? settings.dateFormat, dateTrigger: m.dateTrigger ?? settings.dateTrigger };
  tz = m.tz ?? tz;
  if (m.nowIso) clockOffset = Date.parse(m.nowIso) - Date.now();
  editor.setEnv(env()); editor.setMode(mode);
  if (fresh) { editor.reset(); field.value = ''; }
  render();
  if (mode === 'editing' || mode === 'error') { field.focus(); if (fresh) field.select(); }
});

// A show: reset, focus. (The plugin also sends a fresh state; this covers the instant before it arrives.)
bridge.onShown(() => { lastHeight = 0; editor.reset(); field.value = ''; mode = mode === 'unconfigured' ? 'unconfigured' : 'editing'; editor.setMode(mode); render(); field.focus(); });

bridge.post({ type: 'ready' });
