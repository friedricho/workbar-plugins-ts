// Runs an external program and returns its exit code and output (port of the Swift ProcessRunner). Plugins may spawn
// ordinary programs with node:child_process; a hung CLI must never hang a capture, so every run has a timeout that
// kills the child. A non-zero exit is a RESULT (the caller decides what it means); only a failure to launch, or a
// timeout, is an error. execFile, never a shell: arguments reach the program whole, whatever they contain.
import { execFile } from 'node:child_process';

export interface RunResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

export interface ProcessRunner {
  run(exe: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult>;
}

export class RunnerError extends Error {
  constructor(readonly kind: 'launchFailed' | 'timedOut', detail: string) {
    super(kind === 'launchFailed' ? `failed to launch process: ${detail}` : detail);
    this.name = 'RunnerError';
  }
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export const nodeProcessRunner: ProcessRunner = {
  run: (exe, args, env, timeoutMs) => new Promise<RunResult>((resolve, reject) => {
    execFile(exe, [...args], { env, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stdout, stderr });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (e.killed || e.signal === 'SIGKILL') return reject(new RunnerError('timedOut', `${exe} did not finish within ${timeoutMs / 1000}s and was terminated`));
      if (typeof e.code === 'number') return resolve({ exitCode: e.code, stdout, stderr }); // ran, and exited non-zero
      reject(new RunnerError('launchFailed', `${exe}: ${e.message}`)); // ENOENT, EACCES, …
    });
  }),
};
