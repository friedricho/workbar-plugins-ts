// Obsidian Quick Capture: a global hotkey opens a small capture bar; Enter adds the text as a card under a column
// of an Obsidian kanban board. Port of the Swift QuickCapturePlugin. The engine (src/engine.ts) writes the card
// (the Obsidian CLI when Obsidian is running, else an atomic file write with a clobber verifier); the bar itself is
// the page in views/ (the SDK's ctx.panel); this file is the glue between the hotkey, the settings, the engine and
// the page. Nothing is ever silent: a failed capture keeps the bar open with the reason, and a card the verifier
// cannot confirm posts a notification carrying the card text.
import {
  carbonToAccelerator,
  definePlugin,
  health,
  type CapabilityPlugin,
  type PluginContext,
  type PluginHealth,
  type SettingsSchema,
} from '@workbar/sdk';
import { dateFromTokenIn, friendlyText, parseBoardSettings } from './due-date.js';
import { parsePageMessage, type Mode, type StateMessage } from './protocol.js';
import { createRealEngine, type EngineContext } from './real-engine.js';
import { BoardWriterError, boardFile, type CaptureTarget, type WriterTier } from './writers.js';
import { boardColumns, scanBoards } from './vault.js';
import fs from 'node:fs/promises';

export const PLUGIN_ID = 'quickcapture';
export const HOTKEY_ID = `${PLUGIN_ID}.capture`;
// Settings keys: the Swift contract, kept so an imported setup lines up.
export const VAULT_KEY = 'vaultPath';
export const BOARD_KEY = 'boardPath';
export const COLUMN_KEY = 'column';
export const ACTIVATE_KEY = 'activateOnOpen';
export const HOTKEY_KEY_CODE = 'hotkeyKeyCode';
export const HOTKEY_MODIFIERS = 'hotkeyModifiers';
// New in this port.
export const HOTKEY_KEY = 'hotkey';
export const CLI_PATH_KEY = 'obsidianCliPath';
/** How long the "Added to Today" flash shows before the bar closes (the Swift ~400 ms). */
export const FLASH_MS = 400;

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Capture',
      fields: [
        { type: 'status', key: 'state', label: 'Status' },
        { type: 'hotkey', key: HOTKEY_KEY, label: 'Capture shortcut', help: 'Opens the capture bar from anywhere. ⌥Space on macOS, Ctrl+Alt+Space on Windows (Alt+Space is the system menu there).' },
        { type: 'status', key: 'hotkey', label: 'Shortcut' },
        { type: 'toggle', key: ACTIVATE_KEY, label: 'Activate app when opened', default: true, help: 'Brings WorkBar to the front while the bar is open, so dictation tools that type into the focused app can fill it. The app you came from is restored when it closes.' },
      ],
    },
    {
      title: 'Board',
      fields: [
        { type: 'path', key: VAULT_KEY, label: 'Vault folder', pick: 'folder', help: 'Your Obsidian vault.' },
        { type: 'text', key: BOARD_KEY, label: 'Board', placeholder: 'Kanban.md', help: 'The board file, relative to the vault. “Find boards” lists the kanban boards in the vault.' },
        { type: 'text', key: COLUMN_KEY, label: 'Column', default: 'Today', help: 'The column cards are added to (a “## Heading” on the board). Case-sensitive.' },
        { type: 'action', key: 'scan-boards', label: 'Find boards', help: 'Lists the kanban boards found in the vault.' },
        { type: 'status', key: 'boards', label: 'Boards found' },
        { type: 'action', key: 'list-columns', label: 'Show columns', help: 'Lists the columns of the chosen board.' },
        { type: 'status', key: 'columns', label: 'Columns' },
      ],
    },
    {
      title: 'Advanced',
      fields: [
        { type: 'path', key: CLI_PATH_KEY, label: 'Obsidian CLI', pick: 'file', help: 'Normally found automatically. Set it only if Obsidian’s command-line tool is somewhere unusual. Used when Obsidian is running; otherwise the board file is written directly.' },
      ],
    },
  ],
};

