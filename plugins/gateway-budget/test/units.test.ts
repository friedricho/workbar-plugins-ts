// Ported from BoomiBudgetModelsTests, BudgetFormattersTests,
// BudgetGatewayTests and GatewayTokenProviderTests.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bandFor, countdown, decodeStatus, encodeStatus, line, money, percent, primaryLimit, GREEN, RED, YELLOW } from '../src/model.js';
import { BudgetClientError, BudgetGateway, GatewayTokenError, GatewayTokenProvider, normalizedStatusURL, PRODUCTION_URL } from '../src/gateway.js';
import { CANARY, fakeHttp, fixture, MockTokenProvider, stubHelper } from './support.js';

describe('payload decoding', () => {
  it('the live payload decodes: +00:00 offsets, fractional seconds, raw numbers', () => {
    const s = decodeStatus(fixture('budget-status-live'));
    expect(s.userId).toBe('owen.friedrich@boomi.com');
    expect(s.budgetLimits).toHaveLength(1);
    expect(primaryLimit(s)).toEqual({ budgetDuration: '30d', maxBudget: 900, currentSpend: 109.870176, usedPercentage: 12.21, resetAt: 1_796_083_200_000 });
    expect(Math.abs(s.generatedAt / 1000 - 1_795_024_354.970343)).toBeLessThan(0.001);
  });
  it('Z-suffixed dates decode (fractional and plain)', () => {
    const s = decodeStatus(fixture('budget-status-z'));
    expect(primaryLimit(s)!.budgetDuration).toBe('1d');
    expect(primaryLimit(s)!.resetAt).toBe(1_795_046_400_000);
    expect(Math.abs(s.generatedAt / 1000 - 1_795_024_800.123)).toBeLessThan(0.001);
  });
  it('multiple budget windows decode in order', () => {
    const s = decodeStatus(fixture('budget-status-multi-window'));
    expect(s.budgetLimits.map(l => l.budgetDuration)).toEqual(['30d', '1d']);
    expect(primaryLimit(s)!.usedPercentage).toBe(70);
    expect(s.budgetLimits[1]!.currentSpend).toBe(12.5);
  });
  it('malformed payloads are rejected, not half-parsed', () => {
    expect(() => decodeStatus('not json')).toThrow();
    expect(() => decodeStatus('{"user_id": "x"}')).toThrow();
    expect(() => decodeStatus('{"user_id": "x", "budget_limits": [], "generated_at": "yesterday-ish"}')).toThrow();
    expect(() => decodeStatus('{"user_id": "x", "budget_limits": [{}], "generated_at": "2026-11-18T17:52:34+00:00"}')).toThrow();
  });
  it('snapshot encode/decode round-trips exactly', () => {
    const original = decodeStatus(fixture('budget-status-multi-window'));
    expect(decodeStatus(encodeStatus(original))).toEqual(original);
  });
});

describe('formatting', () => {
  const now = 1_794_960_000_000; // 2026-11-18T00:00:00Z
  it('money rounds to cents, half away from zero', () => {
    expect([109.870176, 900, 109.875, 0.004, 12.5, 47.5].map(money)).toEqual(['$109.87', '$900.00', '$109.88', '$0.00', '$12.50', '$47.50']);
  });
  it('percent rounds to an integer, half away from zero', () => {
    expect([12.21, 12.49, 12.5, 95, 70].map(percent)).toEqual(['12%', '12%', '13%', '95%', '70%']);
  });
  it('countdown ladder: d h → h m → m → now', () => {
    const at = (s: number) => countdown(now + s * 1000, now);
    expect(at(12 * 86_400 + 18 * 3_600)).toBe('12d 18h');
    expect(at(86_400)).toBe('1d 0h');
    expect(at(18 * 3_600 + 24 * 60)).toBe('18h 24m');
    expect(at(3_600)).toBe('1h 0m');
    expect(at(5 * 60)).toBe('5m');
    expect(at(61)).toBe('1m');
    expect([at(60), at(1), at(-1)]).toEqual(['now', 'now', 'now']);
  });
  it('the line matches the status line’s budget display', () => {
    expect(line({ budgetDuration: '30d', maxBudget: 900, currentSpend: 109.870176, usedPercentage: 12.21, resetAt: now + (12 * 86_400 + 18 * 3_600) * 1000 }, now))
      .toBe('30d: $109.87/$900.00 (12%), resets in 12d 18h');
  });
  it('band boundaries: green below 70, yellow at 70, red at 90', () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(bandFor)).toEqual([GREEN, GREEN, YELLOW, YELLOW, RED, RED]);
    expect(RED > YELLOW && YELLOW > GREEN).toBe(true);
  });
});

