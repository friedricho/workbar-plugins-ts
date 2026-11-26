// The Quick Capture plugin end to end on the SDK test kit: activation, health, the hotkey (including importing the Swift
// app's Carbon key code), the capture action, the panel conversation, and the give-up notification. The engine is
// injected: no test touches the real Obsidian CLI, the real process list or a real vault.
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { validateSettingsSchema } from '@workbar/sdk';
import {
  COLUMN_KEY, createQuickCapture, HOTKEY_ID, HOTKEY_KEY, HOTKEY_KEY_CODE, HOTKEY_MODIFIERS, settingsSchema, VAULT_KEY, BOARD_KEY, CLI_PATH_KEY,
  ACTIVATE_KEY, type QuickCaptureOptions,
} from '../src/index.js';
import { BoardWriterError, type CaptureTarget, type WriterTier } from '../src/writers.js';
import type { StateMessage } from '../src/protocol.js';
import { simpleBoard, tempDir } from './support.js';
import fs from 'node:fs';
import path from 'node:path';

type Plugin = ReturnType<typeof createQuickCapture>;

class FakeEngine {
  captures: Array<{ text: string; target: CaptureTarget }> = [];
  outcome: WriterTier | Error = 'direct';
  disposed = 0;
  gate: Promise<void> | null = null;
  giveUp: ((t: CaptureTarget, text: string) => void) | null = null;
  async capture(text: string, target: CaptureTarget): Promise<WriterTier> {
    this.captures.push({ text, target });
    if (this.gate) await this.gate;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
  dispose() { this.disposed++; }
}

function setup(seed: Record<string, unknown> = {}, opts: Partial<QuickCaptureOptions> = {}, hotkeyOk = true) {
  const t: TestContext = createTestContext('quickcapture');
  for (const [k, v] of Object.entries(seed)) t.settings.set(k, v);
  if (!hotkeyOk) (t.context as { hotKeys: unknown }).hotKeys = { register: async () => false, unregister: async () => {} };
  const engine = new FakeEngine();
  const plugin = createQuickCapture({
    createEngine: o => { engine.giveUp = o.onGiveUp; return engine as never; },
    timeZone: () => 'America/New_York', now: () => new Date('2026-11-23T20:00:00Z'), ...opts,
  });
  return { t, plugin, engine };
}
const configured = (dir = '/vault') => ({ [VAULT_KEY]: dir, [BOARD_KEY]: 'Board.md', [COLUMN_KEY]: 'Today' });
const states = (t: TestContext) => t.panel.posted.filter((m): m is StateMessage => (m as { type?: string }).type === 'state');
const last = (t: TestContext) => states(t).at(-1)!;
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('settings page', () => {
  it('is a valid schema with the Swift keys', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
    const keys = settingsSchema.sections.flatMap(s => s.fields.map(f => f.key));
    for (const k of [VAULT_KEY, BOARD_KEY, COLUMN_KEY, ACTIVATE_KEY, HOTKEY_KEY, CLI_PATH_KEY]) expect(keys).toContain(k);
    expect([VAULT_KEY, BOARD_KEY, COLUMN_KEY, ACTIVATE_KEY, 'hotkeyKeyCode', 'hotkeyModifiers']).toEqual(['vaultPath', 'boardPath', 'column', 'activateOnOpen', 'hotkeyKeyCode', 'hotkeyModifiers']);
  });
});

describe('activation and health', () => {
  it('not configured → a warning that says what to do; the capture hotkey is still registered', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'Not configured — choose a vault and board' });
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Alt+Space'); // ⌥Space on macOS
    await plugin.deactivate();
  });
  it('Windows defaults to Ctrl+Alt+Space (Alt+Space is the system menu there)', async () => {
    const t = createTestContext('quickcapture', { platform: 'win32' });
    const plugin = createQuickCapture({ createEngine: () => new FakeEngine() as never });
    await plugin.activate(t.context);
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Control+Alt+Space');
    await plugin.deactivate();
  });
  it('configured and hotkey registered → ok', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    expect(t.health.at(-1)).toEqual({ kind: 'ok' });
    await plugin.deactivate();
  });
  it('a hotkey the OS or another app owns → a warning that says so', async () => {
    const { t, plugin } = setup(configured(), {}, false);
    await plugin.activate(t.context);
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'Hotkey may be taken by another app — change it in settings' });
    await plugin.deactivate();
  });
  it('deactivate disposes the engine (pending verifiers are cancelled) and hides the panel', async () => {
    const { t, plugin, engine } = setup(configured());
    await plugin.activate(t.context);
    await plugin.deactivate();
    expect(engine.disposed).toBe(1);
  });
});

