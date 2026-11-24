// Cooldown-limited connection-failure banners (port of the Swift OutageNotifier).
//
// The gate is deliberately TIME-ONLY: at most one banner per cooldown window,
// whether the endpoint is down continuously or flapping (a success does NOT
// re-arm it: that re-arm was the outage spam). The last-post time persists in
// the plugin's settings, so a relaunch during an outage stays quiet inside the
// window. A suppressed failure is never silent: the caller still reports health.
import type { SettingsStore } from '@workbar/sdk';

export const OUTAGE_KEY = 'outage.lastPostedAt';
export const DEFAULT_COOLDOWN_MS = 3_600_000;

export class OutageNotifier {
  constructor(
    private readonly settings: SettingsStore,
    private readonly enabledKey: string | null = null,
    private readonly cooldownMs: number = DEFAULT_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** True = post the banner now: the first failure of an outage, or the window has elapsed.
   *  A disabled toggle returns false WITHOUT stamping the clock: a banner that never showed
   *  must not start the window. */
  async recordFailure(): Promise<boolean> {
    if (this.enabledKey && (await this.settings.get<boolean>(this.enabledKey)) === false) return false;
    const at = this.now();
    const last = Date.parse(String(await this.settings.get(OUTAGE_KEY) ?? ''));
    if (Number.isFinite(last) && at - last < this.cooldownMs) return false;
    await this.settings.set(OUTAGE_KEY, new Date(at).toISOString());
    return true;
  }
}
