// Ports of BoomiBudgetModels.swift and BudgetFormatters.swift: the gateway's
// budget payload (strictly validated: a payload that doesn't fully decode
// is a failed fetch), snapshot encoding, threshold bands, and formatting
// byte-faithful to the Claude Code status line.

/** One rolling budget window. Dates are epoch milliseconds. */
export interface BudgetLimit {
  /** The window label from the payload: "30d". */
  readonly budgetDuration: string;
  readonly maxBudget: number;
  /** Raw, not pre-rounded (109.870176). */
  readonly currentSpend: number;
  /** Pre-computed by the gateway; only rounded for display. */
  readonly usedPercentage: number;
  readonly resetAt: number;
}

export interface BudgetStatus {
  readonly userId: string;
  readonly budgetLimits: readonly BudgetLimit[];
  readonly generatedAt: number;
}

/** The window the menu and health lead with. */
export const primaryLimit = (s: BudgetStatus): BudgetLimit | undefined => s.budgetLimits[0];

export class DecodeError extends Error { constructor(m: string) { super(m); this.name = 'DecodeError'; } }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The gateway's ISO 8601 dialect: offsets or Z, with or without fractions
 *  (fractions beyond milliseconds are dropped). */
export function parseDate(raw: unknown): number {
  if (typeof raw !== 'string' || !ISO.test(raw)) throw new DecodeError(`unparseable ISO-8601 date: ${String(raw)}`);
  const ms = Date.parse(raw.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(ms)) throw new DecodeError(`unparseable ISO-8601 date: ${raw}`);
  return ms;
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new DecodeError(`${what} is not an object`);
  return v as Record<string, unknown>;
};
const num = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new DecodeError(`${what} is not a number`); return v; };
const text = (v: unknown, what: string): string => { if (typeof v !== 'string') throw new DecodeError(`${what} is not a string`); return v; };

/** Decodes the status payload; throws on anything not a complete payload. */
export function decodeStatus(json: string): BudgetStatus {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new DecodeError('not JSON'); }
  const root = obj(parsed, 'payload');
  if (!Array.isArray(root.budget_limits)) throw new DecodeError('budget_limits is not an array');
  return {
    userId: text(root.user_id, 'user_id'),
    budgetLimits: root.budget_limits.map((raw, i) => {
      const l = obj(raw, `budget_limits[${i}]`);
      return {
        budgetDuration: text(l.budget_duration, 'budget_duration'),
        maxBudget: num(l.max_budget, 'max_budget'),
        currentSpend: num(l.current_spend, 'current_spend'),
        usedPercentage: num(l.used_percentage, 'used_percentage'),
        resetAt: parseDate(l.reset_at),
      };
    }),
    generatedAt: parseDate(root.generated_at),
  };
}

/** Snapshot form: the payload's own keys, dates as fractional ISO (as Swift encoded them). */
export function encodeStatus(s: BudgetStatus): string {
  return JSON.stringify({
    user_id: s.userId,
    budget_limits: s.budgetLimits.map(l => ({
      budget_duration: l.budgetDuration, max_budget: l.maxBudget, current_spend: l.currentSpend,
      used_percentage: l.usedPercentage, reset_at: new Date(l.resetAt).toISOString(),
    })),
    generated_at: new Date(s.generatedAt).toISOString(),
  });
}

// ---- Bands ----

/** 0 green (< 70%), 1 yellow (70–90%), 2 red (90%+); ordered for crossings. */
export type BudgetBand = 0 | 1 | 2;
export const GREEN: BudgetBand = 0;
export const YELLOW: BudgetBand = 1;
export const RED: BudgetBand = 2;
export const bandFor = (percentage: number): BudgetBand => (percentage >= 90 ? RED : percentage >= 70 ? YELLOW : GREEN);

// ---- Formatting ----

/** Half away from zero, like Swift's .rounded(). */
const roundHalfAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v));

/** "$109.87": scale to cents, round half away from zero, format. */
export const money = (value: number): string => `$${(roundHalfAway(value * 100) / 100).toFixed(2)}`;

/** "12%". */
export const percent = (value: number): string => `${roundHalfAway(value)}%`;

/** "12d 18h" / "18h 24m" / "5m" / "now" (≤ 60 s or past). */
export function countdown(untilMs: number, nowMs: number): string {
  const remaining = (untilMs - nowMs) / 1000;
  if (remaining <= 60) return 'now';
  const seconds = Math.trunc(remaining);
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours}h ${Math.floor((seconds % 3_600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
}

/** "30d: $109.87/$900.00 (12%), resets in 12d 18h". */
export const line = (l: BudgetLimit, nowMs: number): string =>
  `${l.budgetDuration}: ${money(l.currentSpend)}/${money(l.maxBudget)} (${percent(l.usedPercentage)}), resets in ${countdown(l.resetAt, nowMs)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "MMM d, h:mm a" in local time. */
export function formatStatusTime(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
