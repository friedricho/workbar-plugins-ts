// Port of PendoClient.swift over ctx.http: guide metadata (poll definitions)
// and all-time poll responses via the Aggregation API. Every call races a
// timeout and maps to typed errors. Error messages never include the key.
import type { HttpClient } from '@workbar/sdk';
import { asString, pollMapFromGuide, REGIONS, row, type PendoConfig, type PendoRow, type PollMap } from './model.js';

export type PendoClientErrorKind = 'unauthorized' | 'guideNotFound' | 'rateLimited' | 'network' | 'timeout' | 'badResponse' | 'http';

export class PendoClientError extends Error {
  constructor(readonly kind: PendoClientErrorKind, readonly detail = '', readonly status?: number) {
    super(kind === 'unauthorized' ? 'Pendo rejected the API key (401/403) — check the key and its permissions'
      : kind === 'guideNotFound' ? `Guide ${detail} not found — check the guide ID`
      : kind === 'rateLimited' ? 'Pendo rate-limited the request — retrying at the next scheduled run'
      : kind === 'network' ? `Pendo unreachable: ${detail}`
      : kind === 'timeout' ? 'Pendo didn’t answer within the timeout'
      : kind === 'badResponse' ? `Pendo’s response couldn’t be parsed: ${detail}`
      : `Pendo returned HTTP ${status}`);
    this.name = 'PendoClientError';
  }
}

/** All time: `pollEvents` requires a timeSeries, so a huge negative count of
 *  days back from now() (~274 years), as Pendo's own integrations do. */
export const ALL_TIME_DAYS = -100_000;

/** The aggregation body (the shape verified against the live API). */
export function pollEventsRequest(guideID: string): unknown {
  return {
    response: { mimeType: 'application/json' },
    request: { pipeline: [{ source: { pollEvents: { guideId: guideID }, timeSeries: { period: 'dayRange', first: 'now()', count: ALL_TIME_DAYS } } }] },
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON.parse that, like JSONSerialization, accepts only an object or array at the root. */
function parseJSON(text: string): Json | unknown[] | null {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) || isObject(v) ? v : null;
  } catch { return null; }
}

/** The guide object in whatever envelope Pendo returns: the root object, an
 *  array (matched by id, or its lone entry), or a wrapper like {guide: …}. */
export function guideObject(json: unknown, guideID: string): Json | null {
  if (isObject(json)) {
    if ('id' in json || 'polls' in json) return json;
    for (const key of ['guide', 'result', 'results', 'guides', 'data']) {
      if (key in json) { const match = guideObject(json[key], guideID); if (match) return match; }
    }
    return json; // no recognizable id, but an object: best effort
  }
  if (Array.isArray(json)) {
    const objects = json.filter(isObject);
    return objects.find(o => asString(o.id) === guideID) ?? (objects.length === 1 ? objects[0]! : null);
  }
  return null;
}

/** First 120 bytes of the body, newlines flattened (diagnostics; never the key). */
export function bodyPreview(text: string): string {
  const bytes = new TextEncoder().encode(text);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, 120)).replace(/[\r\n]/g, ' ');
  } catch { return `(not UTF-8, ${bytes.length} bytes)`; }
}

/** A top-level array of rows, or {aggregation|results: […]}. */
export function parseRows(text: string): PendoRow[] | null {
  const json = parseJSON(text);
  const array = Array.isArray(json) ? json
    : isObject(json) ? (Array.isArray(json.aggregation) ? json.aggregation : Array.isArray(json.results) ? json.results : null)
    : null;
  return array ? array.filter(isObject).map(row) : null;
}

export class PendoClient {
  static readonly defaultTimeoutMs = 30_000;
  constructor(private readonly http: HttpClient, private readonly timeoutMs = PendoClient.defaultTimeoutMs) {}

  /** GET /api/v1/guide?id=… (the query-param form; there is no path form). */
  async fetchGuide(config: PendoConfig): Promise<{ name: string; pollMap: PollMap }> {
    const url = `${REGIONS[config.region].baseURL}/api/v1/guide?id=${encodeURIComponent(config.guideID)}`;
    let text: string;
    try {
      text = await this.send(url, { method: 'GET', headers: { 'x-pendo-integration-key': config.apiKey, accept: 'application/json' } });
    } catch (e) {
      // On the guide endpoint a 404 means the guide, not the path.
      if (e instanceof PendoClientError && e.kind === 'http' && e.status === 404) throw new PendoClientError('guideNotFound', config.guideID);
      throw e;
    }
    const json = parseJSON(text);
    if (json === null) throw new PendoClientError('badResponse', `guide response was not JSON — first bytes: ${bodyPreview(text)}`);
    const guide = guideObject(json, config.guideID);
    if (!guide) throw new PendoClientError('guideNotFound', config.guideID);
    const name = typeof guide.name === 'string' && guide.name !== '' ? guide.name : config.guideID;
    return { name, pollMap: pollMapFromGuide(guide) };
  }

  /** POST /api/v1/aggregation with the all-time pollEvents pipeline. */
  async fetchPollResponses(config: PendoConfig): Promise<PendoRow[]> {
    const text = await this.send(`${REGIONS[config.region].baseURL}/api/v1/aggregation`, {
      method: 'POST',
      headers: { 'x-pendo-integration-key': config.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(pollEventsRequest(config.guideID)),
    });
    const rows = parseRows(text);
    if (!rows) throw new PendoClientError('badResponse', 'aggregation result was not a JSON array of rows');
    return rows;
  }

  private async send(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.timeoutMs); });
    let outcome: { status: number; text: string } | 'timeout';
    try {
      outcome = await Promise.race([this.http.fetch(url, { ...init, timeoutMs: this.timeoutMs }), timeout]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw /timed out/i.test(message) ? new PendoClientError('timeout') : new PendoClientError('network', message);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'timeout') throw new PendoClientError('timeout');
    const { status, text } = outcome;
    if (status >= 200 && status <= 299) return text;
    if (status === 401 || status === 403) throw new PendoClientError('unauthorized');
    if (status === 429) throw new PendoClientError('rateLimited');
    throw new PendoClientError('http', '', status);
  }
}
