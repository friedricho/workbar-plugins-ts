// The capture engine (port of the Swift CaptureEngine): CLI tier when Obsidian is running, otherwise the direct
// writer plus the clobber verifier. Every board mutation goes through one FIFO queue, so read-modify-write cycles
// never interleave. Failures are never silent.
import { DEFAULT_TIMEOUT_MS, type ProcessRunner } from './process-runner.js';
import { BoardWriterError, boardFile, CliWriter, DirectFileWriter, WriteVerifier, type CaptureTarget, type WriterTier } from './writers.js';

export interface EngineOptions {
  readonly runner: ProcessRunner;
  /** The text of resources/insert.js (read lazily: a missing file is a typed error at capture time, not a crash at load). */
  readonly insertSource: () => string;
  readonly cliPath: () => string;
  /** Whether the CLI binary exists. A bare name (looked up in PATH) is assumed present: an absent one fails at spawn and falls back. */
  readonly cliExists: (cliPath: string) => boolean;
  readonly isObsidianRunning: () => Promise<boolean>;
  readonly env: () => Record<string, string>;
  readonly verifierDelaysMs?: readonly number[];
  readonly cliTimeoutMs?: number;
  /** The verifier's last check still can't find a direct-written card. Must be surfaced loudly. */
  readonly onGiveUp: (target: CaptureTarget, cardText: string) => void;
}

export class CaptureEngine {
  private readonly direct = new DirectFileWriter();
  private readonly verifier: WriteVerifier;
  private readonly pending = new Set<{ cancel(): void }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: EngineOptions) {
    this.verifier = new WriteVerifier({ direct: this.direct, onGiveUp: o.onGiveUp, ...(o.verifierDelaysMs ? { delaysMs: o.verifierDelaysMs } : {}) });
  }

  /** Captures one card and returns the tier that handled it. */
  capture(text: string, target: CaptureTarget): Promise<WriterTier> {
    if (!target.vaultPath || !target.boardPath || !target.column) return Promise.reject(new BoardWriterError('notConfigured'));
    const run = this.queue.then(() => this.captureNow(text, target));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Cancels any pending verification (the plugin is deactivating). */
  dispose(): void {
    for (const h of this.pending) h.cancel();
    this.pending.clear();
  }

  private async captureNow(text: string, target: CaptureTarget): Promise<WriterTier> {
    // The running check happens BEFORE any spawn, so the CLI can never launch Obsidian as a side effect.
    const cliPath = this.o.cliPath();
    const usable = !cliPath.includes('/') && !cliPath.includes('\\') ? true : this.o.cliExists(cliPath);
    if (usable && (await this.o.isObsidianRunning())) {
      try {
        await new CliWriter({ runner: this.o.runner, cliPath, insertSource: this.o.insertSource(), env: this.o.env(), timeoutMs: this.o.cliTimeoutMs ?? DEFAULT_TIMEOUT_MS }).insert(text, target);
        return 'cli';
      } catch (e) {
        // Only a missing column is loud: never a silent fallback, never an insert into another column. Any other CLI
        // failure falls back to the direct writer below (a missing board then fails there with the same typed error).
        if (e instanceof BoardWriterError && e.kind === 'columnNotFound') throw e;
      }
    }
    await this.direct.insert(text, target);
    const handle = this.verifier.schedule(target, text);
    this.pending.add(handle);
    return 'direct';
  }
}

export { boardFile };
