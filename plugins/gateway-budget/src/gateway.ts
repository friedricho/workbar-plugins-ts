// Ports of GatewayTokenProvider.swift and BudgetGateway.swift.
//
// Token source, in priority order: a token saved on the plugin's page
// (ctx.secrets "gatewayToken"), then the corporate helper binary
// (`/usr/local/boomi/bin/claude-code-helper apikey`), run as a short child
// process with a timeout. The token lives in memory only (never settings,
// logs or error text), cached ~50 minutes and dropped on a 401.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { HttpClient, SecretStore } from '@workbar/sdk';
import { decodeStatus, type BudgetStatus } from './model.js';

export const DEFAULT_HELPER_PATH = '/usr/local/boomi/bin/claude-code-helper';
export const HELPER_ARGUMENTS = ['apikey'] as const;
export const SAVED_TOKEN_NAME = 'gatewayToken';
export const PRODUCTION_URL = 'https://ai-gateway-production.ai-gateway-prod.boomi.com/boomi/budget/status';

export type GatewayTokenErrorKind = 'helperUnavailable' | 'helperFailed';

/** User-facing remediation; never token material. */
export class GatewayTokenError extends Error {
  constructor(readonly kind: GatewayTokenErrorKind, readonly detail: string) {
    super(kind === 'helperUnavailable'
      ? `the corporate token helper is missing at ${detail} — launch CorporateAIClientProvisioning, or save a token on this page`
      : `the corporate token helper failed: ${detail} — launch CorporateAIClientProvisioning, or save a token on this page`);
    this.name = 'GatewayTokenError';
  }
}

export interface TokenProvider {
  /** A token for the Authorization header; never empty on success. */
  currentToken(): Promise<string>;
  /** Drops the cached token (a 401 says it's stale). */
  invalidate(): void;
  /** Whether the last token came from the saved override (existence only). */
  readonly usingSavedToken: boolean;
}

export interface TokenProviderOptions {
  readonly secrets: Pick<SecretStore, 'get'> | null;
  readonly helperPath?: string;
  readonly helperTimeoutMs?: number;
  readonly cacheTTLms?: number;
  readonly now?: () => number;
}

export class GatewayTokenProvider implements TokenProvider {
  private cached: { token: string; at: number } | null = null;
  usingSavedToken = false;
  private readonly helperPath: string;
  private readonly helperTimeoutMs: number;
  private readonly cacheTTLms: number;
  private readonly now: () => number;

  constructor(private readonly o: TokenProviderOptions) {
    this.helperPath = o.helperPath ?? DEFAULT_HELPER_PATH;
    this.helperTimeoutMs = o.helperTimeoutMs ?? 10_000;
    this.cacheTTLms = o.cacheTTLms ?? 50 * 60_000;
    this.now = o.now ?? Date.now;
  }

  async currentToken(): Promise<string> {
    if (this.cached && this.now() - this.cached.at < this.cacheTTLms) return this.cached.token;
    // 1. The saved override (a read error falls through to the helper).
    let saved: string | undefined;
    try { saved = await this.o.secrets?.get(SAVED_TOKEN_NAME); } catch { saved = undefined; }
    if (saved) { this.store(saved, true); return saved; }
    this.usingSavedToken = false;
    // 2. The corporate helper.
    try { await fs.access(this.helperPath, fs.constants.X_OK); }
    catch { throw new GatewayTokenError('helperUnavailable', this.helperPath); }
    const token = (await this.runHelper()).trim();
    if (!token) throw new GatewayTokenError('helperFailed', 'no token on stdout');
    this.store(token, false);
    return token;
  }

  invalidate(): void { this.cached = null; }

  private store(token: string, saved: boolean): void {
    this.usingSavedToken = saved;
    this.cached = { token, at: this.now() };
  }

