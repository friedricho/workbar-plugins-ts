// The three ways a card reaches the board (ported from the Swift BoardWriter.swift):
//   CliWriter        Obsidian is running → `obsidian eval` runs insert.js inside Obsidian (app.vault.process).
//   DirectFileWriter Obsidian is not running → read, insert, atomic write.
//   WriteVerifier    after a direct write, re-checks at +1/+3/+6 s: Obsidian's debounced save can clobber the card.
// Nothing here is ever silent about a failure: every error is typed and reaches the user.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ColumnNotFoundError, containsCard, insertCard } from './board.js';
import { DEFAULT_TIMEOUT_MS, type ProcessRunner } from './process-runner.js';
import { writeTextAtomic, WriteError } from '../../../shared/atomic-write.js';

export interface CaptureTarget { readonly vaultPath: string; readonly boardPath: string; readonly column: string }
export type WriterTier = 'cli' | 'direct';

export type BoardWriterKind = 'notConfigured' | 'boardNotFound' | 'columnNotFound' | 'obsidianCLIFailed' | 'writeFailed';

/** Errors surfaced to the capture bar; the messages are user-facing. */
export class BoardWriterError extends Error {
  constructor(readonly kind: BoardWriterKind, readonly detail = '') {
    super(describe(kind, detail));
    this.name = 'BoardWriterError';
  }
}

function describe(kind: BoardWriterKind, detail: string): string {
  switch (kind) {
    case 'notConfigured': return 'Quick Capture isn’t configured yet — choose a vault, board and column in Settings.';
    case 'boardNotFound': return `Board not found at ${detail}`;
    case 'columnNotFound': return `The “${detail}” column no longer exists on this board — it may have been renamed.`;
    case 'obsidianCLIFailed': return `Obsidian CLI failed: ${detail}`;
    case 'writeFailed': return `Couldn’t save the board: ${detail}`;
  }
}

export const boardFile = (t: CaptureTarget): string => path.join(t.vaultPath, t.boardPath);

const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

