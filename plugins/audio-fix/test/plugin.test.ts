// The Swift AudioFixPluginTests wiring cases, plus the behavior that moved
// from the Swift watcher into TypeScript (settle, guard, retries) and the new
// helper boundary. A scripted fake helper stands in for CoreAudio.
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '@workbar/sdk/testing';
import { validateSettingsSchema } from '@workbar/sdk';
import { AUTO_REPAIR_KEY, createAudioFix, DEVICE_NAME_KEY, DEVICE_UID_KEY, settingsSchema } from '../src/index.js';

type Sent = { cmd: string; id?: number; nameQuery?: string; uid?: string };
type Plugin = ReturnType<typeof createAudioFix>;

/** A fake helper: records commands; `script` decides the reply to each repair. */
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
          if (c.cmd === 'repair') {
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

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = () => new Promise<void>(r => setTimeout(r, 0));

async function setup(script: (n: number) => Record<string, unknown> | 'silent' = () => OK, settings: Record<string, unknown> = {}, clock = { t: 1_000_000 }, settleMs = 5) {
  const t: TestContext = createTestContext('audiofix');
  const sleeps: number[] = [];
  const plugin = createAudioFix({ now: () => clock.t, sleep: async ms => { sleeps.push(ms); }, settleMs, replyTimeoutMs: 200 });
  const h = fakeHelper(plugin, script);
  (t.context as { helpers: unknown }).helpers = h.helpers;
  for (const [k, v] of Object.entries(settings)) t.settings.set(k, v);
  return { t, plugin, h, sleeps, clock };
}
const repairs = (h: { sent: Sent[] }) => h.sent.filter(s => s.cmd === 'repair');
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
    expect(actions).toEqual([{ name: 'repair-now', title: 'Repair now', summary: 'Repair the monitor’s DisplayPort audio stream', acceptsText: false }]);
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
});
