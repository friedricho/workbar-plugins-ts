// Pure board logic, ported from the Swift BoardParser. No I/O. It mirrors
// resources/insert.js (the same algorithm runs inside Obsidian via
// `obsidian eval`); the golden fixtures are the executable spec for both.
//
// Line model: each line carries its terminator ("\n", "\r\n", or "" for an
// unterminated final line). A lone "\r" not followed by "\n" is ordinary line
// content. JS strings are UTF-16 and "\r\n" is two code units, so splitting on
// "\n" and looking one unit back is exact.

export class ColumnNotFoundError extends Error {
  constructor(readonly column: string) {
    super(`Column not found: ${column}`);
    this.name = 'ColumnNotFoundError';
  }
}

export interface BoardLine { text: string; term: string }
export type InsertionMethod = 'prepend' | 'append';

export function splitLines(content: string): BoardLine[] {
  const lines: BoardLine[] = [];
  let i = 0;
  while (i < content.length) {
    const j = content.indexOf('\n', i);
    if (j === -1) { lines.push({ text: content.slice(i), term: '' }); break; }
    if (j > i && content.charCodeAt(j - 1) === 13) lines.push({ text: content.slice(i, j - 1), term: '\r\n' });
    else lines.push({ text: content.slice(i, j), term: '\n' });
    i = j + 1;
  }
  return lines;
}

export const render = (lines: readonly BoardLine[]): string => lines.map(l => l.text + l.term).join('');

/** What Swift's `trimmingCharacters(in: .whitespacesAndNewlines)` and JS `trim()` both remove (Unicode White_Space + BOM in JS). */
const trim = (s: string): string => s.trim();
const isBlank = (text: string): boolean => trim(text) === '';
const isWs = (ch: string): boolean => /\s/.test(ch);

/** Depth-2 heading title of a line, or null. Needs `##` + whitespace; `###`+ is a deeper heading; trailing `#`s are part of the title. */
export function headingTitle(lineText: string): string | null {
  const t = trim(lineText);
  if (t.length < 3 || t[0] !== '#' || t[1] !== '#' || t[2] === '#' || !isWs(t[2]!)) return null;
  return trim(t.slice(2));
}

/** A section ends at any heading-shaped line, the settings opener, or a bare settings closer. */
export const isSectionEnd = (lineText: string): boolean => {
  const t = trim(lineText);
  return t.startsWith('##') || t.startsWith('%% kanban:settings') || t === '%%';
};

/** The first depth-2 heading whose title equals `column` exactly (case-sensitive), and the section it governs. */
export function locate(column: string, lines: readonly BoardLine[]): { heading: number; end: number } | null {
  const heading = lines.findIndex(l => headingTitle(l.text) === column);
  if (heading < 0) return null;
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) if (isSectionEnd(lines[i]!.text)) { end = i; break; }
  return { heading, end };
}

/** The `%% kanban:settings` JSON object, or null when absent or malformed (fences stripped). */
export function settingsObject(lines: readonly BoardLine[]): Record<string, unknown> | null {
  const start = lines.findIndex(l => trim(l.text).startsWith('%% kanban:settings'));
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const t = trim(line.text);
    if (t === '%%') break;
    if (t.startsWith('```')) continue;
    body.push(line.text);
  }
  try {
    const v: unknown = JSON.parse(body.join('\n'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** "append" appends; anything else (missing, unknown, malformed, no block) prepends: obsidian-kanban's default. */
export const settingsMethod = (lines: readonly BoardLine[]): InsertionMethod =>
  settingsObject(lines)?.['new-card-insertion-method'] === 'append' ? 'append' : 'prepend';

/** Whichever of "\r\n" and "\n" is more common; "\n" on a tie or with no newline at all. */
export function dominantTerminator(content: string): string {
  let crlf = 0; let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 10) continue;
    if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++; else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

/** `- [ ] ` + the first card line; every later line gets two spaces (markdown list continuation). */
export const cardLineTexts = (cardText: string): string[] =>
  cardText.split('\n').map((part, k) => (k === 0 ? '- [ ] ' + part : '  ' + part));

/** Inserts a card into a column and returns the new full file content. Throws ColumnNotFoundError. */
export function insertCard(cardText: string, column: string, content: string): string {
  const lines = splitLines(content);
  const where = locate(column, lines);
  if (!where) throw new ColumnNotFoundError(column);
  const { heading, end } = where;
  const method = settingsMethod(lines);

  // Empty section: right after the heading, skipping ONE following blank line.
  const emptySectionIndex = (): number => (heading + 1 < lines.length && isBlank(lines[heading + 1]!.text) ? heading + 2 : heading + 1);

  let at: number;
  if (method === 'append') {
    let last = -1;
    for (let i = heading + 1; i < end; i++) if (!isBlank(lines[i]!.text)) last = i;
    at = last >= 0 ? last + 1 : emptySectionIndex();
  } else {
    let first = -1;
    for (let i = heading + 1; i < end; i++) if (!isBlank(lines[i]!.text)) { first = i; break; }
    at = first >= 0 ? first : emptySectionIndex();
  }

  // Inserted lines take the terminator of the line before the insert point.
  let term = '\n';
  let finalHasTerm = true;
  if (at >= lines.length) {
    // At EOF: an unterminated last line gains the file's dominant terminator; the new final line gets none.
    const last = lines[lines.length - 1]!;
    if (last.term === '') { term = dominantTerminator(content); last.term = term; finalHasTerm = false; }
    else term = last.term;
  } else if (at > 0) {
    term = lines[at - 1]!.term || '\n';
  }

  const texts = cardLineTexts(cardText);
  const inserted: BoardLine[] = texts.map((text, k) => ({ text, term: k === texts.length - 1 && !finalHasTerm ? '' : term }));
  lines.splice(at, 0, ...inserted);
  return render(lines);
}

/** Depth-2 heading titles in file order (the Column dropdown). */
export const columnNames = (content: string): string[] =>
  splitLines(content).map(l => headingTitle(l.text)).filter((t): t is string => t !== null);

/** Whether the column's section already holds the exact card lines (the clobber verifier's presence check). */
export function containsCard(cardText: string, column: string, content: string): boolean {
  const lines = splitLines(content);
  const where = locate(column, lines);
  if (!where) return false;
  const cards = cardLineTexts(cardText);
  const first = where.heading + 1;
  if (where.end - first < cards.length) return false;
  for (let j = first; j + cards.length <= where.end; j++) {
    if (cards.every((c, k) => lines[j + k]!.text === c)) return true;
  }
  return false;
}
