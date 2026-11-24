// CliWriter, DirectFileWriter and WriteVerifier, ported from DirectFileWriterTests / WriteVerifierTests and the CLI
// cases of CaptureEngineTests. Everything runs against TEMP folders and a mock process runner. The real Obsidian CLI
// and the real vault are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardWriterError, buildEvalProgram, CliWriter, DirectFileWriter, jsString, WriteVerifier } from '../src/writers.js';
import { containsCard } from '../src/board.js';
import { fakeInsertSource, MockRunner, occurrences, simpleBoard, simpleCRLFBoard, tempDir } from './support.js';

const target = (dir: string, column = 'Today', boardPath = 'Board.md') => ({ vaultPath: dir, boardPath, column });
const write = (dir: string, content: string, name = 'Board.md') => { fs.writeFileSync(path.join(dir, name), content); return path.join(dir, name); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('DirectFileWriter', () => {
  it('inserts atomically, preserving permissions and CRLF, and leaves no stray temp files', async () => {
    const dir = tempDir('direct');
    const file = write(dir, simpleCRLFBoard);
    fs.chmodSync(file, 0o640);
    await new DirectFileWriter().insert('Direct card ✨', target(dir));
    expect(read(file)).toBe('## Today\r\n- [ ] Direct card ✨\r\n- [ ] A\r\n');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(['Board.md']);
  });

  it.skipIf(process.platform === 'win32')('the write is a rename over the board (atomic), not an in-place overwrite: a reader can never see half a board', async () => {
    const dir = tempDir('direct-atomic');
    const file = write(dir, simpleBoard);
    const before = fs.statSync(file).ino;
    await new DirectFileWriter().insert('x', target(dir));
    expect(fs.statSync(file).ino).not.toBe(before); // a new file was renamed into place
    expect(containsCard('x', 'Today', read(file))).toBe(true);
  });

  it('a failed write leaves the original board byte-identical and no temp file (the rename target is a directory)', async () => {
    const dir = tempDir('direct-fail');
    fs.mkdirSync(path.join(dir, 'Board.md')); // reading it fails with EISDIR → writeFailed, nothing created
    const e = await new DirectFileWriter().insert('x', target(dir)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BoardWriterError);
    expect(fs.readdirSync(dir)).toEqual(['Board.md']);
  });

  it('a missing board is boardNotFound with the full path', async () => {
    const dir = tempDir('direct-missing');
    const e = await new DirectFileWriter().insert('X', target(dir, 'Today', 'Nope.md')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BoardWriterError);
    expect(e).toMatchObject({ kind: 'boardNotFound', detail: path.join(dir, 'Nope.md') });
  });

  it('a missing column passes through as columnNotFound without touching the file or leaving temp files', async () => {
    const dir = tempDir('direct-column');
    const file = write(dir, simpleBoard);
    const before = fs.readFileSync(file);
    const e = await new DirectFileWriter().insert('X', target(dir, 'Missing Column')).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'columnNotFound', detail: 'Missing Column' });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['Board.md']);
  });

  it('a board that is not valid UTF-8 is refused, never rewritten lossily', async () => {
    const dir = tempDir('direct-utf8');
    const file = path.join(dir, 'Board.md');
    const bytes = Buffer.concat([Buffer.from('## Today\n- [ ] caf'), Buffer.from([0xe9, 0xff, 0xfe]), Buffer.from('\n')]);
    fs.writeFileSync(file, bytes);
    const e = await new DirectFileWriter().insert('X', target(dir)).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'writeFailed' });
    expect((e as Error).message).toContain('UTF-8');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('a UTF-8 byte-order mark and unicode survive an insert', async () => {
    const dir = tempDir('direct-bom');
    const file = write(dir, '﻿## Today\n- [ ] ünï\n');
    await new DirectFileWriter().insert('✨', target(dir));
    expect(read(file)).toBe('﻿## Today\n- [ ] ✨\n- [ ] ünï\n');
  });

  it('25 sequential inserts all land', async () => {
    const dir = tempDir('direct-many');
    const file = write(dir, simpleBoard);
    const w = new DirectFileWriter();
    for (let i = 0; i < 25; i++) await w.insert(`Card ${i}`, target(dir));
    const content = read(file);
    for (let i = 0; i < 25; i++) expect(containsCard(`Card ${i}`, 'Today', content), `Card ${i}`).toBe(true);
  });

  it('concurrent inserts through one writer are serialized: none lost', async () => {
    const dir = tempDir('direct-concurrent');
    const file = write(dir, simpleBoard);
    const w = new DirectFileWriter();
    await Promise.all(Array.from({ length: 30 }, (_, i) => w.insert(`Concurrent ${i}`, target(dir))));
    const content = read(file);
    for (let i = 0; i < 30; i++) expect(occurrences(content, `- [ ] Concurrent ${i}\n`), `Concurrent ${i}`).toBe(1);
  });

  it('a failing insert does not poison the queue: the next one still runs', async () => {
    const dir = tempDir('direct-queue');
    const file = write(dir, simpleBoard);
    const w = new DirectFileWriter();
    await w.insert('X', target(dir, 'Nope')).catch(() => {});
    await w.insert('Still works', target(dir));
    expect(containsCard('Still works', 'Today', read(file))).toBe(true);
  });
});

