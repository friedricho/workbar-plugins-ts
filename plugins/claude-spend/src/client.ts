// One cookie-authenticated GET of the member usage route (what Claude
// Desktop's Settings → Usage page fetches: undocumented, member-facing).
// Port of the Swift ClaudeUsageClient. Holds no state beyond its seams; the
// plugin owns snapshots, bands and scheduling. The org id is never hardcoded:
// a pasted override wins, else the `lastActiveOrg` cookie, else the cached
// discovery, else the org-listing API.
import type { HttpClient, SettingsStore } from '@workbar/sdk';
import { cookieHeader, SessionCookieError, type CookiePair, type CookieSource } from './cookies.js';
import { decodeUsage, firstStringValue, type ClaudeUsageStatus } from './model.js';

export const BASE_URL = 'https://claude.ai';
/** The probe sent a browser UA and got a clean 200; the desktop app's own request does the same. */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const ORG_UUID_KEY = 'orgUUID';
export const ORG_UUID_OVERRIDE_KEY = 'orgUUIDOverride';
export const REQUEST_TIMEOUT_MS = 3000;

export type UsageErrorKind = 'authUnavailable' | 'unauthorized' | 'cloudflareBlock' | 'network' | 'timeout' | 'badResponse' | 'http';

/** User-facing; NEVER cookie material (it travels in headers). */
export class UsageError extends Error {
  constructor(readonly kind: UsageErrorKind, detail = '', readonly status = 0) {
    super(describe(kind, detail, status));
    this.name = 'UsageError';
  }
}

function describe(kind: UsageErrorKind, detail: string, status: number): string {
  switch (kind) {
    case 'authUnavailable': return `couldn’t get Claude Desktop’s session cookies: ${detail}`;
    case 'unauthorized': return 'claude.ai rejected the desktop session — sign in to Claude Desktop';
    case 'cloudflareBlock': return 'claude.ai answered with a Cloudflare challenge — will retry on the next poll';
    case 'network': return `claude.ai was unreachable: ${detail}`;
    case 'timeout': return 'claude.ai didn’t answer within 3s';
    case 'badResponse': return `claude.ai’s response couldn’t be parsed: ${detail}`;
    case 'http': return `claude.ai returned HTTP ${status}`;
  }
}

/** Cheap HTML sniff for the Cloudflare-vs-auth 403 split. */
export function bodyIsHTML(text: string): boolean {
  const t = text.slice(0, 256).trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html');
}

/** Short, sanitized body prefix for bad-response diagnostics. */
export const bodyPreview = (text: string): string => text.slice(0, 120).replace(/[\r\n]/g, ' ');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeUsageClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cookies: CookieSource,
    private readonly settings: SettingsStore,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /** Fetch and decode. A 401 gets exactly one fresh-cookie retry (the desktop app may have
   *  refreshed the session since the last poll; the provider re-reads the DB by construction). */
  async fetch(): Promise<ClaudeUsageStatus> {
    try { return await this.attempt(); }
    catch (e) {
      if (e instanceof UsageError && e.kind === 'unauthorized') { this.cookies.invalidate(); return this.attempt(); }
      throw e;
    }
  }

  private async attempt(): Promise<ClaudeUsageStatus> {
    let pairs;
    try { pairs = await this.cookies.cookies(); }
    catch (e) { throw new UsageError('authUnavailable', e instanceof SessionCookieError ? e.message : e instanceof Error ? e.message : 'unknown error'); }

    const org = await this.resolveOrg(pairs);
    const text = await this.get(`${BASE_URL}/api/organizations/${org}/usage`, pairs);
    try { return decodeUsage(text); }
    catch { throw new UsageError('badResponse', `first bytes: ${bodyPreview(text)}`); }
  }

  /** Precedence: pasted override → the `lastActiveOrg` cookie (must be a UUID) → the cached discovery → the org API. */
  private async resolveOrg(pairs: readonly CookiePair[]): Promise<string> {
    const trimmed = async (key: string) => { const v = await this.settings.get<string>(key); return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined; };
    const override = await trimmed(ORG_UUID_OVERRIDE_KEY);
    if (override && UUID.test(override)) return override;

    const active = pairs.find(p => p.name === 'lastActiveOrg')?.value.trim();
    if (active && UUID.test(active)) { await this.settings.set(ORG_UUID_KEY, active); return active; }

    const cached = await trimmed(ORG_UUID_KEY);
    if (cached && UUID.test(cached)) return cached;

    const text = await this.get(`${BASE_URL}/api/organizations`, pairs);
    let uuid: string | undefined;
    try { uuid = firstStringValue(JSON.parse(text), 'uuid'); } catch { /* falls through to the paste-it message */ }
    if (!uuid || !UUID.test(uuid)) throw new UsageError('authUnavailable', 'couldn’t discover the Claude org id — paste it on this page');
    await this.settings.set(ORG_UUID_KEY, uuid);
    return uuid;
  }

  private async get(url: string, pairs: readonly CookiePair[]): Promise<string> {
    let res: { status: number; text: string };
    try {
      res = await this.http.fetch(url, { method: 'GET', headers: { cookie: cookieHeader(pairs), 'user-agent': USER_AGENT, accept: 'application/json' }, timeoutMs: this.timeoutMs });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw /timed out/i.test(m) ? new UsageError('timeout') : new UsageError('network', m);
    }
    if (res.status >= 200 && res.status <= 299) return res.text;
    if (res.status === 401) throw new UsageError('unauthorized');
    // 403 with an HTML body is Cloudflare, not auth.
    if (res.status === 403) throw bodyIsHTML(res.text) ? new UsageError('cloudflareBlock') : new UsageError('unauthorized');
    throw new UsageError('http', '', res.status);
  }
}
