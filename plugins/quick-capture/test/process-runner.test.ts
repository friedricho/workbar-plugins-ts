// Ported from ProcessRunnerTests.swift. Children are `node -e …` (present on every OS), not /bin/sh.
import { describe, expect, it } from 'vitest';
import { nodeProcessRunner, RunnerError } from '../src/process-runner.js';

const node = process.execPath;
const env = { PATH: process.env.PATH ?? '' };

describe('nodeProcessRunner', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await nodeProcessRunner.run(node, ['-e', 'process.stdout.write("hello world\\n")'], env, 10_000);
    expect(r).toEqual({ exitCode: 0, stdout: 'hello world\n', stderr: '' });
  });

  it('captures stderr and a non-zero exit code (a failure is a result, not a throw)', async () => {
    const r = await nodeProcessRunner.run(node, ['-e', 'console.error("oops"); process.exit(3)'], env, 10_000);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('oops\n');
  });

  it('passes each argument whole (spaces, quotes, newlines and unicode survive; no shell)', async () => {
    const arg = 'code=line one\nsay "hi" && echo $HOME `x` ✨';
    const r = await nodeProcessRunner.run(node, ['-e', 'process.stdout.write(process.argv[1])', arg], env, 10_000);
    expect(r.stdout).toBe(arg);
  });

  it('a very large argument (like insert.js + a card) is delivered intact', async () => {
    // Windows caps the whole command line at ~32,767 chars; insert.js + a card is ~10 KB, so 20k still covers it there.
    const arg = 'x'.repeat(process.platform === 'win32' ? 20_000 : 60_000) + '✨';
    const r = await nodeProcessRunner.run(node, ['-e', 'process.stdout.write(String(process.argv[1].length))', arg], env, 10_000);
    expect(r.stdout).toBe(String(arg.length));
  });

  it('uses ONLY the environment it is given', async () => {
    const r = await nodeProcessRunner.run(node, ['-e', 'process.stdout.write(String(process.env.QC_ONLY_ME) + "|" + String(process.env.HOME))'], { QC_ONLY_ME: 'yes' }, 10_000);
    expect(r.stdout).toBe('yes|undefined');
  });

  it('a missing executable is a launch failure', async () => {
    const e = await nodeProcessRunner.run('/nonexistent/qc-missing', ['-v'], {}, 10_000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RunnerError);
    expect((e as RunnerError).kind).toBe('launchFailed');
  });

  it('a runner that outlives the timeout is terminated near the timeout, not after it finishes', async () => {
    const started = Date.now();
    const e = await nodeProcessRunner.run(node, ['-e', 'setTimeout(() => {}, 30000)'], env, 300).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RunnerError);
    expect((e as RunnerError).kind).toBe('timedOut');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