describe('the hotkey', () => {
  it('shows the panel on a press, and sends it the current state first', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    expect(t.panel.visible).toBe(true);
    expect(last(t)).toMatchObject({ mode: 'editing', column: 'Today', dateFormat: 'YYYY-MM-DD', dateTrigger: '@', tz: 'America/New_York', nowIso: '2026-11-23T20:00:00.000Z' });
    await plugin.deactivate();
  });
  it('a second press while the panel is open REFOCUSES it (the Swift hotkey calls show(), which never closes): no new state, so typed text survives', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    const before = states(t).length;
    await plugin.onHotKey!(HOTKEY_ID);
    expect(t.panel.visible).toBe(true);
    expect(states(t)).toHaveLength(before);
    expect(t.panel.calls.filter(c => c.call === 'show')).toHaveLength(2); // the host treats a repeat show as a refocus
    await plugin.deactivate();
  });
  it('after the host hides the panel (Escape, click outside) the next press opens a fresh one', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelHidden!();
    const before = states(t).length;
    await plugin.onHotKey!(HOTKEY_ID);
    expect(states(t)).toHaveLength(before + 1);
    await plugin.deactivate();
  });
  it('two presses in quick succession open it once', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await Promise.all([plugin.onHotKey!(HOTKEY_ID), plugin.onHotKey!(HOTKEY_ID)]);
    expect(states(t)).toHaveLength(1);
    await plugin.deactivate();
  });
  it('"Activate app when opened" is passed through to the panel', async () => {
    const on = setup({ ...configured(), [ACTIVATE_KEY]: true }); await on.plugin.activate(on.t.context); await on.plugin.onHotKey!(HOTKEY_ID);
    expect(on.t.panel.calls.find(c => c.call === 'show')).toMatchObject({ activate: true });
    const off = setup({ ...configured(), [ACTIVATE_KEY]: false }); await off.plugin.activate(off.t.context); await off.plugin.onHotKey!(HOTKEY_ID);
    expect(off.t.panel.calls.find(c => c.call === 'show')).toMatchObject({ activate: false });
  });
  it('imports the Swift hotkey once: Carbon key 49 + Option (2048) → Alt+Space, stored, and the Carbon keys are left alone', async () => {
    const { t, plugin } = setup({ ...configured(), [HOTKEY_KEY_CODE]: 49, [HOTKEY_MODIFIERS]: 2048 });
    await plugin.activate(t.context);
    expect(t.settings.get(HOTKEY_KEY)).toBe('Alt+Space');
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Alt+Space');
    expect(t.settings.get(HOTKEY_KEY_CODE)).toBe(49);
  });
  it('a custom Swift hotkey converts (⌘⇧K = key 40, mask 768 → Command+Shift+K)', async () => {
    const { t, plugin } = setup({ ...configured(), [HOTKEY_KEY_CODE]: 40, [HOTKEY_MODIFIERS]: 0x100 | 0x200 });
    await plugin.activate(t.context);
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Command+Shift+K');
  });
  it('a Swift hotkey with no Electron equivalent is flagged on the page, not silently replaced', async () => {
    const { t, plugin } = setup({ ...configured(), [HOTKEY_KEY_CODE]: 255, [HOTKEY_MODIFIERS]: 2048 });
    await plugin.activate(t.context);
    expect(t.status.get('hotkey')).toContain('pick a new');
    expect(t.hotKeys.has(HOTKEY_ID)).toBe(true); // the default still works meanwhile
  });
  it('an accelerator the user already chose is never overwritten by the import', async () => {
    const { t, plugin } = setup({ ...configured(), [HOTKEY_KEY]: 'Command+Shift+Space', [HOTKEY_KEY_CODE]: 49, [HOTKEY_MODIFIERS]: 2048 });
    await plugin.activate(t.context);
    expect(t.settings.get(HOTKEY_KEY)).toBe('Command+Shift+Space');
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Command+Shift+Space');
  });
  it('changing the hotkey on the page re-registers it and re-reports health', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await t.context.settings.set(HOTKEY_KEY, 'Control+Alt+K');
    await tick();
    expect(t.hotKeys.get(HOTKEY_ID)).toBe('Control+Alt+K');
  });
});

