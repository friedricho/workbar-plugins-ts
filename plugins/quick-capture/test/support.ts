// Test helpers: temp folders, the Swift repo's board strings, and a recording fake process runner.
// SAFETY: nothing here (or in any test) may reach the real Obsidian CLI. It evaluates code inside the user's real
// vault. The CLI path is always injected; stubs are shell/node scripts in a temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { ProcessRunner, RunResult } from '../src/process-runner.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

export function tempDir(label = 'qc'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `qc-tests-${label}-`));
  dirs.push(d);
  return d;
}

/** Minimal prepend board (no settings block → default prepend). */
export const simpleBoard = '## Backlog\n\n- [ ] Backlog card\n\n## Today\n\n- [ ] Read a doc\n\n## Done\n\n- [ ] Old';
/** CRLF board, no settings → prepend. */
export const simpleCRLFBoard = '## Today\r\n- [ ] A\r\n';

export const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

export type Behavior = 'ok' | 'fail' | { columnMissing: string } | 'hang';

/** Records every call's arguments; answers like the real `obsidian eval` would. Never spawns anything. */
export class MockRunner implements ProcessRunner {
  calls: Array<{ exe: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number }> = [];
  constructor(public behavior: Behavior = 'ok') {}
  async run(exe: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult> {
    this.calls.push({ exe, args, env, timeoutMs });
    const b = this.behavior;
    if (b === 'ok') return { exitCode: 0, stdout: '=> QC_OK\n', stderr: '' };
    if (b === 'fail') return { exitCode: 1, stdout: '', stderr: 'Error: mock obsidian failure' };
    if (b === 'hang') return new Promise<RunResult>(() => {});
    return { exitCode: 1, stdout: '', stderr: `Error: QC column not found: ${b.columnMissing}` };
  }
}

export const fakeInsertSource = 'function qc_insert(d, c, t) { return d; }\n';
