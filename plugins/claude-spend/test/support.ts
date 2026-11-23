// Test helpers: byte-exact fixtures (copied from the Swift repo), a fake
// HttpClient and a fake cookie source. Never the real Keychain or cookie DB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpClient } from '@workbar/sdk';
import type { CookiePair, CookieSource } from '../src/cookies.js';

export const fixture = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.json`), 'utf8');

export const CANARY_SESSION = 'canary-session-key-abc123';
export const CANARY_ORG = '11111111-2222-3333-4444-555555555555';

export interface Call { url: string; method: string; headers: Record<string, string> }

/** Answers with `handler` (default: the live fixture); `error` throws; `delayMs` stalls. */
export function fakeHttp(o: { handler?: (c: Call) => [number, string]; error?: Error; delayMs?: number } = {}) {
  const http = {
    calls: [] as Call[],
    handler: o.handler as ((c: Call) => [number, string]) | undefined,
    error: o.error as Error | undefined,
    delayMs: o.delayMs ?? 0,
    fetch: (async (url: string, init: { method?: string; headers?: Readonly<Record<string, string>>; timeoutMs?: number } = {}) => {
      http.calls.push({ url, method: init.method ?? 'GET', headers: { ...init.headers } });
      if (http.error) throw http.error;
      if (http.delayMs) await new Promise(r => setTimeout(r, http.delayMs));
      const [status, text] = http.handler?.(http.calls.at(-1)!) ?? [200, fixture('claude-usage-live')];
      return { status, text, headers: {} };
    }) as HttpClient['fetch'],
  };
  return http;
}

export class FakeCookies implements CookieSource {
  calls = 0;
  invalidates = 0;
  error: unknown = null;
  usingSavedCookie = false;
  pairs: CookiePair[] = [
    { name: 'sessionKey', value: CANARY_SESSION, domain: 'claude.ai' },
    { name: 'lastActiveOrg', value: CANARY_ORG, domain: 'claude.ai' },
  ];
  async cookies(): Promise<CookiePair[]> { this.calls++; if (this.error) throw this.error; return this.pairs; }
  invalidate(): void { this.invalidates++; }
}

/** A payload with the given spend and utilization: drives the threshold and reset tests. */
/** `usedCredits` is the float `extra_usage.used_credits` (defaults to usedMinor); `spend.used.amount_minor` is always an integer, as in the real payload. */
export function usageJSON(o: { usedMinor: number; limitMinor: number; utilization: number; usedCredits?: number; spendLimitReached?: boolean; severity?: string }): string {
  return JSON.stringify({
    five_hour: null, seven_day: null, seven_day_cowork: null,
    extra_usage: { is_enabled: true, monthly_limit: o.limitMinor, used_credits: o.usedCredits ?? o.usedMinor, utilization: o.utilization, currency: 'USD', decimal_places: 2, disabled_reason: null, user_disabled: false, spend_limit_reached: o.spendLimitReached ?? false, credits_ever_enabled: true, daily: null, weekly: null },
    limits: [],
    spend: { used: { amount_minor: o.usedMinor, currency: 'USD', exponent: 2 }, limit: { amount_minor: o.limitMinor, currency: 'USD', exponent: 2 }, percent: Math.round(o.utilization), severity: o.severity ?? 'normal', enabled: true, disabled_reason: null, can_purchase_credits: false },
    member_dashboard_available: true,
  });
}
