// Ported from PollMapTests, PendoClientTests, PendoReportRendererTests,
// PendoReportWriterTests and PendoStoreTests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyPollMap, pollMap, pollMapFromGuide, row, accountID, browserTime, pollID, pollResponse, visitorID, type PendoConfig, type PendoRegion } from '../src/model.js';
import { ALL_TIME_DAYS, PendoClient, PendoClientError, pollEventsRequest } from '../src/client.js';
import { renderReport } from '../src/renderer.js';
import { fingerprint, MIGRATIONS, PendoStore } from '../src/store.js';
import { WriteError, writeTextAtomic } from '../../../shared/atomic-write.js';
import { fakeHttp, fixture, fixtureJSON, openTestDb } from './support.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pendo-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('poll map', () => {
  it('idResponses as an array of {id, label|text|value} entries', () => {
    const map = pollMapFromGuide(fixtureJSON('guide-idresponses-array'));
    expect(map.orderedIDs).toEqual(['p1', 'p2']);
    expect(map.polls.get('p1')).toEqual({ question: 'How useful?', choices: { c1: 'Very useful', c2: 'Somewhat' } });
    expect(map.polls.get('p2')).toEqual({ question: 'Second poll', choices: { x: 'Yes', y: 'No' } });
  });
  it('responses/idResponses as objects (nested label objects tolerated)', () => {
    const map = pollMapFromGuide(fixtureJSON('guide-responses-object'));
    expect(map.orderedIDs).toEqual(['p1', 'p2', 'p3']);
    expect(map.polls.get('p1')!.choices).toEqual({ c1: 'First', c2: 'Second' });
    expect(map.polls.get('p2')!.choices).toEqual({ c1: 'Nested label', c2: 'Other label' });
    expect(map.polls.get('p3')!.choices).toEqual({});
  });
  it('a guide without a polls key builds an empty map, not an error', () => {
    const map = pollMapFromGuide(fixtureJSON('guide-no-polls'));
    expect(map.polls.size).toBe(0);
    expect(map.orderedIDs).toEqual([]);
  });
  it('numeric ids coerce to strings (question via name, numeric choice ids)', () => {
    const map = pollMapFromGuide(fixtureJSON('guide-numeric-ids'));
    expect(map.orderedIDs).toEqual(['12345', 'p2']);
    expect(map.polls.get('12345')).toEqual({ question: 'Numeric poll id', choices: { c1: 'Choice' } });
    expect(map.polls.get('p2')).toEqual({ question: 'Name-only question', choices: { 9: 'Numeric choice' } });
  });
});

const config = (o: { region?: PendoRegion; guideID?: string; apiKey?: string } = {}): PendoConfig =>
  ({ apiKey: o.apiKey ?? 'test-key', guideID: o.guideID ?? 'g1', region: o.region ?? 'us', outputPath: '/tmp/report.md' });

