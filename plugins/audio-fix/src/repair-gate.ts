// Pure repair-gating logic, ported from the Swift RepairGate.
//
// The repair is DELIBERATELY non-idempotent: the 16→24-bit format transition
// is the fix, and it runs even when CoreAudio already reports 24-bit (that is
// what resets a stuck monitor driver). Recency is therefore the only
// idempotency protection there is: the guard interval.

export const DEFAULT_GUARD_SECONDS = 10;
export const DEFAULT_MAX_ATTEMPTS = 3;

export class RepairGate {
  private last: number | null;

  constructor(
    readonly guardSeconds: number = DEFAULT_GUARD_SECONDS,
    readonly maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    lastRepairAt: number | null = null,
  ) { this.last = lastRepairAt; }

  get lastRepairAt(): number | null { return this.last; }

  /** Whether an AUTOMATIC repair may run at `nowMs`. A manual "Repair Now"
   *  bypasses this (the user asked) but still records its time, so an
   *  automatic repair right after doesn't repeat the transition. */
  canRepair(nowMs: number): boolean {
    if (this.last === null) return true;
    return (nowMs - this.last) / 1000 >= this.guardSeconds;
  }

  /** Seconds to wait after failed attempt `failedAttempt` (1-based): 2 s
   *  after the first failure, 5 s after later ones (the old agent's schedule). */
  backoffSeconds(failedAttempt: number): number {
    return failedAttempt === 1 ? 2 : 5;
  }

  recordRepair(atMs: number): void { this.last = atMs; }
}
