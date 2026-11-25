// The Swift AudioFixPluginTests wiring cases, plus the behavior that moved
// from the Swift watcher into TypeScript (settle, guard, retries), the new
// helper boundary, and the proactive triggers (idle repair, play-start
// backstop). A scripted fake helper stands in for CoreAudio.
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { validateSettingsSchema } from '@workbar/sdk';
import { AUTO_REPAIR_KEY, createAudioFix, DEVICE_NAME_KEY, DEVICE_UID_KEY, PLAY_GUARD_MS, REPAIR_ON_PLAYBACK_KEY, REPAIR_WHILE_IDLE_KEY, settingsSchema } from '../src/index.js';

type Sent = { cmd: string; id?: number; nameQuery?: string; uid?: string };
type Plugin = ReturnType<typeof createAudioFix>;

/** A fake helper: records commands; `script` decides the reply to each repair
 *  (both `repair` and `repairIfIdle`). */
function fakeHelper(plugin: Plugin, script: (n: number) => Record<string, unknown> | 'silent') {
  const sent: Sent[] = [];
  let repairs = 0; let starts = 0; let stops = 0; let broken = false;
  const helpers = {
    start: async () => {
      starts++;
      broken = false;
      return {
        send: async (m: unknown) => {
          if (broken) throw new Error('helper is not running');
          const c = m as Sent; sent.push(c);
          if (c.cmd === 'repair' || c.cmd === 'repairIfIdle') {
            const r = script(++repairs);
            if (r !== 'silent') queueMicrotask(() => void plugin.onHelperMessage!('audiofix', { id: c.id, ...r }));
          } else if (c.cmd === 'list') {
            queueMicrotask(() => void plugin.onHelperMessage!('audiofix', { id: c.id, status: 'listed', devices: [{ name: 'S2725QC', uid: 'AB:1', format: '2ch 24-bit 48000 Hz (lpcm)', writable: true }] }));
          }
        },
        stop: async () => { stops++; },
      };
    },
  };
  return { sent, helpers, crash: () => { broken = true; }, get starts() { return starts; }, get stops() { return stops; } };
}

const OK = { status: 'repaired', device: 'S2725QC [AB:1]', format: '2ch 24-bit 48000 Hz (lpcm)' };
const FAIL = { status: 'failed', message: 'CoreAudio failed while setting the requested format (OSStatus 1)' };
const ABSENT = { status: 'absent', message: 'No output device matched "S2725QC".' };
const BUSY = { status: 'busy' };

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = () => new Promise<void>(r => setTimeout(r, 0));

async function setup(
  script: (n: number) => Record<string, unknown> | 'silent' = () => OK,
  settings: Record<string, unknown> = {},
  clock = { t: 1_000_000 },
  settleMs = 5,
  idleMs = 5 * 60_000,
  backoff?: readonly number[],
) {
  const t: TestContext = createTestContext('audiofix');
  const sleeps: number[] = [];
  const plugin = createAudioFix({ now: () => clock.t, sleep: async ms => { sleeps.push(ms); }, settleMs, replyTimeoutMs: 200, idleIntervalMs: idleMs, ...(backoff ? { restartBackoffMs: backoff } : {}) });
  const h = fakeHelper(plugin, script);
  (t.context as { helpers: unknown }).helpers = h.helpers;
  for (const [k, v] of Object.entries(settings)) t.settings.set(k, v);
  return { t, plugin, h, sleeps, clock };
}
const repairs = (h: { sent: Sent[] }) => h.sent.filter(s => s.cmd === 'repair');
const idleRepairs = (h: { sent: Sent[] }) => h.sent.filter(s => s.cmd === 'repairIfIdle');
const healthKinds = (t: TestContext) => t.health.map(x => x.kind);