describe('client', () => {
  it('the aggregation body is the exact verified pipeline', () => {
    expect(pollEventsRequest('g1')).toEqual({
      response: { mimeType: 'application/json' },
      request: { pipeline: [{ source: { pollEvents: { guideId: 'g1' }, timeSeries: { period: 'dayRange', first: 'now()', count: ALL_TIME_DAYS } } }] },
    });
  });
  it('count is the all-time constant (negative: back from now())', () => {
    expect(ALL_TIME_DAYS).toBe(-100_000);
  });
  it('guide fetch uses the query-param form with the auth header', async () => {
    const http = fakeHttp({ handler: () => [200, '{}'] });
    await new PendoClient(http).fetchGuide(config({ guideID: 'my-guide' }));
    expect(http.calls[0]).toMatchObject({ url: 'https://app.pendo.io/api/v1/guide?id=my-guide', method: 'GET', headers: { 'x-pendo-integration-key': 'test-key' } });
  });
  it('guide fetch maps to every region host', async () => {
    for (const [region, host] of [['us', 'app.pendo.io'], ['us1', 'us1.app.pendo.io'], ['eu', 'app.eu.pendo.io'], ['jpn', 'app.jpn.pendo.io']] as const) {
      const http = fakeHttp({ handler: () => [200, '{}'] });
      await new PendoClient(http).fetchGuide(config({ region }));
      const url = new URL(http.calls[0]!.url);
      expect([url.protocol, url.host]).toEqual(['https:', host]);
    }
  });
  it('the guide name falls back to the guide ID when absent or empty', async () => {
    for (const [body, expected] of [['{"id": "g1"}', 'g1'], ['{"name": ""}', 'g1'], ['{"name": "Guide One"}', 'Guide One']]) {
      const { name, pollMap: map } = await new PendoClient(fakeHttp({ handler: () => [200, body!] })).fetchGuide(config());
      expect(name).toBe(expected);
      expect(map.polls.size).toBe(0);
    }
  });
  it('guide 404 maps to guideNotFound', async () => {
    await expect(new PendoClient(fakeHttp({ handler: () => [404, '{"error": "not found"}'] })).fetchGuide(config()))
      .rejects.toMatchObject({ kind: 'guideNotFound', message: 'Guide g1 not found — check the guide ID' });
  });
  it('the guide response tolerates an array root, matching by id', async () => {
    const body = `[{"id": "other", "name": "Not It"},
      {"id": "g1", "name": "Real Guide", "polls": [{"id": "p1", "question": "Q?", "idResponses": [{"id": "c1", "label": "Yes"}]}]}]`;
    const { name, pollMap: map } = await new PendoClient(fakeHttp({ handler: () => [200, body] })).fetchGuide(config());
    expect(name).toBe('Real Guide');
    expect(map.polls.get('p1')!.choices.c1).toBe('Yes');
  });
  it('a lone guide object in an array is accepted without a matching id', async () => {
    expect((await new PendoClient(fakeHttp({ handler: () => [200, '[{"name": "Solo"}]'] })).fetchGuide(config())).name).toBe('Solo');
  });
  it('empty or unmatched guide arrays map to guideNotFound', async () => {
    for (const body of ['[]', '[{"id": "a"}, {"id": "b"}]']) {
      await expect(new PendoClient(fakeHttp({ handler: () => [200, body] })).fetchGuide(config())).rejects.toMatchObject({ kind: 'guideNotFound' });
    }
  });
  it('the guide response tolerates envelope wrappers like {guide: …}', async () => {
    const body = '{"guide": {"id": "g1", "name": "Wrapped", "polls": [{"id": "p1", "question": "Q?", "idResponses": []}]}}';
    const { name, pollMap: map } = await new PendoClient(fakeHttp({ handler: () => [200, body] })).fetchGuide(config());
    expect(name).toBe('Wrapped');
    expect(map.orderedIDs).toEqual(['p1']);
  });
  it('a non-JSON guide body includes a body preview in the error', async () => {
    await expect(new PendoClient(fakeHttp({ handler: () => [200, '<html>Bad Gateway</html>\n'] })).fetchGuide(config()))
      .rejects.toMatchObject({ kind: 'badResponse', message: 'Pendo’s response couldn’t be parsed: guide response was not JSON — first bytes: <html>Bad Gateway</html> ' });
  });
  it('the aggregation posts the pipeline with the auth header', async () => {
    const http = fakeHttp();
    await new PendoClient(http).fetchPollResponses(config());
    const call = http.calls[0]!;
    expect(call).toMatchObject({ url: 'https://app.pendo.io/api/v1/aggregation', method: 'POST', headers: { 'x-pendo-integration-key': 'test-key', 'content-type': 'application/json' } });
    expect(call.body).toContain('"guideId":"g1"');
    expect(call.body).toContain(`"count":${ALL_TIME_DAYS}`);
  });
  it('parses a top-level array of rows with lenient fields', async () => {
    const body = `[
      {"pollId": "p1", "pollResponse": "c1", "visitorId": "v-abc", "accountId": "acct-1", "browserTime": "2026-11-11T09:14:00Z"},
      {"pollId": "p1", "pollResponse": 42, "visitorId": 98765, "browserTime": 1794389040000, "extraKey": {"nested": 1}},
      {"visitorId": "v-no-response"}]`;
    const rows = await new PendoClient(fakeHttp({ handler: () => [200, body] })).fetchPollResponses(config());
    expect(rows).toHaveLength(3);
    expect([pollID(rows[0]!), pollResponse(rows[0]!), visitorID(rows[0]!), accountID(rows[0]!)]).toEqual(['p1', 'c1', 'v-abc', 'acct-1']);
    expect([pollResponse(rows[1]!), visitorID(rows[1]!)]).toEqual(['42', '98765']);
    expect(browserTime(rows[1]!)).not.toBeNull();
    expect([pollID(rows[2]!), pollResponse(rows[2]!), browserTime(rows[2]!)]).toEqual([undefined, undefined, null]);
  });
  it('parses envelope shapes: {aggregation: […]} and {results: […]}', async () => {
    for (const body of ['{"aggregation": [{"pollId": "p1"}]}', '{"results": [{"pollId": "p1"}]}']) {
      expect(await new PendoClient(fakeHttp({ handler: () => [200, body] })).fetchPollResponses(config())).toHaveLength(1);
    }
  });
  it('a non-JSON body maps to badResponse', async () => {
    await expect(new PendoClient(fakeHttp({ handler: () => [200, '<html>nope</html>'] })).fetchPollResponses(config()))
      .rejects.toMatchObject({ kind: 'badResponse', detail: 'aggregation result was not a JSON array of rows' });
  });
  it('401/403 → unauthorized, 429 → rateLimited, others → http', async () => {
    const at = (status: number) => new PendoClient(fakeHttp({ handler: () => [status, '[]'] })).fetchPollResponses(config());
    await expect(at(401)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(at(403)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(at(429)).rejects.toMatchObject({ kind: 'rateLimited' });
    await expect(at(500)).rejects.toMatchObject({ kind: 'http', status: 500, message: 'Pendo returned HTTP 500' });
  });
  it('error descriptions never embed the API key', () => {
    const errors = [new PendoClientError('unauthorized'), new PendoClientError('guideNotFound', 'g1'), new PendoClientError('rateLimited'),
      new PendoClientError('network', 'connection refused'), new PendoClientError('timeout'), new PendoClientError('badResponse', 'not JSON'), new PendoClientError('http', '', 502)];
    for (const e of errors) expect(e.message).not.toContain('canary-integration-key');
  });
  it('a slow transport loses to the timeout race', async () => {
    await expect(new PendoClient(fakeHttp({ delayMs: 2000 }), 50).fetchPollResponses(config())).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('a transport error maps to network', async () => {
    await expect(new PendoClient(fakeHttp({ error: new Error('boom') })).fetchPollResponses(config())).rejects.toMatchObject({ kind: 'network', message: 'Pendo unreachable: boom' });
  });
});

describe('report renderer', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  const map = (p1: Record<string, string>, p2: Record<string, string>) =>
    pollMap([['p1', { question: 'How useful is Autopilot?', choices: p1 }], ['p2', { question: 'What should we improve?', choices: p2 }]]);
  const render = (rows: ReturnType<typeof row>[], m = map({}, {}), guideName = 'Guide', guideID = 'g1') =>
    renderReport({ guideName, guideID, region: 'us', rows, pollMap: m, now, timeZone: 'UTC' });

  it('the full report renders byte-identical to the golden fixture', () => {
    const rows = [
      row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', accountId: 'acct-1', browserTime: '2026-11-11T09:14:00Z' }),
      row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-def', accountId: 'acct-1', browserTime: '2026-11-10T18:02:00Z' }),
      row({ pollId: 'p1', pollResponse: 'c3', visitorId: 'visitor-abc', accountId: 'acct-2', browserTime: '2026-11-11T08:00:00Z' }),
      row({ pollId: 'p2', pollResponse: 'free-text-id', visitorId: 'visitor-ghi', accountId: 'acct-1', browserTime: '2026-11-09T10:00:00Z' }),
    ];
    expect(render(rows, map({ c1: 'Very useful', c2: 'Somewhat', c3: 'Not really' }, {}), 'Autopilot Early Access Guide', 'NphrKZID')).toBe(fixture('report-full.expected.md'));
  });
  it('edge cases: escaping, missing fields, unmapped ids, zero-response polls, sorting', () => {
    const edge = pollMap([['p1', { question: 'What should we improve?', choices: { c1: 'Pipe | label' } }], ['p9', { question: 'Zero-response poll', choices: {} }]]);
    const rows = [
      row({ pollId: 'p1', pollResponse: 'c1' }),
      row({ pollId: 'p1', pollResponse: 'unmapped-xyz' }),
      row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'v1', browserTime: 1_794_388_440_000 }),
    ];
    expect(render(rows, edge, 'Autopilot Early Access Guide', 'NphrKZID')).toBe(fixture('report-edge.expected.md'));
  });
  it('empty rows still render the summary with a no-responses note', () => {
    const out = render([], map({ c1: 'Only choice' }, {}));
    expect(out).toContain('- No poll responses.');
    expect(out).toContain('### What should we improve?');
    expect(out).toContain('- (no responses)');
    expect(out).not.toContain('## Responses');
  });
  it('rows for a poll missing from the guide metadata get their own section', () => {
    const out = render([row({ pollId: 'mystery', pollResponse: 'r1', visitorId: 'v1' })], emptyPollMap());
    expect(out).toContain('### Poll mystery');
    expect(out).toContain('## Responses — Poll mystery');
    expect(out).toContain('Choice id `r1` (unmapped)');
    expect(out).toContain('**0** poll(s), **1** response(s)');
  });
  it('newlines in values collapse so table rows never break', () => {
    const out = render([row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'line1\nline2' })], pollMap([['p1', { question: 'Q', choices: { c1: 'Multi\nline label' } }]]));
    const table = out.split('\n').filter(l => l.startsWith('|'));
    expect(table).toHaveLength(3);
    expect(table[2]).toContain('line1 line2');
    expect(table[2]).toContain('Multi line label');
  });
});

