// Port of PendoModels.swift: regions, config, poll definitions, Pendo's
// flexible timestamps and lenient row accessors. The row and poll shapes
// were never verified against every Pendo version, so everything tolerates
// absence and keeps the raw payload.

export const REGIONS = {
  us: { baseURL: 'https://app.pendo.io', label: 'US (app.pendo.io)' },
  us1: { baseURL: 'https://us1.app.pendo.io', label: 'US1 (us1.app.pendo.io)' },
  eu: { baseURL: 'https://app.eu.pendo.io', label: 'EU (app.eu.pendo.io)' },
  jpn: { baseURL: 'https://app.jpn.pendo.io', label: 'Japan (app.jpn.pendo.io)' },
} as const;
export type PendoRegion = keyof typeof REGIONS;
export const isRegion = (v: unknown): v is PendoRegion => typeof v === 'string' && Object.hasOwn(REGIONS, v);

/** One run's inputs. `apiKey` comes from a host secret and never reaches settings or logs. */
export interface PendoConfig {
  readonly apiKey: string;
  readonly guideID: string;
  readonly region: PendoRegion;
  /** Absolute path of the rolling Markdown report. */
  readonly outputPath: string;
}
export const isComplete = (c: PendoConfig): boolean => c.apiKey !== '' && c.guideID !== '' && c.outputPath !== '';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strings as-is, numbers (and booleans, like NSNumber) as text; anything else is absent. */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return undefined;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface Poll {
  readonly question: string;
  /** choice id → display label */
  readonly choices: Readonly<Record<string, string>>;
}

/** A guide's poll definitions, in the guide's order. */
export interface PollMap {
  readonly polls: ReadonlyMap<string, Poll>;
  readonly orderedIDs: readonly string[];
}
export const emptyPollMap = (): PollMap => ({ polls: new Map(), orderedIDs: [] });
export const pollMap = (entries: ReadonlyArray<readonly [string, Poll]>): PollMap =>
  ({ polls: new Map(entries), orderedIDs: entries.map(([id]) => id) });

/** Builds the map from guide JSON, tolerating `idResponses`/`responses` as an
 *  array of {id|responseId, label|text|value} or an object {id: label | {label|text}}. */
export function pollMapFromGuide(guide: Json): PollMap {
  const polls = new Map<string, Poll>();
  const orderedIDs: string[] = [];
  const raw = Array.isArray(guide.polls) ? guide.polls.filter(isObject) : [];
  for (const poll of raw) {
    const pollID = asString(poll.id);
    if (pollID === undefined) continue;
    const question = str(poll.question) ?? str(poll.title) ?? str(poll.name) ?? '';
    const choices: Record<string, string> = {};
    const source = poll.idResponses ?? poll.responses;
    if (Array.isArray(source)) {
      for (const entry of source.filter(isObject)) {
        const choiceID = asString(entry.id) ?? asString(entry.responseId);
        if (choiceID === undefined) continue;
        choices[choiceID] = str(entry.label) ?? str(entry.text) ?? asString(entry.value) ?? choiceID;
      }
    } else if (isObject(source)) {
      for (const [choiceID, value] of Object.entries(source)) {
        if (typeof value === 'string') choices[choiceID] = value;
        else if (isObject(value)) choices[choiceID] = str(value.label) ?? str(value.text) ?? choiceID;
      }
    }
    if (!polls.has(pollID)) orderedIDs.push(pollID);
    polls.set(pollID, { question, choices });
  }
  return { polls, orderedIDs };
}

// ---- Timestamps ----

/** Seconds between 1970 and 2001: Swift's Date stores seconds since 2001, so
 *  values round-trip through it. Mirroring that keeps fingerprints identical. */
const SWIFT_EPOCH_OFFSET = 978_307_200;
const viaSwiftDate = (secondsSince1970: number) => (secondsSince1970 - SWIFT_EPOCH_OFFSET) + SWIFT_EPOCH_OFFSET;

function fromEpoch(value: number): number | null {
  if (!(value > 0) || !Number.isFinite(value)) return null;
  return viaSwiftDate(value > 1e12 ? value / 1000 : value); // epoch ms or epoch s
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Pendo's flexible timestamps: epoch ms (>1e12), epoch seconds, or ISO 8601.
 *  Returns seconds since 1970, or null when nothing parses. */
export function pendoTimestamp(raw: unknown): number | null {
  if (typeof raw === 'number') return fromEpoch(raw);
  if (typeof raw !== 'string') return null;
  if (NUMERIC.test(raw)) return fromEpoch(Number(raw));
  if (!ISO.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : viaSwiftDate(ms / 1000);
}

// ---- Rows ----

/** One aggregation row, kept raw; accessors tolerate absence. */
export interface PendoRow { readonly raw: Json }
export const row = (raw: Json): PendoRow => ({ raw });
export const pollID = (r: PendoRow) => asString(r.raw.pollId);
export const pollResponse = (r: PendoRow) => asString(r.raw.pollResponse);
export const visitorID = (r: PendoRow) => asString(r.raw.visitorId) ?? asString(r.raw.visitorid);
export const accountID = (r: PendoRow) => asString(r.raw.accountId);
export const browserTime = (r: PendoRow) => pendoTimestamp(r.raw.browserTime);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "MMM d, h:mm a" in local time (menu and status lines). */
export function formatStatusTime(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${((d.getHours() + 11) % 12) + 1}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
