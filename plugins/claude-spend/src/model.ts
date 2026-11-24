// The usage payload (`/api/organizations/{org}/usage`), its fail-closed decoder
// and the display formatting. Port of ClaudeSpendModels + ClaudeSpendFormatters.
//
// The endpoint has no contract: `spend` and `extra_usage` are REQUIRED (their
// absence fails the decode, so an endpoint-shape change shows the last-good
// snapshot instead of a silent $0); a wrongly typed field fails the decode too;
// everything else is optional. Money is minor units plus the payload's own
// exponent (never a hardcoded /100). Bands and bars use the server-computed
// `utilization` (never recomputed from spend/limit: a $0 limit would divide).

export class DecodeError extends Error {}

export interface Money { readonly amountMinor: number; readonly currency: string; readonly exponent: number }

export interface SpendSummary {
  readonly used?: Money;
  readonly limit?: Money;
  /** Pre-rounded server percent (28): display convenience only. */
  readonly percent?: number;
  /** "normal" | "approaching_limit" | "exceeded" | … (open string). */
  readonly severity?: string;
  readonly enabled?: boolean;
  readonly disabledReason?: string;
}

/** `monthly_limit` and `used_credits` are MINOR units despite the bare names. */
export interface ExtraUsage {
  readonly isEnabled?: boolean;
  readonly monthlyLimit?: number;
  readonly usedCredits?: number;
  readonly utilization?: number;
  readonly currency?: string;
  readonly decimalPlaces?: number;
  readonly disabledReason?: string;
  readonly userDisabled?: boolean;
  readonly spendLimitReached?: boolean;
  readonly creditsEverEnabled?: boolean;
}

export interface ClaudeUsageStatus {
  readonly spend: SpendSummary;
  readonly extraUsage: ExtraUsage;
  /** Seat-window objects: shape unknown (null on a usage-credits org), captured untouched. */
  readonly fiveHour?: unknown;
  readonly sevenDay?: unknown;
  readonly sevenDayCowork?: unknown;
  readonly limits?: readonly unknown[];
  readonly memberDashboardAvailable?: boolean;
}

// ---------------------------------------------------------------- decoding

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (what: string): never => { throw new DecodeError(what); };
const absent = (v: unknown) => v === undefined || v === null;