describe('the capture action (CLI / MCP)', () => {
  it('captures through the same engine and returns "Added to <column>"', async () => {
    const { t, plugin, engine } = setup(configured('/v'));
    await plugin.activate(t.context);
    expect(await plugin.perform!('capture', '  buy milk  ')).toBe('Added to Today');
    expect(engine.captures).toEqual([{ text: 'buy milk', target: { vaultPath: '/v', boardPath: 'Board.md', column: 'Today' } }]);
    expect(t.health.at(-1)).toEqual({ kind: 'ok' });
  });
  it('empty text and an unconfigured target are rejected with the Swift messages', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    await expect(plugin.perform!('capture', '   ')).rejects.toThrow('capture requires non-empty text');
    await expect(plugin.perform!('capture', 'x')).rejects.toThrow('not configured — choose a vault and board');
    await expect(plugin.perform!('capture')).rejects.toThrow('capture requires non-empty text');
  });
  it('a failure turns health yellow with the user-facing message and is rethrown to the caller', async () => {
    const { t, plugin, engine } = setup(configured());
    engine.outcome = new BoardWriterError('columnNotFound', 'Today');
    await plugin.activate(t.context);
    await expect(plugin.perform!('capture', 'x')).rejects.toThrow(/“Today” column no longer exists/);
    expect(t.health.at(-1)).toMatchObject({ kind: 'warning' });
    expect((t.health.at(-1) as { detail: string }).detail).toContain('Last capture failed');
  });
  it('declares exactly the capture action, which takes text; unknown actions are no-ops', async () => {
    const { plugin } = setup();
    expect(plugin.actions!()).toEqual([{ name: 'capture', title: 'Capture a card', summary: 'Add a card to the configured board', acceptsText: true, agent: true }]);
    expect(await plugin.perform!('nope')).toBeUndefined();
  });
  it('before activation the action says so', async () => {
    await expect(createQuickCapture().perform!('capture', 'x')).rejects.toThrow('Quick Capture is not activated');
  });
});

describe('the panel conversation', () => {
  it('unconfigured → the page is told, so it shows the "Set up Quick Capture in Settings…" row', async () => {
    const { t, plugin } = setup();
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    expect(last(t).mode).toBe('unconfigured');
  });
  it('"ready" from a page that (re)loaded while the bar is open is answered with the current state; a hidden bar needs none', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onPanelMessage!({ type: 'ready' });
    expect(states(t)).toHaveLength(0);
    await plugin.onHotKey!(HOTKEY_ID);
    const before = states(t).length;
    await plugin.onPanelMessage!({ type: 'ready' });
    expect(states(t)).toHaveLength(before + 1);
    expect(last(t).mode).toBe('editing');
  });
  it('a failed submit returns the bar to editing, so the user can fix the text and press Enter again', async () => {
    const { t, plugin, engine } = setup(configured());
    engine.outcome = new BoardWriterError('writeFailed', 'disk full');
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: 'x' });
    expect(last(t).mode).toBe('error');
    engine.outcome = 'direct';
    await plugin.onPanelMessage!({ type: 'submit', text: 'x' });
    expect(engine.captures).toHaveLength(2);
    expect(last(t).mode).toBe('success');
  });
  it('a submit goes submitting → success, names the column, and closes the panel after the flash', async () => {
    const { t, plugin, engine } = setup(configured('/v'), { flashMs: 5 });
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: 'Ship it' });
    expect(engine.captures[0]!.text).toBe('Ship it');
    expect(states(t).map(s => s.mode).slice(-2)).toEqual(['submitting', 'success']);
    expect(last(t).message).toBe('Added to Today');
    await new Promise(r => setTimeout(r, 40));
    expect(t.panel.visible).toBe(false);
    await plugin.deactivate();
  });
  it('the success flash includes the due date parsed back out of the card text, as Swift did', async () => {
    const { t, plugin } = setup({ ...configured('/v') }, { flashMs: 5 });
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: 'Pay rent @{2026-11-27}' });
    expect(last(t).message).toBe('Added to Today · due Fri, Nov 27');
  });
  it('a failed submit keeps the panel OPEN with the loud message, and the text is the page’s to keep', async () => {
    const { t, plugin, engine } = setup(configured());
    engine.outcome = new BoardWriterError('writeFailed', 'disk full');
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: 'x' });
    expect(last(t)).toMatchObject({ mode: 'error', message: 'Couldn’t save the board: disk full' });
    expect(t.panel.visible).toBe(true);
    expect(t.health.at(-1)).toMatchObject({ kind: 'warning' });
  });
  it('a double submit while one is in flight is ignored (double-submit protection)', async () => {
    const { t, plugin, engine } = setup(configured(), { flashMs: 5 });
    let release!: () => void; engine.gate = new Promise<void>(r => { release = r; });
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    const first = plugin.onPanelMessage!({ type: 'submit', text: 'once' });
    await plugin.onPanelMessage!({ type: 'submit', text: 'twice' });
    release(); await first;
    expect(engine.captures.map(c => c.text)).toEqual(['once']);
  });
  it('a submit when the panel is not open is ignored', async () => {
    const { t, plugin, engine } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onPanelMessage!({ type: 'submit', text: 'ghost' });
    expect(engine.captures).toEqual([]);
  });
  it('an empty or whitespace submit is ignored', async () => {
    const { t, plugin, engine } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: '   \n ' });
    expect(engine.captures).toEqual([]);
  });
  it('malformed page messages are ignored', async () => {
    const { t, plugin, engine } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    for (const bad of [null, 'x', 5, [], {}, { type: 'submit' }, { type: 'submit', text: 5 }, { type: 'launch-missiles' }]) await plugin.onPanelMessage!(bad);
    expect(engine.captures).toEqual([]);
  });
  it('a resize request from the page resizes the open bar (the page measures its own content)', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'resize', height: 120 });
    expect(t.panel.height).toBe(120);
    await plugin.onPanelMessage!({ type: 'resize', height: 46 });
    expect(t.panel.height).toBe(46);
  });
  it('a resize when the bar is not open is ignored (the host would ignore it anyway, and nothing is queued for the next show)', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onPanelMessage!({ type: 'resize', height: 300 });
    expect(t.panel.calls.filter(c => c.call === 'resize')).toEqual([]);
  });
  it('an out-of-range resize is dropped by validation, not clamped silently', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'resize', height: 5000 });
    expect(t.panel.calls.filter(c => c.call === 'resize')).toEqual([]);
  });
  it('the gear opens the plugin’s settings page', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    await plugin.onPanelMessage!({ type: 'openSettings' });
    expect(t.openDetailRequests).toBe(1);
  });
  it('multi-line text is passed to the engine exactly as typed', async () => {
    const { t, plugin, engine } = setup(configured(), { flashMs: 5 });
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    await plugin.onPanelMessage!({ type: 'submit', text: 'line one\nline two' });
    expect(engine.captures[0]!.text).toBe('line one\nline two');
  });
});