/** A JSON string literal (valid JavaScript), with U+2028/U+2029 escaped for JS safety. */
export function jsString(s: string): string {
  return JSON.stringify(s).replace(/[\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** insert.js followed by the invocation, with every dynamic value JSON-encoded. */
export function buildEvalProgram(insertSource: string, boardPath: string, column: string, cardText: string): string {
  const board = jsString(boardPath);
  return `${insertSource}
;
(async () => {
  const f = app.vault.getAbstractFileByPath(${board});
  if (!f) throw new Error("QC board not found: " + ${board});
  await app.vault.process(f, d => qc_insert(d, ${jsString(column)}, ${jsString(cardText)}));
  return "QC_OK";
})();`;
}

const tail = (text: string, limit = 400): string => (text.length <= limit ? text : '…' + text.slice(-limit));

// ---------------------------------------------------------------- CLI tier

export interface CliWriterOptions {
  readonly runner: ProcessRunner;
  readonly cliPath: string;
  /** The contents of resources/insert.js. */
  readonly insertSource: string;
  readonly env: Record<string, string>;
  readonly timeoutMs?: number;
}

export class CliWriter {
  constructor(private readonly o: CliWriterOptions) {}

  async insert(cardText: string, target: CaptureTarget): Promise<void> {
    // File check with the absolute path before spawning anything.
    const file = boardFile(target);
    if (!(await exists(file))) throw new BoardWriterError('boardNotFound', file);
    if (!this.o.insertSource) throw new BoardWriterError('obsidianCLIFailed', 'insert.js is missing from the plugin');

    const timeoutMs = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    let outcome: Awaited<ReturnType<ProcessRunner['run']>> | 'timeout';
    try {
      // `obsidian eval code=<js>`: the value is ONE argument.
      outcome = await Promise.race([
        this.o.runner.run(this.o.cliPath, ['eval', 'code=' + buildEvalProgram(this.o.insertSource, target.boardPath, target.column, cardText)], this.o.env, timeoutMs),
        timeout,
      ]);
    } catch (e) {
      throw new BoardWriterError('obsidianCLIFailed', `could not run obsidian CLI: ${e instanceof Error ? e.message : String(e)}`);
    } finally { clearTimeout(timer); }
    if (outcome === 'timeout') throw new BoardWriterError('obsidianCLIFailed', `obsidian eval did not answer within ${timeoutMs / 1000}s`);

    // JS-side column-not-found surfaces as an error string in the output.
    if ((outcome.stdout + '\n' + outcome.stderr).includes('QC column not found')) throw new BoardWriterError('columnNotFound', target.column);
    if (outcome.exitCode === 0 && outcome.stdout.includes('QC_OK')) return;
    let detail = `${this.o.cliPath} exited with status ${outcome.exitCode}.`;
    if (outcome.stderr) detail += ' stderr: ' + tail(outcome.stderr);
    if (outcome.stdout) detail += ' stdout: ' + tail(outcome.stdout);
    throw new BoardWriterError('obsidianCLIFailed', detail);
  }
}

// ---------------------------------------------------------------- direct tier

/** Read → insert → atomic write (temp file beside the board with a non-.md name, then rename over it: no partial
 *  writes, the original permissions kept). All read-modify-write cycles of one writer run one at a time, so a
 *  verifier's re-insert can never interleave with a capture. */
export class DirectFileWriter {
  private tail: Promise<unknown> = Promise.resolve();

  insert(cardText: string, target: CaptureTarget): Promise<void> {
    const run = this.tail.then(() => performInsert(cardText, target));
    this.tail = run.catch(() => {}); // a failure must not poison the queue
    return run;
  }
}

async function performInsert(cardText: string, target: CaptureTarget): Promise<void> {
  const file = boardFile(target);
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new BoardWriterError('boardNotFound', file);
    throw new BoardWriterError('writeFailed', `cannot read ${file}: ${(e as Error).message}`);
  }
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new BoardWriterError('writeFailed', `cannot read board as UTF-8: ${file}`); }

  let next: string;
  try { next = insertCard(cardText, target.column, content); }
  catch (e) {
    if (e instanceof ColumnNotFoundError) throw new BoardWriterError('columnNotFound', e.column);
    throw e;
  }
  try { await writeTextAtomic(file, next, 'quickcapture'); }
  catch (e) { throw new BoardWriterError('writeFailed', e instanceof WriteError ? e.message.replace(/^Couldn’t write the note: /, '') : (e as Error).message); }
}

// ---------------------------------------------------------------- verifier

export interface WriteVerifierOptions {
  readonly direct: DirectFileWriter;
  /** Called exactly once, and only if the card is still absent after the final check. Never silent. */
  readonly onGiveUp: (target: CaptureTarget, cardText: string) => void;
  readonly delaysMs?: readonly number[];
}

/** Re-reads the board at +1/+3/+6 s (offsets from the write). If Obsidian's debounced save clobbered the card, it
 *  re-inserts it. It checks before every insert, so a card that is already there is never double-inserted. */
export class WriteVerifier {
  static readonly defaultDelaysMs: readonly number[] = [1000, 3000, 6000];
  private readonly delays: readonly number[];

  constructor(private readonly o: WriteVerifierOptions) { this.delays = o.delaysMs ?? WriteVerifier.defaultDelaysMs; }

  /** Fire-and-forget: returns at once, never blocks the capture. */
  schedule(target: CaptureTarget, cardText: string): { cancel(): void } {
    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    const delays = this.delays;
    if (delays.length === 0) return { cancel() {} };
    const start = Date.now();

    const check = async (index: number): Promise<void> => {
      if (cancelled) return;
      let content = '';
      try { content = await fs.readFile(boardFile(target), 'utf8'); } catch { content = ''; } // unreadable counts as "card absent"
      if (cancelled) return;
      if (containsCard(cardText, target.column, content)) return; // confirmed: done
      if (index === delays.length - 1) { this.o.onGiveUp(target, cardText); return; } // final check failed: loud, exactly once
      try { await this.o.direct.insert(cardText, target); } catch { /* clobbered and not recoverable yet: the next check decides */ }
      next(index + 1);
    };
    const next = (index: number): void => {
      if (cancelled || index >= delays.length) return;
      timer = setTimeout(() => { void check(index); }, Math.max(0, start + delays[index]! - Date.now()));
    };
    next(0);
    return { cancel() { cancelled = true; if (timer) clearTimeout(timer); } };
  }
}