export interface EngineLike {
  capture(text: string, target: CaptureTarget): Promise<WriterTier>;
  dispose(): void;
}

export interface QuickCaptureOptions {
  /** Injectable for tests: the engine is the part that touches the real Obsidian CLI and vault. */
  readonly createEngine?: (o: EngineContext) => EngineLike;
  readonly timeZone?: () => string;
  readonly now?: () => Date;
  readonly flashMs?: number;
}

const msg = (e: unknown) => (e instanceof BoardWriterError || e instanceof Error ? e.message : String(e));

export function createQuickCapture(options: QuickCaptureOptions = {}): CapabilityPlugin {
  const timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const now = options.now ?? (() => new Date());
  const flashMs = options.flashMs ?? FLASH_MS;
  const makeEngine = options.createEngine ?? createRealEngine;

  let ctx: PluginContext | null = null;
  let engine: EngineLike | null = null;
  let unwatch: (() => void) | null = null;
  let mode: Mode = 'editing';
  let open = false;
  let opening: Promise<void> | null = null;
  let hotkeyOk = true;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let current: StateMessage | null = null;
  /** The Obsidian CLI path from settings, if the user set one. Per instance: two plugin instances must never share it. */
  let cliOverride: string | undefined;

  // ------------------------------------------------------------ settings

  const targetOf = async (c: PluginContext): Promise<CaptureTarget | null> => {
    const vaultPath = ((await c.settings.get<string>(VAULT_KEY)) ?? '').trim();
    const boardPath = ((await c.settings.get<string>(BOARD_KEY)) ?? '').trim();
    const column = ((await c.settings.get<string>(COLUMN_KEY)) ?? 'Today').trim();
    return vaultPath && boardPath && column ? { vaultPath, boardPath, column } : null;
  };

  const defaultAccelerator = (c: PluginContext) => (c.platform === 'win32' ? 'Control+Alt+Space' : 'Alt+Space');

  const steadyHealth = async (c: PluginContext): Promise<PluginHealth> => {
    if (!hotkeyOk) return health.warning('Hotkey may be taken by another app — change it in settings');
    if (!(await targetOf(c))) return health.warning('Not configured — choose a vault and board');
    return health.ok();
  };

  /** The Swift app stored its hotkey as a Carbon key code plus modifier mask. Convert it ONCE into an Electron
   *  accelerator and store that; never overwrite one the user already chose, and leave the Carbon keys alone. */
  const importSwiftHotkey = async (c: PluginContext): Promise<void> => {
    if (typeof (await c.settings.get(HOTKEY_KEY)) === 'string') return;
    const code = await c.settings.get<number>(HOTKEY_KEY_CODE);
    const mods = await c.settings.get<number>(HOTKEY_MODIFIERS);
    if (typeof code !== 'number' || typeof mods !== 'number') return;
    const accel = carbonToAccelerator(code, mods);
    if (accel) await c.settings.set(HOTKEY_KEY, accel);
    else c.reportStatus({ hotkey: 'Your previous shortcut has no equivalent here — pick a new one above.' });
  };

  const registerHotkey = async (c: PluginContext): Promise<string> => {
    const accelerator = ((await c.settings.get<string>(HOTKEY_KEY)) ?? '').trim() || defaultAccelerator(c);
    hotkeyOk = await c.hotKeys.register(HOTKEY_ID, accelerator).catch(() => false);
    c.reportHealth(await steadyHealth(c));
    publishMenu(c, accelerator);
    return accelerator;
  };

  const publishMenu = (c: PluginContext, accelerator: string): void => {
    c.menu.set([{ kind: 'item', id: 'capture', label: `Capture  ${accelerator.replace('Control', 'Ctrl')}` }]);
    c.reportStatus({ state: hotkeyOk ? `Shortcut ${accelerator}` : `Shortcut ${accelerator} is taken by another app` });
  };

  // ------------------------------------------------------------ the panel

  const stateFor = async (c: PluginContext, m: Mode, message?: string): Promise<StateMessage> => {
    const target = await targetOf(c);
    let board = '';
    if (target) { try { board = await fs.readFile(boardFile(target), 'utf8'); } catch { board = ''; } } // an unreadable board never blocks the bar
    const dates = parseBoardSettings(board);
    return {
      type: 'state', mode: target ? m : 'unconfigured', column: target?.column ?? ((await c.settings.get<string>(COLUMN_KEY)) ?? 'Today'),
      dateFormat: dates.dateFormat, dateTrigger: dates.dateTrigger, tz: timeZone(), nowIso: now().toISOString(), ...(message !== undefined ? { message } : {}),
    };
  };

  const push = async (c: PluginContext, m: Mode, message?: string): Promise<void> => {
    mode = m;
    current = await stateFor(c, m, message);
    if (ctx === c) await c.panel.post(current);
  };

  const showPanel = async (c: PluginContext): Promise<void> => {
    if (opening) return opening;
    opening = (async () => {
      const already = open;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      if (!already) await push(c, 'editing'); // a fresh bar: reset state. An open one is only refocused (typed text survives).
      open = true;
      await c.panel.show({ activate: (await c.settings.get<boolean>(ACTIVATE_KEY)) !== false });
    })().finally(() => { opening = null; });
    return opening;
  };

  /** "Added to Today", plus " · due Fri, Nov 14" when the card carries a due-date token (parsed back out of the text). */
  const successMessage = (column: string, text: string, s: StateMessage): string => {
    const due = dateFromTokenIn(text, { dateFormat: s.dateFormat, dateTrigger: s.dateTrigger }, now());
    return `Added to ${column}${due ? ` · due ${friendlyText(due)}` : ''}`;
  };

  const submit = async (c: PluginContext, raw: string): Promise<void> => {
    // Claimed SYNCHRONOUSLY, before any await: a second Enter in the gap would otherwise pass this guard and start a second capture.
    // Only an idle bar submits: editing, or showing the last failure (the user fixes the text and presses Enter again).
    if (!open || (mode !== 'editing' && mode !== 'error') || !engine || raw.trim() === '') return;
    mode = 'submitting';
    const text = raw;
    const target = await targetOf(c);
    if (!target) { await push(c, 'unconfigured'); return; }
    const dates = current ?? (await stateFor(c, 'editing'));
    await push(c, 'submitting');
    try {
      const tier = await engine.capture(text, target);
      c.logger.info(`submit: captured via tier=${tier}`);
      await push(c, 'success', successMessage(target.column, text, dates));
      c.reportHealth(await steadyHealth(c));
      closeTimer = setTimeout(() => { closeTimer = null; if (ctx === c && mode === 'success') void c.panel.hide().catch(() => {}); }, flashMs);
    } catch (e) {
      const message = msg(e);
      c.logger.error(`submit: capture failed: ${message}`);
      await push(c, 'error', message); // keep editing: the bar stays open and the page keeps the typed text
      c.reportHealth(health.warning(`Last capture failed: ${message}`));
    }
  };

  const notifyGiveUp = (target: CaptureTarget, cardText: string): void => {
    const c = ctx;
    if (!c) return;
    void c.notifications.post({
      title: 'Quick Capture couldn’t verify your card',
      body: `“${cardText}” may not have made it to the “${target.column}” column. Check the board or re-add it.`,
    }).catch(() => {});
    c.logger.error(`verify give-up — column ${target.column}, text: ${cardText}`);
    c.reportHealth(health.warning('Couldn’t verify the last captured card'));
  };

  // ------------------------------------------------------------ the plugin

  return {
    metadata: { id: PLUGIN_ID, name: 'Obsidian Quick Capture', icon: 'sparkles', summary: 'Global capture bar → Obsidian kanban card', version: '2.0.0' },
    settings: settingsSchema,

    async activate(context) {
      ctx = context;
      mode = 'editing'; open = false; opening = null;
      await context.settings.registerDefaults({ [COLUMN_KEY]: 'Today', [ACTIVATE_KEY]: true });
      engine = makeEngine({
        platform: context.platform,
        cliOverride: () => cliOverride,
        onGiveUp: notifyGiveUp,
      });
      cliOverride = ((await context.settings.get<string>(CLI_PATH_KEY)) ?? '').trim() || undefined;
      await importSwiftHotkey(context);
      unwatch = context.settings.onChange(key => {
        if (key === HOTKEY_KEY) void registerHotkey(context);
        if (key === CLI_PATH_KEY) void context.settings.get<string>(CLI_PATH_KEY).then(v => { cliOverride = (v ?? '').trim() || undefined; });
        if (key === VAULT_KEY || key === BOARD_KEY || key === COLUMN_KEY) void steadyHealth(context).then(h => { if (ctx === context) context.reportHealth(h); });
      });
      const accelerator = await registerHotkey(context);
      context.logger.info(`activated — hotkey ${accelerator} ${hotkeyOk ? 'registered' : 'NOT registered (taken)'}`);
    },

    async deactivate() {
      unwatch?.(); unwatch = null;
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
      engine?.dispose(); engine = null;
      const c = ctx;
      ctx = null; open = false; opening = null; current = null;
      await c?.panel.hide().catch(() => {});
    },

    onHotKey: async id => { if (id === HOTKEY_ID && ctx) await showPanel(ctx); },

    async onMenuItem(id) { if (id === 'capture' && ctx) await showPanel(ctx); },

    onPanelHidden: () => { open = false; if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } },

    async onPanelMessage(raw) {
      const c = ctx;
      const m = parsePageMessage(raw);
      if (!c || !m) return;
      if (m.type === 'ready') { if (open) await push(c, mode === 'submitting' ? 'submitting' : mode, current?.message); return; }
      if (m.type === 'openSettings') { c.requestOpenDetail(); return; }
      await submit(c, m.text);
    },

    actions: () => [{ name: 'capture', title: 'Capture a card', summary: 'Add a card to the configured board', acceptsText: true }],

    async perform(action, text) {
      const c = ctx;
      if (action === 'scan-boards') {
        if (!c) return undefined;
        const found = await scanBoards(((await c.settings.get<string>(VAULT_KEY)) ?? '').trim());
        const line = found.length ? found.join('\n') : 'No kanban boards found in that folder';
        c.reportStatus({ boards: line });
        return line;
      }
      if (action === 'list-columns') {
        if (!c) return undefined;
        const t = { vaultPath: ((await c.settings.get<string>(VAULT_KEY)) ?? '').trim(), boardPath: ((await c.settings.get<string>(BOARD_KEY)) ?? '').trim() };
        const cols = await boardColumns(t);
        const line = cols.length ? cols.join(' · ') : 'No columns found: check the vault folder and board';
        c.reportStatus({ columns: line });
        return line;
      }
      if (action !== 'capture') return undefined;
      if (!c || !engine) throw new Error('Quick Capture is not activated');
      const cardText = (text ?? '').trim();
      if (!cardText) throw new Error('capture requires non-empty text');
      const target = await targetOf(c);
      if (!target) throw new Error('not configured — choose a vault and board');
      try {
        const tier = await engine.capture(cardText, target);
        c.logger.info(`capture action: captured via tier=${tier}`);
        c.reportHealth(await steadyHealth(c));
        return `Added to ${target.column}`;
      } catch (e) {
        c.logger.error(`capture action failed: ${msg(e)}`);
        c.reportHealth(health.warning(`Last capture failed: ${msg(e)}`));
        throw e;
      }
    },
  };
}

export default definePlugin(() => createQuickCapture());
