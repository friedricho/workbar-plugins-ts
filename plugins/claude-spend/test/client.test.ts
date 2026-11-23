// Ported from ClaudeUsageClientTests: header construction, org-id discovery
// (override → cookie → cache → API), the error map (401-retry,
// 403-HTML-is-Cloudflare, HTML bodies, timeout) and the suite-cached org id.
import { describe, expect, it } from 'vitest';
import { createTestContext } from '@workbar/sdk/testing';
import { ClaudeUsageClient, ORG_UUID_KEY, ORG_UUID_OVERRIDE_KEY, USER_AGENT, bodyIsHTML, UsageError } from '../src/client.js';
import { SessionCookieError } from '../src/cookies.js';
import { CANARY_ORG, CANARY_SESSION, FakeCookies, fakeHttp, fixture } from './support.js';

function setup(o: { timeoutMs?: number } = {}) {
  const t = createTestContext('claudespend');
  const http = fakeHttp();
  const cookies = new FakeCookies();
  const client = new ClaudeUsageClient(http, cookies, t.context.settings, o.timeoutMs);
  return { t, http, cookies, client };
}
const kind = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return e instanceof UsageError ? e.kind : `untyped: ${e}`; } };

describe('ClaudeUsageClient', () => {
  it('a 200 fetch decodes, sends the full cookie header and a browser UA, and hits the cookie’s org id', async () => {
    const { t, http, client } = setup();
    const status = await client.fetch();
    expect(status.spend.used).toEqual({ amountMinor: 30482, currency: 'USD', exponent: 2 });
    const call = http.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`https://claude.ai/api/organizations/${CANARY_ORG}/usage`);
    expect(call.headers.cookie).toBe(`sessionKey=${CANARY_SESSION}; lastActiveOrg=${CANARY_ORG}`);
    expect(call.headers.accept).toBe('application/json');
    expect(call.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain('Mozilla');
    expect(t.settings.get(ORG_UUID_KEY)).toBe(CANARY_ORG); // cached (not a secret)
  });

  it('a pasted org override wins over the cookie and the API', async () => {
    const { t, http, client } = setup();
    t.settings.set(ORG_UUID_OVERRIDE_KEY, '99999999-8888-7777-6666-555555555555');
    await client.fetch();
    expect(http.calls[0]!.url).toBe('https://claude.ai/api/organizations/99999999-8888-7777-6666-555555555555/usage');
  });

  it('a non-UUID override is ignored', async () => {
    const { t, http, client } = setup();
    t.settings.set(ORG_UUID_OVERRIDE_KEY, 'not-a-uuid');
    await client.fetch();
    expect(http.calls[0]!.url).toContain(CANARY_ORG);
  });

  it('a non-UUID lastActiveOrg falls back to the org API, caches its uuid, and later calls skip the API', async () => {
    const { t, http, cookies, client } = setup();
    http.handler = c => (c.url.endsWith('/api/organizations')
      ? [200, '{"organizations": [{"name": "Boomi", "uuid": "12345678-1234-1234-1234-123456789012"}]}']
      : [200, fixture('claude-usage-live')]);
    cookies.pairs = [{ name: 'sessionKey', value: 'abc', domain: 'claude.ai' }, { name: 'lastActiveOrg', value: 'not-a-uuid', domain: 'claude.ai' }];
    await client.fetch();
    expect(http.calls.map(c => c.url)).toEqual([
      'https://claude.ai/api/organizations',
      'https://claude.ai/api/organizations/12345678-1234-1234-1234-123456789012/usage',
    ]);
    expect(t.settings.get(ORG_UUID_KEY)).toBe('12345678-1234-1234-1234-123456789012');
    // Stage 2: a fresh client over the same settings uses the cache and skips the API.
    const http2 = fakeHttp();
    await new ClaudeUsageClient(http2, cookies, t.context.settings).fetch();
    expect(http2.calls.map(c => c.url)).toEqual(['https://claude.ai/api/organizations/12345678-1234-1234-1234-123456789012/usage']);
  });

  it('an org API answer with no usable uuid asks the user to paste one', async () => {
    const { http, cookies, client } = setup();
    cookies.pairs = [{ name: 'sessionKey', value: 'abc', domain: 'claude.ai' }];
    http.handler = () => [200, '{"organizations": []}'];
    await expect(client.fetch()).rejects.toThrow(/paste it on this page/);
    http.handler = () => [200, '<html>nope</html>'];
    expect(await kind(client.fetch())).toBe('authUnavailable');
  });

  it('a 401 re-reads the cookies once and succeeds; a second 401 throws unauthorized', async () => {
    const { http, cookies, client } = setup();
    let n = 0;
    http.handler = () => (n++ === 0 ? [401, '{"error": "session expired"}'] : [200, fixture('claude-usage-live')]);
    expect((await client.fetch()).spend.used).toBeDefined();
    expect(cookies.invalidates).toBe(1); // the 401 invalidated before retrying
    http.handler = () => [401, '{"error": "session expired"}'];
    expect(await kind(client.fetch())).toBe('unauthorized');
    expect(cookies.invalidates).toBe(2);
    expect(http.calls).toHaveLength(4); // 2 + 2: each fetch retried once
  });

  it('a 403 with an HTML body is Cloudflare, not an auth failure', async () => {
    const { http, client } = setup();
    http.handler = () => [403, '<!DOCTYPE html><html><body>challenge</body></html>'];
    const e = await client.fetch().catch((x: unknown) => x) as UsageError;
    expect(e.kind).toBe('cloudflareBlock');
    expect(e.message).toContain('Cloudflare');
    expect(e.message).not.toContain('sign in');
  });

  it('a 403 with a JSON body is an auth failure', async () => {
    const { http, client } = setup();
    http.handler = () => [403, '{"error": "forbidden"}'];
    expect(await kind(client.fetch())).toBe('unauthorized');
  });

  it('an HTML 200 body fails closed (badResponse)', async () => {
    const { http, client } = setup();
    http.handler = () => [200, '<html><body>app shell</body></html>'];
    const e = await client.fetch().catch((x: unknown) => x) as UsageError;
    expect(e.kind).toBe('badResponse');
    expect(e.message).toContain('first bytes');
  });

  it('other status codes map to http(code)', async () => {
    const { http, client } = setup();
    http.handler = () => [500, '{}'];
    const e = await client.fetch().catch((x: unknown) => x) as UsageError;
    expect([e.kind, e.status, e.message]).toEqual(['http', 500, 'claude.ai returned HTTP 500']);
  });

  it('transport failures: a timeout and a network error are told apart', async () => {
    const { http, client } = setup();
    http.error = new Error('request to claude.ai timed out after 3000 ms');
    expect(await kind(client.fetch())).toBe('timeout');
    http.error = new Error('net::ERR_INTERNET_DISCONNECTED');
    const e = await client.fetch().catch((x: unknown) => x) as UsageError;
    expect(e.kind).toBe('network');
    expect(e.message).toContain('ERR_INTERNET_DISCONNECTED');
  });

  it('the request carries the 3 s timeout to the transport', async () => {
    const seen: number[] = [];
    const t = createTestContext('claudespend');
    const http = fakeHttp();
    const orig = http.fetch;
    http.fetch = (async (url: string, init: { timeoutMs?: number }) => { seen.push(init.timeoutMs ?? -1); return orig(url, init as never); }) as typeof http.fetch;
    await new ClaudeUsageClient(http, new FakeCookies(), t.context.settings).fetch();
    expect(seen).toEqual([3000]);
  });

  it('a cookie-chain failure becomes authUnavailable with the provider’s remediation, and no request leaves', async () => {
    const { http, cookies, client } = setup();
    cookies.error = new SessionCookieError('keychainDenied', 'security exit 51');
    const e = await client.fetch().catch((x: unknown) => x) as UsageError;
    expect(e.kind).toBe('authUnavailable');
    expect(e.message).toContain('Claude Safe Storage');
    expect(e.message).toContain('approve the prompt');
    expect(http.calls).toEqual([]); // no request without cookies
  });

  it('an untyped cookie failure is still the auth state', async () => {
    const { cookies, client } = setup();
    cookies.error = new Error('boom');
    expect(await kind(client.fetch())).toBe('authUnavailable');
  });

  it('the HTML sniff handles doctype, html tag and non-HTML bodies', () => {
    expect(bodyIsHTML('<!DOCTYPE html><html>')).toBe(true);
    expect(bodyIsHTML('  <html lang="en">')).toBe(true);
    expect(bodyIsHTML('{"error": "forbidden"}')).toBe(false);
  });
});