  private runHelper(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.helperPath, [...HELPER_ARGUMENTS], { timeout: this.helperTimeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (!error) { resolve(stdout); return; }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string | null };
        if (e.killed) reject(new GatewayTokenError('helperFailed', `no answer within ${Math.trunc(this.helperTimeoutMs / 1000)}s`));
        else if (typeof e.code === 'number') reject(new GatewayTokenError('helperFailed', `exit ${e.code}`));
        else reject(new GatewayTokenError('helperFailed', e.message)); // couldn't launch
      });
    });
  }
}

export type BudgetClientErrorKind = 'authUnavailable' | 'unauthorized' | 'network' | 'timeout' | 'badResponse' | 'http';

/** Fetch failures; never the token (it travels in headers). */
export class BudgetClientError extends Error {
  constructor(readonly kind: BudgetClientErrorKind, readonly detail = '', readonly status?: number) {
    super(kind === 'authUnavailable' ? `couldn’t get a gateway token: ${detail}`
      : kind === 'unauthorized' ? 'the gateway rejected the token (401/403) — if it was saved on this page, update it; otherwise re-authenticate in CorporateAIClientProvisioning'
      : kind === 'network' ? `the gateway was unreachable: ${detail}`
      : kind === 'timeout' ? 'the gateway didn’t answer within 3s'
      : kind === 'badResponse' ? `the gateway’s response couldn’t be parsed: ${detail}`
      : `the gateway returned HTTP ${status}`);
    this.name = 'BudgetClientError';
  }
}

/** Trims, drops trailing slashes, rewrites a `/v1` base to the status route.
 *  Null for empty or unparseable input (the caller falls back to production). */
export function normalizedStatusURL(raw: string): string | null {
  let candidate = raw.trim();
  while (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  if (candidate.endsWith('/v1')) candidate = `${candidate.slice(0, -3)}/boomi/budget/status`;
  if (!candidate) return null;
  try { new URL(candidate); } catch { return null; }
  return candidate;
}

/** First 120 bytes of the body, newlines flattened. */
export function bodyPreview(body: string): string {
  const bytes = new TextEncoder().encode(body);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, 120)).replace(/[\r\n]/g, ' '); }
  catch { return `(not UTF-8, ${bytes.length} bytes)`; }
}

export class BudgetGateway {
  constructor(
    private readonly http: HttpClient,
    private readonly tokens: TokenProvider,
    private readonly statusURL: string = PRODUCTION_URL,
    private readonly timeoutMs = 3_000,
  ) {}

  /** One authenticated GET; a 401/403 gets exactly one fresh-token retry. */
  async fetch(): Promise<BudgetStatus> {
    try { return await this.attempt(); }
    catch (e) {
      if (!(e instanceof BudgetClientError && e.kind === 'unauthorized')) throw e;
      this.tokens.invalidate();
      return this.attempt();
    }
  }

  private async attempt(): Promise<BudgetStatus> {
    let token: string;
    try { token = await this.tokens.currentToken(); }
    catch (e) { throw new BudgetClientError('authUnavailable', e instanceof Error ? e.message : String(e)); }
    const body = await this.send(token);
    try { return decodeStatus(body); }
    catch { throw new BudgetClientError('badResponse', `first bytes: ${bodyPreview(body)}`); }
  }

  private async send(token: string): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.timeoutMs); });
    let outcome: { status: number; text: string } | 'timeout';
    try {
      outcome = await Promise.race([
        this.http.fetch(this.statusURL, { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: this.timeoutMs }),
        timeout,
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw /timed out/i.test(message) ? new BudgetClientError('timeout') : new BudgetClientError('network', message);
    } finally { clearTimeout(timer); }
    if (outcome === 'timeout') throw new BudgetClientError('timeout');
    if (outcome.status >= 200 && outcome.status <= 299) return outcome.text;
    if (outcome.status === 401 || outcome.status === 403) throw new BudgetClientError('unauthorized');
    throw new BudgetClientError('http', '', outcome.status);
  }
}