describe('Audio Fix plugin', () => {
  it('declares a valid settings page', () => {
    expect(validateSettingsSchema(settingsSchema)).toEqual([]);
  });

  it('activation with auto-repair off reports off-state health, starts no helper', async () => {
    const { t, plugin, h } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'Auto-repair off — use Repair Now' });
    expect(t.menu).toEqual([{ kind: 'item', id: 'repair', label: 'Repair Now' }]);
    expect(h.starts).toBe(0);
    await plugin.deactivate();
  });

  it('activation registers the default device name without clobbering one that is set', async () => {
    const a = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await a.plugin.activate(a.t.context);
    expect(a.t.settings.get(DEVICE_NAME_KEY)).toBe('S2725QC');
    const b = await setup(() => OK, { [AUTO_REPAIR_KEY]: false, [DEVICE_NAME_KEY]: 'LG Ultra' });
    await b.plugin.activate(b.t.context);
    expect(b.t.settings.get(DEVICE_NAME_KEY)).toBe('LG Ultra');
  });

  it('declares exactly the repair-now action', () => {
    const actions = createAudioFix().actions!();
    expect(actions).toEqual([{ name: 'repair-now', title: 'Repair now', summary: 'Repair the monitor’s DisplayPort audio stream', acceptsText: false, agent: true }]);
  });

  it('perform without activation throws', async () => {
    await expect(createAudioFix().perform!('repair-now')).rejects.toThrow('Audio Fix is not activated — enable the plugin before running a repair');
  });

  it('perform routes to a manual repair, returns a started line, and unknown names are no-ops', async () => {
    const { t, plugin, h } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false, [DEVICE_NAME_KEY]: 'WorkBarTest-NoSuchDevice' });
    await plugin.activate(t.context);
    expect(await plugin.perform!('repair-now')).toBe('Repair started for WorkBarTest-NoSuchDevice');
    await tick(); await flush();
    expect(repairs(h)).toEqual([expect.objectContaining({ cmd: 'repair', nameQuery: 'WorkBarTest-NoSuchDevice' })]);
    expect(await plugin.perform!('nope')).toBeUndefined();
    await plugin.deactivate();
  });

  it('give-up posts a notification and turns health yellow (never silent)', async () => {
    const { t, plugin, h, sleeps } = await setup(() => FAIL, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    await plugin.perform!('repair-now');
    await tick(); await flush(); await tick(); await flush();
    expect(repairs(h)).toHaveLength(3);
    expect(sleeps).toEqual([2000, 5000]); // 2 s then 5 s between attempts
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0]!.title).toBe('Audio Fix couldn’t repair your monitor');
    expect(t.notifications[0]!.body).toContain('giving up after 3 attempts');
    expect(t.health.at(-1)!.kind).toBe('warning');
    await plugin.deactivate();
  });

  it('a retry that succeeds ends quietly', async () => {
    const { t, plugin, h } = await setup(n => (n === 1 ? FAIL : OK), { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    await plugin.perform!('repair-now');
    await tick(); await flush(); await tick(); await flush();
    expect(repairs(h)).toHaveLength(2);
    expect(t.notifications).toHaveLength(0);
    expect(t.health.at(-1)!.kind).toBe('ok');
  });

  it('an absent monitor is not an error: no retries, no notification', async () => {
    const { t, plugin, h } = await setup(() => ABSENT, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    await plugin.perform!('repair-now');
    await tick(); await flush();
    expect(repairs(h)).toHaveLength(1);
    expect(t.notifications).toHaveLength(0);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'S2725QC not connected — watching for it to appear' });
  });

  it('auto-repair on: watches, and runs one startup repair', async () => {
    const { t, plugin, h } = await setup();
    await plugin.activate(t.context);
    await tick(); await flush();
    expect(h.sent.map(s => s.cmd)).toEqual(['watch', 'repair']);
    expect(t.health.map(x => x.kind)).toContain('ok');
    expect(t.status.get('state')).toBe('S2725QC [AB:1] → 2ch 24-bit 48000 Hz (lpcm)');
    await plugin.deactivate();
    expect(h.stops).toBe(1);
  });

  it('a burst of device-list changes settles into a single repair, only after the settle delay', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, {}, clock, 60);
    await plugin.activate(t.context);
    await tick(); await flush();
    expect(repairs(h)).toHaveLength(1); // startup
    // Each event restarts the settle window; the guard is open, so only the
    // debounce can keep this to one repair.
    clock.t += 60_000;
    for (let i = 0; i < 4; i++) { plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' }); await new Promise(r => setTimeout(r, 20)); }
    await flush();
    expect(repairs(h)).toHaveLength(1); // 80 ms of events, still settling: nothing yet
    await new Promise(r => setTimeout(r, 120)); await flush();
    expect(repairs(h)).toHaveLength(2); // exactly one for the whole burst
    await plugin.deactivate();
  });

  it('the recency guard skips an automatic repair right after a repair; a manual one bypasses it', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, {}, clock);
    await plugin.activate(t.context);
    await tick(); await flush();
    expect(repairs(h)).toHaveLength(1);
    clock.t += 5_000; // inside the 10 s guard
    plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(1); // skipped
    await plugin.perform!('repair-now');
    await tick(); await flush();
    expect(repairs(h)).toHaveLength(2); // manual bypasses
    clock.t += 5_000; // a manual repair still records its time
    plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(2);
    await plugin.deactivate();
  });

  it('turning auto-repair off stops watching and cancels a pending repair', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, {}, clock);
    await plugin.activate(t.context);
    await tick(); await flush();
    clock.t += 60_000;
    plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' });
    await t.context.settings.set(AUTO_REPAIR_KEY, false);
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(h.sent.map(s => s.cmd)).toContain('unwatch');
    expect(repairs(h)).toHaveLength(1);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'Auto-repair off — use Repair Now' });
  });

  // ------------------------------------------------ proactive triggers (2.1.0)

  it('repairs periodically while idle, without feeding the recency guard', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, {}, clock, 5, 20);
    await plugin.activate(t.context);
    await tick(); await flush();
    expect(idleRepairs(h)).toHaveLength(0); // the first tick comes later
    clock.t += 11_000; // past the startup repair's guard
    await new Promise(r => setTimeout(r, 50)); await flush();
    const idle = idleRepairs(h);
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(idle[0]).toMatchObject({ nameQuery: 'S2725QC' });
    expect(t.status.get('state')).toBe('S2725QC [AB:1] → 2ch 24-bit 48000 Hz (lpcm)');
    // The idle repair must not suppress a device-list repair: docking re-sticks
    // the stream. 5 s after the idle repair the 10 s gate would block it if the
    // idle repair had fed it (the startup repair is 16 s old, so the gate is open).
    clock.t += 5_000;
    plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(2);
    await plugin.deactivate();
  });

  it('idle replies are quiet: busy and absent change nothing', async () => {
    const clock = { t: 1_000_000 };
    const replies = [BUSY, ABSENT];
    const { t, plugin, h } = await setup(n => replies[n - 1] ?? BUSY, {}, clock, 5, 15);
    await plugin.activate(t.context);
    await new Promise(r => setTimeout(r, 60)); await flush();
    expect(idleRepairs(h).length).toBeGreaterThanOrEqual(2);
    expect(t.notifications).toHaveLength(0);
    expect(t.health.at(-1)).toEqual({ kind: 'ok', detail: 'Watching for S2725QC' });
    await plugin.deactivate();
  });

  it('a failed idle repair warns once — no retries, no notification', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h, sleeps } = await setup(() => FAIL, {}, clock, 5, 15);
    await plugin.activate(t.context);
    await new Promise(r => setTimeout(r, 50)); await flush();
    // The startup repair (the first `repair`) retries 3 times; the idle pass
    // after it is exactly one attempt with no backoff sleeps of its own.
    const idleCount = idleRepairs(h).length;
    expect(idleCount).toBeGreaterThanOrEqual(1);
    expect(sleeps).toEqual([2000, 5000]); // only the startup repair's backoff
    expect(t.notifications).toHaveLength(1); // the startup give-up notification
    expect(t.health.at(-1)!.kind).toBe('warning');
    await plugin.deactivate();
  });

  it('an idle tick is skipped while a device-list repair is settling', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, {}, clock, 60, 20);
    await plugin.activate(t.context);
    await tick(); await flush();
    plugin.onHelperMessage!('audiofix', { event: 'devicesChanged' });
    await new Promise(r => setTimeout(r, 50)); await flush(); // inside the 60 ms settle
    expect(idleRepairs(h)).toHaveLength(0);
    await new Promise(r => setTimeout(r, 120)); await flush();
    expect(idleRepairs(h).length).toBeGreaterThanOrEqual(1);
    await plugin.deactivate();
  });

  it('repairWhileIdle off arms no idle timer', async () => {
    const { t, plugin, h } = await setup(() => OK, { [REPAIR_WHILE_IDLE_KEY]: false }, { t: 1_000_000 }, 5, 20);
    await plugin.activate(t.context);
    await new Promise(r => setTimeout(r, 60)); await flush();
    expect(idleRepairs(h)).toHaveLength(0);
    expect(repairs(h)).toHaveLength(1); // just the startup repair
    await plugin.deactivate();
  });

  it('playback starting repairs only after the 10-minute window, and an idle repair counts into it', async () => {
    const clock = { t: 1_000_000 };
    // The injected clock only moves when the test moves it, so later idle
    // passes must reply busy (which does not refresh lastAnyRepairAt) — only
    // the first idle repair, at t+60 s, may count into the play window.
    const script = (n: number) => (n <= 2 ? OK : BUSY);
    const { t, plugin, h } = await setup(script, {}, clock, 5, 20);
    await plugin.activate(t.context);
    await tick(); await flush();
    clock.t += 60_000;
    await new Promise(r => setTimeout(r, 50)); await flush(); // idle repair at t+60 s
    expect(idleRepairs(h).length).toBeGreaterThanOrEqual(1);
    clock.t += 9 * 60_000; // 9 min since the idle repair: inside the play window
    plugin.onHelperMessage!('audiofix', { event: 'targetActive' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(1); // skipped
    clock.t += 2 * 60_000; // 11 min since the idle repair: the window is open
    plugin.onHelperMessage!('audiofix', { event: 'targetActive' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(2); // the backstop fired
    await plugin.deactivate();
  });

  it('repairOnPlayback off disables the backstop', async () => {
    const clock = { t: 1_000_000 };
    const { t, plugin, h } = await setup(() => OK, { [REPAIR_ON_PLAYBACK_KEY]: false }, clock, 5, 5 * 60_000);
    await plugin.activate(t.context);
    await tick(); await flush();
    clock.t += PLAY_GUARD_MS + 60_000;
    plugin.onHelperMessage!('audiofix', { event: 'targetActive' });
    await new Promise(r => setTimeout(r, 40)); await flush();
    expect(repairs(h)).toHaveLength(1); // only the startup repair
    await plugin.deactivate();
  });

  it('a crashed helper is restarted and its listeners re-armed', async () => {
    const { t, plugin, h } = await setup(() => OK, {});
    await plugin.activate(t.context);
    await tick(); await flush();
    const watches = h.sent.filter(s => s.cmd === 'watch');
    expect(watches).toHaveLength(1);
    h.crash();
    await plugin.perform!('repair-now');
    await tick(); await flush(); await tick(); await flush();
    expect(h.starts).toBe(2);
    expect(h.sent.filter(s => s.cmd === 'watch')).toHaveLength(2);
    expect(h.sent.filter(s => s.cmd === 'watch')[1]).toMatchObject({ nameQuery: 'S2725QC' });
    expect(repairs(h)).toHaveLength(2);
    expect(t.notifications).toHaveLength(0);
    await plugin.deactivate();
  });

  it('a helper that stops answering fails the attempt instead of hanging', async () => {
    const { t, plugin } = await setup(() => 'silent', { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    await plugin.perform!('repair-now');
    await new Promise(r => setTimeout(r, 900)); await flush(); // 3 attempts × 200 ms timeout
    expect(t.notifications).toHaveLength(1);
    expect(t.notifications[0]!.body).toContain('did not answer');
  });

  it('a crashed helper is restarted for the next request', async () => {
    const { t, plugin, h } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    await plugin.perform!('repair-now');
    await tick(); await flush();
    expect(h.starts).toBe(1);
    h.crash();
    await plugin.perform!('repair-now');
    await tick(); await flush(); await tick(); await flush();
    expect(h.starts).toBe(2);
    expect(repairs(h)).toHaveLength(2);
    expect(t.notifications).toHaveLength(0);
  });

  it('list-devices returns and publishes the device list', async () => {
    const { t, plugin } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    const text = await plugin.perform!('list-devices');
    expect(text).toBe('S2725QC [AB:1] 2ch 24-bit 48000 Hz (lpcm)');
    expect(t.status.get('devices')).toBe(text);
  });

  it('list-devices also recovers a crashed helper (it has no retry loop of its own)', async () => {
    const { t, plugin, h } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    expect(await plugin.perform!('list-devices')).toContain('S2725QC');
    h.crash();
    expect(await plugin.perform!('list-devices')).toContain('S2725QC');
    expect(h.starts).toBe(2);
  });

  it('a device UID in settings is passed to the helper', async () => {
    const { t, plugin, h } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false, [DEVICE_UID_KEY]: '  AB:1  ' });
    await plugin.activate(t.context);
    expect(await plugin.perform!('repair-now')).toBe('Repair started for S2725QC [AB:1]');
    await tick(); await flush();
    expect(repairs(h)[0]).toMatchObject({ nameQuery: 'S2725QC', uid: 'AB:1' });
  });

  it('ignores helper lines it does not understand', async () => {
    const { t, plugin } = await setup(() => OK, { [AUTO_REPAIR_KEY]: false });
    await plugin.activate(t.context);
    plugin.onHelperMessage!('audiofix', { nonsense: true });
    plugin.onHelperMessage!('audiofix', 'text');
    plugin.onHelperMessage!('other', { event: 'devicesChanged' });
    expect(t.notifications).toHaveLength(0);
  });

  describe('helper exit', () => {
    const exit = { code: 1, signal: null };
    const watches = (h: { sent: Sent[] }) => h.sent.filter(s => s.cmd === 'watch');

    it('an unexpected exit restarts the helper and re-sends watch, backing off 1 s then stopping at the first success', async () => {
      const { t, plugin, h, sleeps } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      expect(h.starts).toBe(1);
      expect(watches(h)).toHaveLength(1);
      await plugin.onHelperExit!('audiofix', exit);
      expect(sleeps).toEqual([1000]);
      expect(h.starts).toBe(2);
      expect(watches(h)).toHaveLength(2);
      expect(t.health.at(-1)).toMatchObject({ kind: 'ok' });
      await plugin.deactivate();
    });

    it('restarts even when a failed send already cleared the watch before the exit arrived', async () => {
      // The race: a repair's send fails first (request() clears `watching`, and its own restart is refused
      // because the host still lists the dead helper), then the exit event lands. Auto-repair must come back.
      const { t, plugin, h } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      const realStart = h.helpers.start;
      h.crash();
      h.helpers.start = async () => { throw new Error('helper "audiofix" is already running'); };
      await plugin.perform!('repair-now');
      await tick(); await flush();
      h.helpers.start = realStart;
      const before = watches(h).length;
      await plugin.onHelperExit!('audiofix', exit);
      expect(watches(h)).toHaveLength(before + 1);
      expect(t.health.at(-1)).toMatchObject({ kind: 'ok' });
      await plugin.deactivate();
    });

    it('retries with 1 s, 5 s, 30 s and ends in a warning when every attempt fails', async () => {
      const { t, plugin, h, sleeps } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      const realStart = h.helpers.start;
      h.helpers.start = async () => { throw new Error('spawn failed'); };
      await plugin.onHelperExit!('audiofix', exit);
      expect(sleeps).toEqual([1000, 5000, 30_000]);
      expect(t.health.at(-1)).toEqual({ kind: 'warning', detail: 'Audio helper keeps stopping — use Repair Now' });
      h.helpers.start = realStart;
      await plugin.deactivate();
    });

    it('a later attempt that succeeds ends the retries', async () => {
      const { t, plugin, h, sleeps } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      const realStart = h.helpers.start;
      let calls = 0;
      h.helpers.start = async () => { if (++calls < 2) throw new Error('spawn failed'); return realStart(); };
      await plugin.onHelperExit!('audiofix', exit);
      expect(sleeps).toEqual([1000, 5000]);
      expect(t.health.at(-1)).toMatchObject({ kind: 'ok' });
      await plugin.deactivate();
    });

    it('does not restart when auto-repair is off', async () => {
      const { t, plugin, h, sleeps } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      t.settings.set(AUTO_REPAIR_KEY, false);
      await tick(); await flush();
      const starts = h.starts;
      await plugin.onHelperExit!('audiofix', exit);
      expect(h.starts).toBe(starts);
      expect(sleeps).toEqual([]);
      await plugin.deactivate();
    });

    it('does not restart after deactivation, or for another helper name', async () => {
      const { t, plugin, h, sleeps } = await setup(() => OK);
      await plugin.activate(t.context);
      await tick(); await flush();
      await plugin.onHelperExit!('other', exit);
      expect(sleeps).toEqual([]);
      await plugin.deactivate();
      const starts = h.starts;
      await plugin.onHelperExit!('audiofix', exit);
      expect(h.starts).toBe(starts);
      expect(sleeps).toEqual([]);
    });
  });


});