describe('report writer (shared/atomic-write)', () => {
  it('creates a new report with the exact content, then overwrites it', async () => {
    const file = path.join(tmp, 'Pendo Feedback.md');
    await writeTextAtomic(file, '# Report\n\nbody', 'pendofeedback');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Report\n\nbody');
    await writeTextAtomic(file, 'second', 'pendofeedback');
    expect(fs.readFileSync(file, 'utf8')).toBe('second');
  });
  it.skipIf(process.platform === 'win32')('overwriting keeps the file’s permissions', async () => {
    const file = path.join(tmp, 'report.md');
    await writeTextAtomic(file, 'first', 'pendofeedback');
    fs.chmodSync(file, 0o600);
    await writeTextAtomic(file, 'second', 'pendofeedback');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  it('no temp file is left behind on success', async () => {
    await writeTextAtomic(path.join(tmp, 'report.md'), 'content', 'pendofeedback');
    expect(fs.readdirSync(tmp)).toEqual(['report.md']);
  });
  it('a missing folder is created (the shared writer; Swift failed here), a blocked path throws a typed error', async () => {
    await writeTextAtomic(path.join(tmp, 'nope', 'report.md'), 'content', 'pendofeedback');
    expect(fs.readFileSync(path.join(tmp, 'nope', 'report.md'), 'utf8')).toBe('content');
    fs.writeFileSync(path.join(tmp, 'file'), '');
    await expect(writeTextAtomic(path.join(tmp, 'file', 'report.md'), 'x', 'pendofeedback')).rejects.toBeInstanceOf(WriteError);
  });
});

describe('store', () => {
  const stampA = new Date(1_769_000_000_000);
  const stampB = new Date(1_769_086_400_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pollsFor = (question = 'How useful is Autopilot?', choices: Record<string, string> = { c1: 'Very useful', c2: 'Somewhat' }) => pollMap([['p1', { question, choices }]]);
  const setup = () => { const db = openTestDb(MIGRATIONS); return { db, store: new PendoStore(db) }; };

  it('record stores responses with mapped text, raw ids and ISO time', async () => {
    const { db, store } = setup();
    const rows = [row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', accountId: 'acct-1', browserTime: '2026-11-11T09:14:00Z' })];
    expect(await store.record('g1', rows, pollsFor(), stampA)).toBe(1);
    expect(await store.responseCount()).toBe(1);
    expect(await db.all('SELECT poll_id, poll_response, response_text, visitor_id, account_id, browser_time, first_seen_at FROM responses')).toEqual([{
      poll_id: 'p1', poll_response: 'c1', response_text: 'Very useful', visitor_id: 'visitor-abc', account_id: 'acct-1', browser_time: '2026-11-11T09:14:00Z', first_seen_at: iso(stampA),
    }]);
    expect(await store.pollCount('g1')).toBe(1);
    expect(await db.all('SELECT question, choices_json FROM polls')).toEqual([{ question: 'How useful is Autopilot?', choices_json: '{"c1":"Very useful","c2":"Somewhat"}' }]);
  });
  it('re-recording the same rows dedups on the fingerprint (first write wins)', async () => {
    const { db, store } = setup();
    const rows = [row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', browserTime: 1_794_388_440_000 })];
    expect(await store.record('g1', rows, pollsFor(), stampA)).toBe(1);
    expect(await store.record('g1', rows, pollsFor(), stampB)).toBe(0);
    expect(await store.responseCount()).toBe(1);
    expect(await db.all('SELECT first_seen_at, last_seen_at, browser_time FROM responses')).toEqual([{ first_seen_at: iso(stampA), last_seen_at: iso(stampA), browser_time: '2026-11-11T09:14:00Z' }]);
  });
  it('any differing key field is a new response; guides don’t collide', async () => {
    const { db, store } = setup();
    const base = { pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', browserTime: 1_794_388_440_000 };
    await store.record('g1', [row(base), row({ ...base, browserTime: 1_794_388_440_001 })], pollsFor(), stampA);
    expect(await store.responseCount()).toBe(2);
    expect(await store.record('g2', [row(base)], pollsFor(), stampA)).toBe(1);
    expect(await store.responseCount()).toBe(3);
    expect(await db.all('SELECT guide_id, COUNT(*) AS n FROM responses GROUP BY guide_id ORDER BY guide_id')).toEqual([{ guide_id: 'g1', n: 2 }, { guide_id: 'g2', n: 1 }]);
  });
  it('poll definitions refresh every run while first_seen survives', async () => {
    const { db, store } = setup();
    const r = row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'v1', browserTime: 1_794_388_440_000 });
    await store.record('g1', [r], pollsFor(), stampA);
    expect(await store.record('g1', [r], pollsFor('How useful is Autopilot now?', { c1: 'Very useful', c2: 'Somewhat', c3: 'Not at all' }), stampB)).toBe(0);
    expect(await db.all('SELECT question, choices_json, first_seen_at, last_seen_at FROM polls')).toEqual([{
      question: 'How useful is Autopilot now?', choices_json: '{"c1":"Very useful","c2":"Somewhat","c3":"Not at all"}', first_seen_at: iso(stampA), last_seen_at: iso(stampB),
    }]);
    expect(await db.all('SELECT response_text FROM responses')).toEqual([{ response_text: 'Very useful' }]);
  });
  it('rows with missing fields are stored, never dropped', async () => {
    const { db, store } = setup();
    const r = row({ pollId: 'p9', pollResponse: 'c1' });
    expect(await store.record('g1', [r], emptyPollMap(), stampA)).toBe(1);
    expect(await db.all('SELECT poll_id, poll_response, response_text, visitor_id, account_id, browser_time, raw_json FROM responses')).toEqual([{
      poll_id: 'p9', poll_response: 'c1', response_text: 'Choice id `c1` (unmapped)', visitor_id: '', account_id: '', browser_time: null, raw_json: '{"pollId":"p9","pollResponse":"c1"}',
    }]);
    expect(await store.record('g1', [r], emptyPollMap(), stampB)).toBe(0);
    expect(await store.responseCount()).toBe(1);
  });
  it('fingerprints match the Swift basis byte for byte', () => {
    // printf 'g1\x1fp1\x1fc1\x1fvisitor-abc\x1facct-1\x1f1794388440000' | sha256sum
    const expected = 'dec029b9fcd79b16fd74f8753041b14ff73b6c4f8ac13f83a00d1740f8877a62';
    expect(fingerprint('g1', row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', accountId: 'acct-1', browserTime: '2026-11-11T09:14:00Z' }))).toBe(expected);
    expect(fingerprint('g1', row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', accountId: 'acct-1', browserTime: 1_794_388_440_000 }))).toBe(expected);
    expect(fingerprint('g1', row({ pollId: 'p1', pollResponse: 'c1', visitorId: 'visitor-abc', accountId: 'acct-1', browserTime: '1794388440' }))).toBe(expected);
    // printf 'g1\x1fp9\x1fc1\x1f\x1f\x1f' | sha256sum (no visitor, account or time)
    expect(fingerprint('g1', row({ pollId: 'p9', pollResponse: 'c1' }))).toBe('6ee5abf6dcbe0e75ac84a7b5cc435ab88352729d9d56e52d096da7aa3ab2a1da');
  });
});