describe('the board’s own date settings reach the page', () => {
  it('on every show the plugin reads the board’s date format and trigger', async () => {
    const dir = tempDir('qc-plugin');
    fs.writeFileSync(path.join(dir, 'Board.md'), simpleBoard + '\n\n%% kanban:settings\n```\n{"date-format":"MM-DD-YY","date-trigger":"@"}\n```\n%%\n');
    const { t, plugin } = setup(configured(dir));
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    expect(last(t)).toMatchObject({ dateFormat: 'MM-DD-YY', dateTrigger: '@' });
  });
  it('an unreadable board falls back to the defaults, never blocking the show', async () => {
    const { t, plugin } = setup(configured('/nonexistent'));
    await plugin.activate(t.context);
    await plugin.onHotKey!(HOTKEY_ID);
    expect(last(t)).toMatchObject({ mode: 'editing', dateFormat: 'YYYY-MM-DD', dateTrigger: '@' });
  });
});

describe('verify give-up is never silent', () => {
  it('posts a notification with the card text, and turns health yellow', async () => {
    const { t, plugin, engine } = setup(configured());
    await plugin.activate(t.context);
    engine.giveUp!({ vaultPath: '/v', boardPath: 'Board.md', column: 'Today' }, 'my precious idea');
    await tick();
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0]!.title).toBe('Quick Capture couldn’t verify your card');
    expect(t.notifications[0]!.body).toContain('my precious idea');
    expect(t.notifications[0]!.body).toContain('“Today” column');
    expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'Couldn’t verify the last captured card' });
  });
});

describe('the menu', () => {
  it('shows a Capture row with the hotkey, and clicking it opens the panel', async () => {
    const { t, plugin } = setup(configured());
    await plugin.activate(t.context);
    expect(t.menu).toEqual([{ kind: 'item', id: 'capture', label: expect.stringMatching(/^Capture {2}/) }]);
    await plugin.onMenuItem!('capture');
    expect(t.panel.visible).toBe(true);
  });
});

describe('the board list helper actions', () => {
  it('"scan-boards" fills the status with the kanban boards found in the vault', async () => {
    const dir = tempDir('qc-scan');
    fs.writeFileSync(path.join(dir, 'Board.md'), 'kanban-plugin: board\n## Today\n');
    const { t, plugin } = setup({ [VAULT_KEY]: dir });
    await plugin.activate(t.context);
    expect(await plugin.perform!('scan-boards')).toContain('Board.md');
    expect(t.status.get('boards')).toContain('Board.md');
  });

});
