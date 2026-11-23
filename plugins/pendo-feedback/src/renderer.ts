// Port of PendoReportRenderer.swift: a pure Markdown report, deterministic
// given `now` (and an optional time zone, for tests). Tolerance contract:
// missing fields render as —, rows are never dropped, unlabelled choice ids
// say so, cell text is table-safe, zero-response polls still appear, and
// rows sort newest first with time-less rows last.
import { accountID, browserTime, pollID, pollResponse, visitorID, type PendoRegion, type PendoRow, type PollMap } from './model.js';

const NO_POLL = '(no poll id)';

/** "yyyy-MM-dd HH:mm", local time unless a time zone is given. */
function formatWhen(d: Date, timeZone?: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const flatten = (text: string) => text.replace(/\|/g, '\\|').replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
const cell = (value: string | undefined) => (value ? flatten(value) : '—');

/** The display text for a row's response: the choice label; the raw text for
 *  a free-form poll (no choices defined); an unmapped marker for an unknown
 *  choice id; — when the row has no response. */
export function responseText(r: PendoRow, map: PollMap): string {
  const response = pollResponse(r);
  if (!response) return '—';
  const poll = map.polls.get(pollID(r) ?? '');
  if (!poll) return `Choice id \`${response}\` (unmapped)`;
  if (Object.hasOwn(poll.choices, response)) return poll.choices[response]!;
  if (Object.keys(poll.choices).length === 0) return response; // free-form poll
  return `Choice id \`${response}\` (unmapped)`;
}

/** The poll's question, or "Poll {id}". */
export function headingTitle(id: string, map: PollMap): string {
  const q = map.polls.get(id)?.question;
  return q ? q : `Poll ${id}`;
}

/** Newest first; rows without a time last; stable otherwise. */
export function sortedRows(rows: readonly PendoRow[]): PendoRow[] {
  return rows.map((r, i) => ({ r, i, t: browserTime(r) })).sort((a, b) => {
    if (a.t !== null && b.t !== null && a.t !== b.t) return b.t - a.t;
    if (a.t === null && b.t !== null) return 1;
    if (a.t !== null && b.t === null) return -1;
    return a.i - b.i;
  }).map(x => x.r);
}

export interface RenderInput {
  readonly guideName: string;
  readonly guideID: string;
  readonly region: PendoRegion;
  readonly rows: readonly PendoRow[];
  readonly pollMap: PollMap;
  readonly now?: Date;
  readonly timeZone?: string;
}

export function renderReport(o: RenderInput): string {
  const { rows, pollMap: map } = o;
  const when = (d: Date) => formatWhen(d, o.timeZone);
  const groups = new Map<string, PendoRow[]>();
  for (const r of rows) { const id = pollID(r) ?? NO_POLL; groups.set(id, [...(groups.get(id) ?? []), r]); }
  // The guide's poll order, then row-only poll ids in first-seen order.
  const ordered = [...map.orderedIDs];
  const seen = new Set(ordered);
  for (const r of rows) { const id = pollID(r) ?? NO_POLL; if (!seen.has(id)) { seen.add(id); ordered.push(id); } }
  const visitors = new Set(rows.map(visitorID).filter((v): v is string => v !== undefined)).size;

  const lines = [
    `# Pendo Feedback — ${flatten(o.guideName)}`,
    '',
    `_Generated ${when(o.now ?? new Date())} · window: all time · guide \`${o.guideID}\` · region ${o.region}_`,
    '',
    '## Summary',
    '',
    rows.length === 0 ? '- No poll responses.' : `- **${map.polls.size}** poll(s), **${rows.length}** response(s) from **${visitors}** visitor(s), all time.`,
    '',
  ];
  for (const id of ordered) {
    const group = groups.get(id) ?? [];
    if (group.length === 0 && !map.polls.has(id)) continue;
    lines.push(`### ${flatten(headingTitle(id, map))}`, '');
    if (group.length === 0) { lines.push('- (no responses)', ''); continue; }
    const counts = new Map<string, number>();
    for (const r of group) { const t = responseText(r, map); counts.set(t, (counts.get(t) ?? 0) + 1); }
    const sorted = [...counts].sort(([ka, a], [kb, b]) => (a !== b ? b - a : ka < kb ? -1 : ka > kb ? 1 : 0));
    for (const [text, count] of sorted) lines.push(`- **${flatten(text)}** — ${count} response(s)`);
    lines.push('');
  }
  for (const id of ordered) {
    const group = groups.get(id);
    if (!group?.length) continue;
    lines.push(`## Responses — ${flatten(headingTitle(id, map))}`, '', '| When | Visitor | Account | Response |', '| --- | --- | --- | --- |');
    for (const r of sortedRows(group)) {
      const t = browserTime(r);
      lines.push(`| ${cell(t === null ? undefined : when(new Date(t * 1000)))} | ${cell(visitorID(r))} | ${cell(accountID(r))} | ${cell(responseText(r, map))} |`);
    }
    lines.push('');
  }
  let text = lines.join('\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return `${text}\n`;
}