describe('gateway', () => {
  it('a successful fetch sends the Bearer header and decodes the payload', async () => {
    const http = fakeHttp();
    const tokens = new MockTokenProvider();
    const s = await new BudgetGateway(http, tokens).fetch();
    expect(primaryLimit(s)!.budgetDuration).toBe('30d');
    expect(tokens.calls).toBe(1);
    expect(http.calls[0]).toEqual({ url: PRODUCTION_URL, method: 'GET', headers: { authorization: `Bearer ${CANARY}`, accept: 'application/json' } });
  });
  it('a 401 invalidates the token, retries once, and succeeds', async () => {
    let answered = false;
    const http = fakeHttp({ handler: () => { const r: [number, string] = answered ? [200, fixture('budget-status-live')] : [401, '{}']; answered = true; return r; } });
    const tokens = new MockTokenProvider();
    expect(primaryLimit(await new BudgetGateway(http, tokens).fetch())).toBeDefined();
    expect(http.calls).toHaveLength(2);
    expect(tokens.invalidates).toBe(1);
  });
  it('a second 401 gives up as unauthorized (no retry storms); 403 too', async () => {
    for (const status of [401, 403]) {
      const http = fakeHttp({ handler: () => [status, '{}'] });
      const tokens = new MockTokenProvider();
      await expect(new BudgetGateway(http, tokens).fetch()).rejects.toMatchObject({ kind: 'unauthorized' });
      expect(http.calls).toHaveLength(2);
      expect(tokens.invalidates).toBe(1);
    }
  });
  it('other statuses, transport failures and garbage map to typed errors', async () => {
    for (const status of [500, 404]) {
      await expect(new BudgetGateway(fakeHttp({ handler: () => [status, '{}'] }), new MockTokenProvider()).fetch()).rejects.toMatchObject({ kind: 'http', status });
    }
    await expect(new BudgetGateway(fakeHttp({ error: new Error('offline') }), new MockTokenProvider()).fetch()).rejects.toMatchObject({ kind: 'network' });
    const garbage = new BudgetGateway(fakeHttp({ handler: () => [200, '<html>nginx</html>'] }), new MockTokenProvider()).fetch();
    await expect(garbage).rejects.toMatchObject({ kind: 'badResponse', detail: expect.stringContaining('<html>') });
  });
  it('the 3 s race bounds a slow gateway', async () => {
    await expect(new BudgetGateway(fakeHttp({ delayMs: 1000 }), new MockTokenProvider(), PRODUCTION_URL, 100).fetch()).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('a token-provider failure surfaces as authUnavailable with remediation; no request goes out', async () => {
    const http = fakeHttp();
    const tokens = new MockTokenProvider();
    tokens.error = new GatewayTokenError('helperUnavailable', '/nonexistent/claude-code-helper');
    const err = (await new BudgetGateway(http, tokens).fetch().then(() => null, (e: unknown) => e)) as BudgetClientError;
    expect(err).toMatchObject({ kind: 'authUnavailable' });
    expect(err.message).toContain('CorporateAIClientProvisioning');
    expect(err.message).not.toContain('canary');
    expect(http.calls).toEqual([]);
  });
  it('URL normalization: /v1 bases become the status route; junk falls back', () => {
    expect(normalizedStatusURL('')).toBeNull();
    expect(normalizedStatusURL('  ')).toBeNull();
    expect(normalizedStatusURL('https://gw.example.com')).toBe('https://gw.example.com');
    expect(normalizedStatusURL('https://gw.example.com/')).toBe('https://gw.example.com');
    expect(normalizedStatusURL('https://gw.example.com/v1')).toBe('https://gw.example.com/boomi/budget/status');
    expect(normalizedStatusURL(' https://gw.example.com/v1/ ')).toBe('https://gw.example.com/boomi/budget/status');
    expect(normalizedStatusURL(PRODUCTION_URL)).toBe(PRODUCTION_URL);
  });
});

// The real child-process path against stub sh scripts (POSIX only).
describe.skipIf(process.platform === 'win32')('token provider', () => {
  const runs = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => l === 'x').length : 0);

  it('helper stdout is \\r\\n-trimmed', async () => {
    expect(await new GatewayTokenProvider({ secrets: null, helperPath: stubHelper("printf 'tok-123\\r\\n'\n") }).currentToken()).toBe('tok-123');
  });
  it('a missing helper is helperUnavailable with remediation', async () => {
    const err = (await new GatewayTokenProvider({ secrets: null, helperPath: '/nonexistent/claude-code-helper' }).currentToken().then(() => null, (e: unknown) => e)) as GatewayTokenError;
    expect(err).toMatchObject({ kind: 'helperUnavailable', detail: '/nonexistent/claude-code-helper' });
    expect(err.message).toContain('CorporateAIClientProvisioning');
  });
  it('a nonzero helper exit is helperFailed', async () => {
    await expect(new GatewayTokenProvider({ secrets: null, helperPath: stubHelper('exit 3\n') }).currentToken()).rejects.toMatchObject({ kind: 'helperFailed', detail: 'exit 3' });
  });
  it('empty helper output is helperFailed, not an empty Bearer header', async () => {
    await expect(new GatewayTokenProvider({ secrets: null, helperPath: stubHelper('exit 0\n') }).currentToken()).rejects.toMatchObject({ kind: 'helperFailed', detail: 'no token on stdout' });
  });
  it('a hung helper is bounded by the timeout', async () => {
    await expect(new GatewayTokenProvider({ secrets: null, helperPath: stubHelper('sleep 5\n'), helperTimeoutMs: 200 }).currentToken())
      .rejects.toMatchObject({ kind: 'helperFailed', detail: expect.stringContaining('no answer') });
  });
  it('the saved token wins over the helper', async () => {
    const provider = new GatewayTokenProvider({ secrets: { get: async n => (n === 'gatewayToken' ? 'canary-saved-token' : undefined) }, helperPath: stubHelper('echo called-helper >&2; exit 9\n') });
    expect(await provider.currentToken()).toBe('canary-saved-token');
    expect(provider.usingSavedToken).toBe(true);
  });
  it('the token is cached within the TTL and invalidated on 401', async () => {
    const helper = stubHelper('');
    const counter = path.join(path.dirname(helper), 'count');
    fs.writeFileSync(helper, `#!/bin/sh\necho x >> '${counter}'\nprintf 'tok-123'\n`, { mode: 0o755 });
    const provider = new GatewayTokenProvider({ secrets: null, helperPath: helper });
    await provider.currentToken();
    await provider.currentToken();
    expect(runs(counter)).toBe(1);
    provider.invalidate();
    await provider.currentToken();
    expect(runs(counter)).toBe(2);
  });
  it('an expired cache re-fetches (TTL 0)', async () => {
    const helper = stubHelper('');
    const counter = path.join(path.dirname(helper), 'count');
    fs.writeFileSync(helper, `#!/bin/sh\necho x >> '${counter}'\nprintf 'tok-123'\n`, { mode: 0o755 });
    const provider = new GatewayTokenProvider({ secrets: null, helperPath: helper, cacheTTLms: 0 });
    await provider.currentToken();
    await provider.currentToken();
    expect(runs(counter)).toBe(2);
  });
});
