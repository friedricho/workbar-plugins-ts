// Audio Fix: repairs a monitor's stuck DisplayPort audio stream by running the
// 16→24-bit format transition: automatically when the device list changes
// (dock, monitor connect, wake), every few minutes while the device is idle,
// when playback starts on the monitor, and on demand. Port of the Swift
// AudioFixPlugin plus the automatic triggers — a stream can go stuck with no
// observable CoreAudio event (verified 2026-11-24), so repairs must also run
// proactively; the stuck state is invisible to CoreAudio, there is nothing to
// detect.
//
// CoreAudio lives in a small Swift helper (bin/audiofix-helper, JSON lines on
// stdio): the listeners and the format toggle, nothing else. The decisions
// (settle delay, recency guard, retry schedule) live here, where they are
// testable without hardware.
import {
  definePlugin,
  health,
  type CapabilityPlugin,
  type PluginContext,
  type SettingsSchema,
} from '@workbar/sdk';
import { parseHelperMessage, type HelperReply, type ListedDevice, type RepairResult } from './protocol.js';
import { RepairGate } from './repair-gate.js';

export const PLUGIN_ID = 'audiofix';
export const HELPER = 'audiofix';
export const DEVICE_NAME_KEY = 'deviceName';
export const DEVICE_UID_KEY = 'deviceUID';
export const AUTO_REPAIR_KEY = 'autoRepair';
export const REPAIR_WHILE_IDLE_KEY = 'repairWhileIdle';
export const REPAIR_ON_PLAYBACK_KEY = 'repairOnPlayback';
export const DEFAULT_DEVICE = 'S2725QC';
/** Waiting after the last device-list change lets a docking burst settle into one repair. */
export const SETTLE_MS = 2000;
/** A helper that never answers must not hang a repair forever. */
export const REPLY_TIMEOUT_MS = 30_000;
/** How often to repair while the target is idle: the stuck state can arise
 *  with no event at all, and the idle repair heals it before it is heard. */
export const IDLE_INTERVAL_MS = 5 * 60_000;
/** A play-start repair also fires when nothing was wrong (the blip the user
 *  accepted), so it is bounded: at most once per this window. */
export const PLAY_GUARD_MS = 10 * 60_000;

export const settingsSchema: SettingsSchema = {
  sections: [
    {
      title: 'Monitor',
      fields: [
        { type: 'text', key: DEVICE_NAME_KEY, label: 'Device name', placeholder: DEFAULT_DEVICE, default: DEFAULT_DEVICE, help: 'Matched case-insensitively (substring). If several devices match, set the UID: “List devices” shows both.' },
        { type: 'text', key: DEVICE_UID_KEY, label: 'Device UID', placeholder: 'optional — picks one of several matches' },
      ],
    },
    {
      title: 'Repair',
      fields: [
        { type: 'status', key: 'state', label: 'Status' },
        { type: 'toggle', key: AUTO_REPAIR_KEY, label: 'Repair automatically on connect / wake', default: true },
        { type: 'toggle', key: REPAIR_WHILE_IDLE_KEY, label: 'Keep the stream repaired while idle', default: true, help: `Runs the fix every ${IDLE_INTERVAL_MS / 60_000} minutes when nothing is playing — heals a stuck stream before you notice.` },
        { type: 'toggle', key: REPAIR_ON_PLAYBACK_KEY, label: 'Repair when playback starts', default: true, help: 'Guarantees audio when you press play. May briefly interrupt the first second of sound even when nothing was wrong (at most once per 10 minutes).' },
        { type: 'action', key: 'repair-now', label: 'Repair now', help: 'Runs the 16→24-bit format transition. Safe to run anytime: it is the fix itself.' },
        { type: 'action', key: 'list-devices', label: 'List devices', help: 'Shows each output device’s name, UID and format.' },
        { type: 'status', key: 'devices', label: 'Devices' },
      ],
    },
  ],
};

interface Helper { send(message: unknown): Promise<void>; stop(): Promise<void> }
type Reason = 'startup' | 'manual' | 'device list changed' | 'idle' | 'playback started';