function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  if (absent(v)) return undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${k} is not a number`);
}
function int(o: Record<string, unknown>, k: string): number | undefined {
  const v = num(o, k);
  return v === undefined || Number.isInteger(v) ? v : fail(`${k} is not an integer`);
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  if (absent(v)) return undefined;
  return typeof v === 'string' ? v : fail(`${k} is not a string`);
}
function bool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  if (absent(v)) return undefined;
  return typeof v === 'boolean' ? v : fail(`${k} is not a boolean`);
}
const some = <T>(entries: Array<[string, T | undefined]>): Record<string, T> =>
  Object.fromEntries(entries.filter((e): e is [string, T] => e[1] !== undefined));

function money(o: Record<string, unknown>, k: string): Money | undefined {
  const v = o[k];
  if (absent(v)) return undefined;
  if (!isObj(v)) return fail(`${k} is not an object`);
  const amountMinor = int(v, 'amount_minor'); const currency = str(v, 'currency'); const exponent = int(v, 'exponent');
  if (amountMinor === undefined || currency === undefined || exponent === undefined) return fail(`${k} is missing amount_minor, currency or exponent`);
  return { amountMinor, currency, exponent };
}

/** Parses and validates a usage payload. Throws DecodeError: the caller keeps the last-good snapshot. */
export function decodeUsage(text: string): ClaudeUsageStatus {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return fail('not JSON'); }
  if (!isObj(raw)) return fail('not an object');
  const s = raw.spend; const e = raw.extra_usage;
  if (!isObj(s)) return fail('spend is missing');
  if (!isObj(e)) return fail('extra_usage is missing');
  const limits = raw.limits;
  if (!absent(limits) && !Array.isArray(limits)) return fail('limits is not an array');
  return {
    spend: some<unknown>([
      ['used', money(s, 'used')], ['limit', money(s, 'limit')], ['percent', int(s, 'percent')], ['severity', str(s, 'severity')],
      ['enabled', bool(s, 'enabled')], ['disabledReason', str(s, 'disabled_reason')],
    ]) as SpendSummary,
    extraUsage: some<unknown>([
      ['isEnabled', bool(e, 'is_enabled')], ['monthlyLimit', int(e, 'monthly_limit')], ['usedCredits', num(e, 'used_credits')],
      ['utilization', num(e, 'utilization')], ['currency', str(e, 'currency')], ['decimalPlaces', int(e, 'decimal_places')],
      ['disabledReason', str(e, 'disabled_reason')], ['userDisabled', bool(e, 'user_disabled')],
      ['spendLimitReached', bool(e, 'spend_limit_reached')], ['creditsEverEnabled', bool(e, 'credits_ever_enabled')],
    ]) as ExtraUsage,
    ...some<unknown>([
      ['fiveHour', absent(raw.five_hour) ? undefined : raw.five_hour], ['sevenDay', absent(raw.seven_day) ? undefined : raw.seven_day],
      ['sevenDayCowork', absent(raw.seven_day_cowork) ? undefined : raw.seven_day_cowork],
      ['limits', absent(limits) ? undefined : limits], ['memberDashboardAvailable', bool(raw, 'member_dashboard_available')],
    ]),
  } as ClaudeUsageStatus;
}

const snake = (m: Money | undefined) => (m ? { amount_minor: m.amountMinor, currency: m.currency, exponent: m.exponent } : undefined);

/** The snapshot form (same keys as the payload and as the Swift app's stored snapshot). */
export function encodeUsage(u: ClaudeUsageStatus): string {
  const s = u.spend; const e = u.extraUsage;
  return JSON.stringify({
    spend: some<unknown>([['used', snake(s.used)], ['limit', snake(s.limit)], ['percent', s.percent], ['severity', s.severity], ['enabled', s.enabled], ['disabled_reason', s.disabledReason]]),
    extra_usage: some<unknown>([
      ['is_enabled', e.isEnabled], ['monthly_limit', e.monthlyLimit], ['used_credits', e.usedCredits], ['utilization', e.utilization],
      ['currency', e.currency], ['decimal_places', e.decimalPlaces], ['disabled_reason', e.disabledReason], ['user_disabled', e.userDisabled],
      ['spend_limit_reached', e.spendLimitReached], ['credits_ever_enabled', e.creditsEverEnabled],
    ]),
    ...some<unknown>([
      ['five_hour', u.fiveHour], ['seven_day', u.sevenDay], ['seven_day_cowork', u.sevenDayCowork], ['limits', u.limits],
      ['member_dashboard_available', u.memberDashboardAvailable],
    ]),
  });
}

/** Pulls the first string stored under `key` at any depth (org discovery walks an unknown shape). */
export function firstStringValue(v: unknown, key: string): string | undefined {
  if (Array.isArray(v)) { for (const x of v) { const f = firstStringValue(x, key); if (f !== undefined) return f; } return undefined; }
  if (!isObj(v)) return undefined;
  if (typeof v[key] === 'string') return v[key];
  for (const x of Object.values(v)) { const f = firstStringValue(x, key); if (f !== undefined) return f; }
  return undefined;
}

// ---------------------------------------------------------------- derived state

const isMeaningful = (v: unknown): boolean => (v === undefined || v === null ? false : Array.isArray(v) ? v.length > 0 : true);

export const utilizationPercent = (s: ClaudeUsageStatus): number | undefined => s.extraUsage.utilization;

/** Half away from zero, like the Swift `rounded()`. */
const roundHalfAway = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

/** The pre-rounded `spend.percent` when the server still sends it, else `utilization` rounded. */
export function displayPercent(s: ClaudeUsageStatus): number | undefined {
  if (s.spend.percent !== undefined) return s.spend.percent;
  return s.extraUsage.utilization === undefined ? undefined : roundHalfAway(s.extraUsage.utilization);
}

const extraMoney = (e: ExtraUsage, minor: number | undefined): Money | undefined =>
  minor === undefined ? undefined : { amountMinor: Math.trunc(minor), currency: e.currency ?? 'USD', exponent: e.decimalPlaces ?? 2 };
export const usedMoney = (s: ClaudeUsageStatus): Money | undefined => s.spend.used ?? extraMoney(s.extraUsage, s.extraUsage.usedCredits);
export const limitMoney = (s: ClaudeUsageStatus): Money | undefined => s.spend.limit ?? extraMoney(s.extraUsage, s.extraUsage.monthlyLimit);

/** Credits are off (org disabled, user disabled, or the spend block says so): a distinct state, never a $0. */
export const creditsDisabled = (s: ClaudeUsageStatus): boolean =>
  s.extraUsage.isEnabled === false || s.extraUsage.userDisabled === true || s.spend.enabled === false;
export const disabledReason = (s: ClaudeUsageStatus): string | undefined => s.extraUsage.disabledReason ?? s.spend.disabledReason;
export const spendLimitReached = (s: ClaudeUsageStatus): boolean => s.extraUsage.spendLimitReached === true || s.spend.severity === 'exceeded';
export const isOverLimit = (s: ClaudeUsageStatus): boolean => spendLimitReached(s) || s.spend.severity === 'approaching_limit' || s.spend.severity === 'exceeded';
/** Minor-unit spend: reset detection compares these, not formatted strings. */
export const usedCreditsMinor = (s: ClaudeUsageStatus): number | undefined => s.extraUsage.usedCredits;
/** True the day this org leaves usage credits. */
export const hasSeatWindows = (s: ClaudeUsageStatus): boolean =>
  isMeaningful(s.fiveHour) || isMeaningful(s.sevenDay) || isMeaningful(s.sevenDayCowork) || (s.limits?.length ?? 0) > 0;

// ---------------------------------------------------------------- bands + formatting

/** green < 70 / yellow ≥ 70 / red ≥ 90: the same bands as the gateway budget. Ordered, so "up" is new > old. */
export type Band = 0 | 1 | 2;
export const bandFor = (percentage: number): Band => (percentage >= 90 ? 2 : percentage >= 70 ? 1 : 0);

/** `$1,100.00` / `$1,100`: minor ÷ 10^exponent, fraction digits = the exponent, grouping on, en-US. */
export function formatMoney(m: Money): string {
  const fraction = Math.min(Math.max(m.exponent, 0), 8);
  const value = m.amountMinor / 10 ** Math.min(Math.max(m.exponent, 0), 18);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(value);
  } catch { return `${m.amountMinor} minor ${m.currency}`; }
}

/** `28%`: integer, half away from zero. */
export const formatPercent = (utilization: number): string => `${roundHalfAway(utilization)}%`;

/** `Claude credits $304.82 / $1,100.00 (28%)`: the menu status line. */
export function statusLineFor(s: ClaudeUsageStatus): string {
  const used = usedMoney(s); const limit = limitMoney(s); const pct = displayPercent(s);
  return 'Claude credits ' + (used ? formatMoney(used) : '—') + (limit ? ' / ' + formatMoney(limit) : '') + (pct !== undefined ? ` (${pct}%)` : '');
}

/** Numbers without the "Claude credits" prefix (notification bodies carry it in the title). */
export function numbersFor(s: ClaudeUsageStatus): string {
  const used = usedMoney(s); const limit = limitMoney(s); const pct = displayPercent(s);
  return [used ? formatMoney(used) : null, limit ? 'of ' + formatMoney(limit) : null, pct !== undefined ? `(${pct}%)` : null].filter(Boolean).join(' ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 23, 4:05 PM" (local time). */
export function formatStatusTime(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