describe('CliWriter', () => {
  const dirWithBoard = () => { const dir = tempDir('cli'); write(dir, simpleBoard); return dir; };
  const writer = (runner: MockRunner, over: Partial<ConstructorParameters<typeof CliWriter>[0]> = {}) =>
    new CliWriter({ runner, cliPath: '/fake/obsidian', insertSource: fakeInsertSource, env: { PATH: '/x' }, ...over });

  it('runs `obsidian eval code=<program>` as ONE argument, with insert.js, app.vault.process, the column and the card', async () => {
    const dir = dirWithBoard();
    const r = new MockRunner('ok');
    await writer(r).insert('CLI card ✨', target(dir));
    expect(r.calls).toHaveLength(1);
    const { exe, args, timeoutMs } = r.calls[0]!;
    expect(exe).toBe('/fake/obsidian');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('eval');
    expect(args[1]!.startsWith('code=')).toBe(true);
    for (const needle of ['qc_insert', 'app.vault.process', '"Today"', 'CLI card ✨', '"Board.md"', 'QC_OK']) expect(args[1], needle).toContain(needle);
    expect(timeoutMs).toBe(10_000);
  });

  it('the CLI is never spawned for a board that is not on disk', async () => {
    const dir = tempDir('cli-missing');
    const r = new MockRunner('ok');
    const e = await writer(r).insert('X', target(dir)).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'boardNotFound' });
    expect(r.calls).toEqual([]);
  });

  it('exit 0 without QC_OK is a failure (an old CLI that prints nothing must not look like success)', async () => {
    const r = new MockRunner('ok');
    r.run = async (exe, args, env, timeoutMs) => { r.calls.push({ exe, args, env, timeoutMs }); return { exitCode: 0, stdout: '=> undefined\n', stderr: '' }; };
    const e = await writer(r).insert('X', target(dirWithBoard())).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'obsidianCLIFailed' });
  });

  it('a non-zero exit is obsidianCLIFailed carrying the exit status, stderr and stdout', async () => {
    const e = await writer(new MockRunner('fail')).insert('X', target(dirWithBoard())).catch((x: unknown) => x) as BoardWriterError;
    expect(e.kind).toBe('obsidianCLIFailed');
    expect(e.message).toContain('/fake/obsidian exited with status 1');
    expect(e.message).toContain('mock obsidian failure');
  });

  it('JS-side "QC column not found" becomes columnNotFound (loud, never a silent fallback)', async () => {
    const e = await writer(new MockRunner({ columnMissing: 'Today' })).insert('X', target(dirWithBoard())).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'columnNotFound', detail: 'Today' });
  });

  it('a runner that throws is obsidianCLIFailed', async () => {
    const r = new MockRunner(); r.run = async () => { throw new Error('spawn ENOENT'); };
    const e = await writer(r).insert('X', target(dirWithBoard())).catch((x: unknown) => x) as BoardWriterError;
    expect(e.kind).toBe('obsidianCLIFailed');
    expect(e.message).toContain('spawn ENOENT');
  });

  it('a CLI that never answers is cut off at the timeout, not awaited forever', async () => {
    const e = await writer(new MockRunner('hang'), { timeoutMs: 80 }).insert('X', target(dirWithBoard())).catch((x: unknown) => x) as BoardWriterError;
    expect(e.kind).toBe('obsidianCLIFailed');
    expect(e.message).toContain('did not answer');
  });

  it('a missing insert.js source is a clear error', async () => {
    const e = await writer(new MockRunner('ok'), { insertSource: '' }).insert('X', target(dirWithBoard())).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'obsidianCLIFailed' });
    expect((e as Error).message).toContain('insert.js');
  });

  it('long stderr is trimmed to its tail in the message', async () => {
    const r = new MockRunner(); r.run = async () => ({ exitCode: 2, stdout: '', stderr: 'A'.repeat(5000) + 'THE-END' });
    const e = await writer(r).insert('X', target(dirWithBoard())).catch((x: unknown) => x) as BoardWriterError;
    expect(e.message).toContain('THE-END');
    expect(e.message.length).toBeLessThan(900);
  });
});