export interface AudioFixOptions {
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly settleMs?: number;
  readonly replyTimeoutMs?: number;
  readonly idleIntervalMs?: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAudioFix(options: AudioFixOptions = {}): CapabilityPlugin {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const settleMs = options.settleMs ?? SETTLE_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
  const idleIntervalMs = options.idleIntervalMs ?? IDLE_INTERVAL_MS;

  let ctx: PluginContext | null = null;
  let helper: Helper | null = null;
  let starting: Promise<Helper> | null = null;
  let watching = false;
  let gate = new RepairGate();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let unwatch: (() => void) | null = null;
  let nextId = 1;
  /** The last successful repair of ANY kind (event, manual, idle). The
   *  play-start backstop waits out its window since this; the gate tracks only
   *  event-class repairs so a recent idle repair never suppresses one. */
  let lastAnyRepairAt: number | null = null;
  const pending = new Map<number, { resolve(r: HelperReply): void; timer: ReturnType<typeof setTimeout> }>();
  // Repairs never overlap: a manual one waits for an automatic one in flight.
  let queue: Promise<unknown> = Promise.resolve();

  const targetOf = async (c: PluginContext) => {
    const name = ((await c.settings.get<string>(DEVICE_NAME_KEY)) ?? '').trim() || DEFAULT_DEVICE;
    const uid = ((await c.settings.get<string>(DEVICE_UID_KEY)) ?? '').trim();
    return { name, uid: uid || undefined, text: uid ? `${name} [${uid}]` : name };
  };

  const setState = (c: PluginContext, text: string) => c.reportStatus({ state: text });

  const ensureHelper = async (c: PluginContext): Promise<Helper> => {
    if (helper) return helper;
    starting ??= c.helpers.start(HELPER).then(h => { helper = h; return h; }).finally(() => { starting = null; });
    return starting;
  };

  /** Sends one command and waits for the reply with its id. A dead helper is
   *  restarted once; the host reports no exit event, so a failed send is the signal. */
  const request = async (c: PluginContext, body: Record<string, unknown>): Promise<HelperReply> => {
    const id = nextId++;
    const reply = new Promise<HelperReply>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('the audio helper did not answer')); }, replyTimeoutMs);
      pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, timer });
    });
    reply.catch(() => {}); // a late rejection must never be unhandled
    const line = { ...body, id };
    try {
      await (await ensureHelper(c)).send(line);
    } catch {
      const wasWatching = watching;
      helper = null;
      if (watching) watching = false; // a fresh helper has no listener yet
      try {
        const h = await ensureHelper(c);
        if (wasWatching) {
          // Without the listeners on the fresh helper, auto-repair would be
          // silently dead from here on. A failed re-arm still lets the repair
          // below run (and report its own failure).
          try { const t = await targetOf(c); await h.send({ cmd: 'watch', nameQuery: t.name, uid: t.uid }); watching = true; }
          catch { c.logger.warn('couldn’t re-arm the device listeners after restarting the helper'); }
        }
        await h.send(line);
      }
      catch (e) { const p = pending.get(id); if (p) { clearTimeout(p.timer); pending.delete(id); } throw new Error(`couldn’t start the audio helper: ${msg(e)}`); }
    }
    return reply;
  };

  const startWatching = async (c: PluginContext) => {
    const t = await targetOf(c);
    await (await ensureHelper(c)).send({ cmd: 'watch', nameQuery: t.name, uid: t.uid });
    watching = true;
  };

  // ------------------------------------------------------------ repairs

  const onResult = async (c: PluginContext, reason: Reason, r: RepairResult, target: string) => {
    if (r.status === 'busy') return; // only the idle pass replies busy, and it reports itself
    if (r.status === 'repaired') {
      c.logger.info(`${reason}: repaired ${r.device} -> ${r.format}`);
      setState(c, `${r.device} → ${r.format}`);
      c.reportHealth(health.ok(`${r.device} → ${r.format}`));
    } else if (r.status === 'absent') {
      c.logger.info(`${reason}: target device absent; nothing to do`);
      const text = `${target} not connected — watching for it to appear`;
      setState(c, text);
      c.reportHealth(health.ok(text));
    } else {
      // Never silent: a notification AND a yellow health dot.
      c.logger.error(r.message);
      setState(c, `Last repair failed — ${r.message}`);
      c.reportHealth(health.warning(`Last repair failed — ${r.message}`));
      await c.notifications.post({ title: 'Audio Fix couldn’t repair your monitor', subtitle: 'Falling back to a manual repair', body: r.message });
    }
  };

  const attemptRepair = async (c: PluginContext, reason: Reason, bypassGuard = false, minMsSinceAnyRepair?: number): Promise<RepairResult | 'skipped'> => {
    if (!bypassGuard && minMsSinceAnyRepair !== undefined && lastAnyRepairAt !== null && now() - lastAnyRepairAt < minMsSinceAnyRepair) {
      const ago = Math.round((now() - lastAnyRepairAt) / 60_000);
      c.logger.info(`${reason}: repaired ${ago} min ago; skipping`);
      return 'skipped';
    }
    if (!bypassGuard && !gate.canRepair(now())) {
      const ago = Math.round((now() - (gate.lastRepairAt ?? now())) / 1000);
      c.logger.info(`${reason}: repaired ${ago}s ago; skipping`);
      return 'skipped';
    }
    const target = await targetOf(c);
    let last: RepairResult = { status: 'failed', message: 'no attempt ran' };
    for (let attempt = 1; attempt <= gate.maxAttempts; attempt++) {
      if (ctx !== c) return last; // deactivated meanwhile
      let r: RepairResult;
      try {
        const reply = await request(c, { cmd: 'repair', nameQuery: target.name, uid: target.uid });
        if (reply.status === 'listed') throw new Error('unexpected reply from the audio helper');
        r = reply;
      } catch (e) { r = { status: 'failed', message: msg(e) }; }

      if (r.status === 'repaired') { gate.recordRepair(now()); lastAnyRepairAt = now(); await onResult(c, reason, r, target.text); return r; }
      if (r.status === 'absent') { await onResult(c, reason, r, target.text); return r; }
      if (r.status === 'busy') { c.logger.info(`${reason}: target is in use; skipping`); return 'skipped'; }
      last = r;
      if (attempt < gate.maxAttempts) {
        c.logger.error(`attempt ${attempt}/${gate.maxAttempts} failed: ${r.message}`);
        await sleep(gate.backoffSeconds(attempt) * 1000);
      }
    }
    last = { status: 'failed', message: `giving up after ${gate.maxAttempts} attempts: ${(last as { message: string }).message}` };
    if (ctx === c) await onResult(c, reason, last, target.text);
    return last;
  };

  const enqueue = (c: PluginContext, reason: Reason, bypassGuard = false, minMsSinceAnyRepair?: number) => {
    const run = queue.then(() => (ctx === c ? attemptRepair(c, reason, bypassGuard, minMsSinceAnyRepair) : 'skipped' as const));
    queue = run.catch(() => {});
    return run;
  };

  const scheduleRepair = (c: PluginContext, reason: Reason = 'device list changed', minMsSinceAnyRepair?: number) => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; void enqueue(c, reason, false, minMsSinceAnyRepair); }, settleMs);
  };

  // ------------------------------------------------------------ idle repair

  /** One quiet pass, at the heart of "automatic": a stream can go stuck with
   *  no CoreAudio event at all (2026-11-24), so the fix runs periodically while
   *  the device is idle — inaudible, because nothing is playing. It bypasses
   *  and never records into the gate: a device-list change right after must
   *  still repair (docking re-sticks the stream). */
  const runIdleRepair = async (c: PluginContext): Promise<void> => {
    if (settleTimer) return; // an event repair is already settling; it covers this
    const target = await targetOf(c);
    let r: RepairResult;
    try {
      const reply = await request(c, { cmd: 'repairIfIdle', nameQuery: target.name, uid: target.uid });
      if (reply.status === 'listed') return;
      r = reply;
    } catch (e) { r = { status: 'failed', message: msg(e) }; }
    if (r.status === 'busy') { c.logger.debug('idle repair: the target is in use; skipping'); return; }
    if (r.status === 'absent') { c.logger.debug('idle repair: target device absent'); return; }
    if (r.status === 'repaired') {
      lastAnyRepairAt = now();
      c.logger.info(`idle: repaired ${r.device} -> ${r.format}`);
      setState(c, `${r.device} → ${r.format}`);
      c.reportHealth(health.ok(`${r.device} → ${r.format}`));
      return;
    }
    // One attempt, no retries and no notification: the next tick retries, and
    // a real connect event still runs the never-silent path.
    c.logger.error(`idle repair failed: ${r.message}`);
    setState(c, `Last repair failed — ${r.message}`);
    c.reportHealth(health.warning(`Last repair failed — ${r.message}`));
  };

  const enqueueIdle = (c: PluginContext) => {
    const run = queue.then(() => (ctx === c ? runIdleRepair(c) : undefined));
    queue = run.catch(() => {});
    return run;
  };

  const stopIdleTimer = () => { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } };

  // ------------------------------------------------------------ auto-repair on/off

  const applyAutoRepair = async (c: PluginContext) => {
    const auto = (await c.settings.get<boolean>(AUTO_REPAIR_KEY)) ?? true;
    const repairWhileIdle = (await c.settings.get<boolean>(REPAIR_WHILE_IDLE_KEY)) ?? true;
    const target = await targetOf(c);
    if (auto) {
      try {
        // Always (re)sent: idempotent in the helper, and it moves the target's
        // activity listener when the device name or UID setting changed.
        await startWatching(c);
        if (repairWhileIdle) {
          if (idleTimer) clearInterval(idleTimer);
          idleTimer = setInterval(() => { void enqueueIdle(c); }, idleIntervalMs);
        } else stopIdleTimer();
        c.reportHealth(health.ok(`Watching for ${target.text}`));
        setState(c, `Watching for ${target.text}`);
        c.logger.info(`watching for "${target.text}"; repairs run automatically when it appears`);
        // Covers login-while-docked; if the monitor isn't there yet the listener catches it.
        void enqueue(c, 'startup');
      } catch (e) {
        // The listener is off, but a manual repair still works: a warning, not an error.
        c.reportHealth(health.warning(`Couldn’t watch for devices: ${msg(e)}`));
        setState(c, `Couldn’t watch for devices: ${msg(e)}`);
        c.logger.error(`watcher start failed: ${msg(e)}`);
      }
    } else {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      stopIdleTimer();
      if (watching) { watching = false; await helper?.send({ cmd: 'unwatch' }).catch(() => {}); c.logger.info('stopped watching'); }
      c.reportHealth(health.ok('Auto-repair off — use Repair Now'));
      setState(c, 'Auto-repair off — use Repair Now');
    }
  };

  const describeDevices = (devices: readonly ListedDevice[]) =>
    devices.length === 0 ? 'No output devices' : devices.map(d => `${d.name} [${d.uid}] ${d.format}${d.writable ? '' : ' (read-only)'}`).join('\n');

  const listDevices = async (c: PluginContext): Promise<string> => {
    try {
      const reply = await request(c, { cmd: 'list' });
      if (reply.status !== 'listed') throw new Error(reply.status === 'repaired' || reply.status === 'busy' ? 'unexpected reply' : reply.message);
      const text = describeDevices(reply.devices);
      c.reportStatus({ devices: text });
      return text;
    } catch (e) {
      const text = `Couldn’t list devices: ${msg(e)}`;
      c.reportStatus({ devices: text });
      return text;
    }
  };

  const repairNow = async (c: PluginContext) => { await enqueue(c, 'manual', true); };

  return {
    metadata: { id: PLUGIN_ID, name: 'Audio Fix', icon: 'speaker', summary: 'Repairs the monitor’s stuck DisplayPort audio stream', version: '2.1.0' },
    settings: settingsSchema,

    async activate(context) {
      ctx = context;
      gate = new RepairGate();
      lastAnyRepairAt = null;
      await context.settings.registerDefaults({ [DEVICE_NAME_KEY]: DEFAULT_DEVICE, [AUTO_REPAIR_KEY]: true, [REPAIR_WHILE_IDLE_KEY]: true, [REPAIR_ON_PLAYBACK_KEY]: true });
      unwatch = context.settings.onChange(key => {
        if (key === AUTO_REPAIR_KEY || key === REPAIR_WHILE_IDLE_KEY || key === DEVICE_NAME_KEY || key === DEVICE_UID_KEY) void applyAutoRepair(context);
      });
      context.menu.set([{ kind: 'item', id: 'repair', label: 'Repair Now' }]);
      await applyAutoRepair(context);
      context.logger.info(`activated — target ${(await targetOf(context)).text}, autoRepair=${(await context.settings.get(AUTO_REPAIR_KEY)) ?? true}`);
    },

    async deactivate() {
      const c = ctx;
      ctx = null;
      unwatch?.(); unwatch = null;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      stopIdleTimer();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      const h = helper;
      helper = null; starting = null; watching = false;
      await h?.stop().catch(() => {});
      void c;
    },

    onHelperMessage(name, raw) {
      if (name !== HELPER || !ctx) return;
      const m = parseHelperMessage(raw);
      if (!m) { ctx.logger.warn('the audio helper sent an unrecognized line'); return; }
      if ('event' in m) {
        if (m.event === 'devicesChanged') scheduleRepair(ctx);
        else if (m.event === 'targetActive') {
          // The helper reports every activity transition; the setting decides.
          void ctx.settings.get<boolean>(REPAIR_ON_PLAYBACK_KEY).then(on => {
            if (on && ctx) scheduleRepair(ctx, 'playback started', PLAY_GUARD_MS);
          });
        }
        return;
      }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m); }
    },

    async onMenuItem(id) { if (id === 'repair' && ctx) void repairNow(ctx); },

    actions: () => [{ name: 'repair-now', title: 'Repair now', summary: 'Repair the monitor’s DisplayPort audio stream', acceptsText: false }],

    async perform(action) {
      const c = ctx;
      if (action === 'repair-now') {
        if (!c) throw new Error('Audio Fix is not activated — enable the plugin before running a repair');
        void repairNow(c); // the outcome lands in health and notifications
        return `Repair started for ${(await targetOf(c)).text}`;
      }
      if (action === 'list-devices' && c) return listDevices(c);
      return undefined;
    },
  };
}

export default definePlugin(() => createAudioFix());