describe('buildEvalProgram / jsString', () => {
  it('encodes the BOARD PATH too (a quote or backslash in a folder name cannot break the program)', () => {
    const program = buildEvalProgram(fakeInsertSource, 'My "Boards"\\Work\u2028.md', 'Today', 'x');
    expect(program).toContain(jsString('My "Boards"\\Work\u2028.md'));
    expect(() => new Function(program.replace(/\bawait\b/g, '').replace('(async () => {', '(() => {'))).not.toThrow();
  });

  it('encodes every dynamic value as a JSON string literal, so no card text can break out of the program', () => {
    const hostile = '"); process.exit(1); //\n`${x}` \u2028 \u2029 \\ \'';
    const program = buildEvalProgram(fakeInsertSource, 'a/b.md', 'Col "x"', hostile);
    // Parse the program as JavaScript: it must stay one well-formed script that never executes the card text.
    expect(() => new Function(program.replace(/\bawait\b/g, '').replace('(async () => {', '(() => {'))).not.toThrow();
    expect(program).toContain(jsString(hostile));
    expect(program).not.toContain('process.exit(1); //\n');
  });
  it('escapes U+2028/U+2029 and control characters', () => {
    expect(jsString('a\u2028b\u2029c\u0001d')).toBe('"a\\u2028b\\u2029c\\u0001d"');
    expect(jsString('line\nbreak\ttab\r"q"\\')).toBe('"line\\nbreak\\ttab\\r\\"q\\"\\\\"');
  });
  it('round-trips through JSON.parse for any string', () => {
    for (const s of ['', 'plain', '✨ 👩‍💻', '\u0000\u001f', 'a\u2028b', '"\\"', 'x'.repeat(5000)]) expect(JSON.parse(jsString(s))).toBe(s);
  });
});

describe('WriteVerifier', () => {
  const verifier = (direct: DirectFileWriter, delaysMs: number[], giveUps: Array<[string, string]>) =>
    new WriteVerifier({ direct, onGiveUp: (t, text) => giveUps.push([t.column, text]), delaysMs });

  it('re-inserts a clobbered card, never double-inserts, and does not give up', async () => {
    const dir = tempDir('verify-clobber');
    const file = write(dir, simpleBoard);
    const direct = new DirectFileWriter();
    await direct.insert('Verifier card ✨', target(dir));
    fs.writeFileSync(file, simpleBoard); // Obsidian's debounced save clobbers our write
    const giveUps: Array<[string, string]> = [];
    verifier(direct, [100, 200, 300], giveUps).schedule(target(dir), 'Verifier card ✨');
    await sleep(900);
    const content = read(file);
    expect(containsCard('Verifier card ✨', 'Today', content)).toBe(true);
    expect(giveUps).toEqual([]);
    expect(occurrences(content, '- [ ] Verifier card ✨')).toBe(1);
  });

  it('leaves a confirmed card alone', async () => {
    const dir = tempDir('verify-ok');
    const file = write(dir, simpleBoard);
    const direct = new DirectFileWriter();
    await direct.insert('Settled card', target(dir));
    const giveUps: Array<[string, string]> = [];
    verifier(direct, [100, 200], giveUps).schedule(target(dir), 'Settled card');
    await sleep(500);
    expect(occurrences(read(file), '- [ ] Settled card')).toBe(1);
    expect(giveUps).toEqual([]);
  });

  it('gives up EXACTLY ONCE when the clobber persists (the column is gone, so a re-insert can never land)', async () => {
    const dir = tempDir('verify-giveup');
    const file = write(dir, simpleBoard);
    const direct = new DirectFileWriter();
    await direct.insert('Doomed card', target(dir));
    fs.writeFileSync(file, simpleBoard.replace('## Today', '## Tomorrow'));
    const giveUps: Array<[string, string]> = [];
    verifier(direct, [100, 200, 300], giveUps).schedule(target(dir), 'Doomed card');
    await sleep(900);
    expect(giveUps).toEqual([['Today', 'Doomed card']]);
    expect(containsCard('Doomed card', 'Today', read(file))).toBe(false);
  });

  it('a board that cannot be read at a check counts as "card absent", and a later check can still recover', async () => {
    const dir = tempDir('verify-unreadable');
    const file = path.join(dir, 'Board.md');
    const direct = new DirectFileWriter();
    write(dir, simpleBoard);
    await direct.insert('Late card', target(dir));
    fs.rmSync(file);                        // board vanishes (sync client mid-swap)…
    setTimeout(() => fs.writeFileSync(file, simpleBoard), 60); // …and comes back without the card
    const giveUps: Array<[string, string]> = [];
    verifier(direct, [30, 150, 300], giveUps).schedule(target(dir), 'Late card');
    await sleep(800);
    expect(containsCard('Late card', 'Today', read(file))).toBe(true);
    expect(giveUps).toEqual([]);
  });

  it('schedule() returns immediately (it never blocks the capture) and an empty schedule does nothing', async () => {
    const dir = tempDir('verify-fire');
    write(dir, simpleBoard);
    const direct = new DirectFileWriter();
    const t0 = Date.now();
    verifier(direct, [5_000], []).schedule(target(dir), 'x').cancel();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(() => verifier(direct, [], []).schedule(target(dir), 'x')).not.toThrow();
  });

  it('cancel() stops the checks: no re-insert and no give-up after it', async () => {
    const dir = tempDir('verify-cancel');
    const file = write(dir, simpleBoard);
    const giveUps: Array<[string, string]> = [];
    const handle = verifier(new DirectFileWriter(), [60, 120], giveUps).schedule(target(dir), 'Never written');
    handle.cancel();
    await sleep(400);
    expect(giveUps).toEqual([]);
    expect(read(file)).toBe(simpleBoard);
  });

  it('the default schedule is +1 s, +3 s, +6 s', () => { expect(WriteVerifier.defaultDelaysMs).toEqual([1000, 3000, 6000]); });
});
