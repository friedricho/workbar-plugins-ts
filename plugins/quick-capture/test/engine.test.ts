// CaptureEngine, ported from CaptureEngineTests + the SelfTest scenarios of the Swift repo. All boards live in TEMP
// folders and the CLI is a mock: the real Obsidian CLI and the real vault are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { containsCard } from '../src/board.js';
import { CaptureEngine } from '../src/engine.js';
import { BoardWriterError, type CaptureTarget } from '../src/writers.js';
import { fakeInsertSource, MockRunner, occurrences, simpleBoard, tempDir } from './support.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup(o: { running: boolean; behavior?: ConstructorParameters<typeof MockRunner>[0]; cliExists?: boolean; delaysMs?: number[] } = { running: false }) {
  const dir = tempDir('engine');
  const file = path.join(dir, 'Board.md');
  fs.writeFileSync(file, simpleBoard);
  const target: CaptureTarget = { vaultPath: dir, boardPath: 'Board.md', column: 'Today' };
  const runner = new MockRunner(o.behavior ?? 'ok');
  const giveUps: Array<[string, string]> = [];
  const probes: number[] = [];
  const engine = new CaptureEngine({
    runner, insertSource: () => fakeInsertSource, cliPath: () => '/fake/obsidian', cliExists: () => o.cliExists ?? true,
    isObsidianRunning: async () => { probes.push(Date.now()); return o.running; },
    env: () => ({ PATH: '/x' }), verifierDelaysMs: o.delaysMs ?? [50],
    onGiveUp: (t, text) => giveUps.push([t.column, text]),
  });
  return { dir, file, target, runner, engine, giveUps, probes, read: () => fs.readFileSync(file, 'utf8') };
}

describe('CaptureEngine tiers', () => {
  it('Obsidian running and the CLI succeeds → the CLI tier, and the board file is untouched by us', async () => {
    const s = setup({ running: true });
    const before = fs.readFileSync(s.file);
    expect(await s.engine.capture('CLI card ✨', s.target)).toBe('cli');
    expect(s.runner.calls).toHaveLength(1);
    expect(s.runner.calls[0]!.args[0]).toBe('eval');
    expect(fs.readFileSync(s.file).equals(before)).toBe(true); // the direct writer never ran
    s.engine.dispose();
  });

  it('Obsidian running but the CLI fails → falls back to the direct writer, CLI attempted exactly once', async () => {
    const s = setup({ running: true, behavior: 'fail', delaysMs: [50, 100] });
    expect(await s.engine.capture('Fallback card ✨', s.target)).toBe('direct');
    expect(s.runner.calls).toHaveLength(1);
    await sleep(400);
    expect(occurrences(s.read(), '- [ ] Fallback card ✨')).toBe(1);
    expect(s.giveUps).toEqual([]);
    s.engine.dispose();
  });

  it('the CLI reports the column missing → a typed error, LOUD: no fallback insert anywhere', async () => {
    const s = setup({ running: true, behavior: { columnMissing: 'Today' } });
    const before = fs.readFileSync(s.file);
    const e = await s.engine.capture('Lost card', s.target).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'columnNotFound', detail: 'Today' });
    expect(fs.readFileSync(s.file).equals(before)).toBe(true);
    s.engine.dispose();
  });

  it('Obsidian NOT running → direct tier + verifier; the CLI is never spawned (so it can never launch Obsidian)', async () => {
    const s = setup({ running: false });
    expect(await s.engine.capture('Direct card', s.target)).toBe('direct');
    expect(s.runner.calls).toEqual([]);
    expect(containsCard('Direct card', 'Today', s.read())).toBe(true);
    s.engine.dispose();
  });

  it('Obsidian running but the CLI binary is not installed → direct tier, no spawn', async () => {
    const s = setup({ running: true, cliExists: false });
    expect(await s.engine.capture('No CLI card', s.target)).toBe('direct');
    expect(s.runner.calls).toEqual([]);
    s.engine.dispose();
  });

  it('a missing column on the direct tier → typed error, file byte-identical, no CLI spawn', async () => {
    const s = setup({ running: false });
    const before = fs.readFileSync(s.file);
    const e = await s.engine.capture('Lost card', { ...s.target, column: 'Nope' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: 'columnNotFound', detail: 'Nope' });
    expect(fs.readFileSync(s.file).equals(before)).toBe(true);
    expect(s.runner.calls).toEqual([]);
    s.engine.dispose();
  });

  it('empty vault / board / column is notConfigured, and nothing is probed or spawned', async () => {
    const s = setup({ running: true });
    for (const t of [{ ...s.target, vaultPath: '' }, { ...s.target, boardPath: '' }, { ...s.target, column: '' }]) {
      const e = await s.engine.capture('X', t).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BoardWriterError);
      expect(e).toMatchObject({ kind: 'notConfigured' });
    }
    expect(s.runner.calls).toEqual([]);
    expect(s.probes).toEqual([]);
    s.engine.dispose();
  });

  it('a board that does not exist is boardNotFound on either tier', async () => {
    for (const running of [true, false]) {
      const s = setup({ running });
      const e = await s.engine.capture('X', { ...s.target, boardPath: 'Gone.md' }).catch((x: unknown) => x);
      expect(e, String(running)).toMatchObject({ kind: 'boardNotFound' });
      s.engine.dispose();
    }
  });

  it('a hung CLI cannot hang a capture: it times out and the direct tier saves the card', async () => {
    const dir = tempDir('engine-hang'); fs.writeFileSync(path.join(dir, 'Board.md'), simpleBoard);
    const engine = new CaptureEngine({
      runner: new MockRunner('hang'), insertSource: () => fakeInsertSource, cliPath: () => '/fake/obsidian', cliExists: () => true,
      isObsidianRunning: async () => true, env: () => ({}), verifierDelaysMs: [50], cliTimeoutMs: 80, onGiveUp: () => {},
    });
    expect(await engine.capture('Hung', { vaultPath: dir, boardPath: 'Board.md', column: 'Today' })).toBe('direct');
    expect(containsCard('Hung', 'Today', fs.readFileSync(path.join(dir, 'Board.md'), 'utf8'))).toBe(true);
    engine.dispose();
  });
});

describe('CaptureEngine serialization and verification', () => {
  it('20 simultaneous captures on the direct tier: none lost, each exactly once', async () => {
    const s = setup({ running: false });
    const tiers = await Promise.all(Array.from({ length: 20 }, (_, i) => s.engine.capture(`Concurrent card ${i}`, s.target)));
    expect(new Set(tiers)).toEqual(new Set(['direct']));
    await sleep(300);
    for (let i = 0; i < 20; i++) expect(occurrences(s.read(), `- [ ] Concurrent card ${i}\n`), `Concurrent card ${i}`).toBe(1);
    s.engine.dispose();
  });

  it('simultaneous CLI captures run one at a time (the mutation serializer covers the CLI tier too)', async () => {
    const s = setup({ running: true });
    let active = 0; let maxActive = 0;
    s.runner.run = async (exe, args, env, timeoutMs) => {
      s.runner.calls.push({ exe, args, env, timeoutMs });
      active++; maxActive = Math.max(maxActive, active);
      await sleep(15); active--;
      return { exitCode: 0, stdout: '=> QC_OK\n', stderr: '' };
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => s.engine.capture(`C${i}`, s.target)));
    expect(s.runner.calls).toHaveLength(8);
    expect(maxActive).toBe(1);
    s.engine.dispose();
  });

  it('a failed capture does not stop the next one', async () => {
    const s = setup({ running: false });
    await s.engine.capture('x', { ...s.target, column: 'Nope' }).catch(() => {});
    expect(await s.engine.capture('after failure', s.target)).toBe('direct');
    s.engine.dispose();
  });

  it('50 sequential direct captures: all present, contiguous and in order; frontmatter and settings block byte-identical', async () => {
    const dir = tempDir('engine-50');
    const board = '---\nkanban-plugin: board\n---\n\n## Backlog\n\n- [ ] Seed backlog card\n\n## Today\n\n- [ ] Seed one\n- [ ] Seed two\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","new-card-insertion-method":"append","show-checkboxes":false}\n```\n%%';
    const file = path.join(dir, 'Board.md'); fs.writeFileSync(file, board);
    const engine = new CaptureEngine({
      runner: new MockRunner('fail'), insertSource: () => fakeInsertSource, cliPath: () => '/x', cliExists: () => true,
      isObsidianRunning: async () => false, env: () => ({}), verifierDelaysMs: [50], onGiveUp: () => {},
    });
    const cards = Array.from({ length: 50 }, (_, i) => `Selftest card ${String(i).padStart(2, '0')} ✨`);
    for (const c of cards) expect(await engine.capture(c, { vaultPath: dir, boardPath: 'Board.md', column: 'Today' })).toBe('direct');
    const out = fs.readFileSync(file, 'utf8');
    // The Today section is the original two cards, then the 50 in order, with the original trailing blank kept last.
    const section = out.split('## Today\n')[1]!.split('%% kanban:settings')[0]!;
    expect(section).toBe('\n- [ ] Seed one\n- [ ] Seed two\n' + cards.map(c => `- [ ] ${c}\n`).join('') + '\n');
    expect(out.startsWith('---\nkanban-plugin: board\n---\n\n## Backlog\n\n- [ ] Seed backlog card\n\n## Today')).toBe(true);
    expect(out.endsWith('%% kanban:settings\n```\n{"kanban-plugin":"board","new-card-insertion-method":"append","show-checkboxes":false}\n```\n%%')).toBe(true);
    engine.dispose();
  });

  it('the verifier is armed after a direct write: a clobbered card comes back, once, with no give-up', async () => {
    const s = setup({ running: false, delaysMs: [80, 160, 240] });
    await s.engine.capture('Race card ✨', s.target);
    fs.writeFileSync(s.file, simpleBoard); // Obsidian's debounced save clobbers us
    await sleep(700);
    expect(occurrences(s.read(), '- [ ] Race card ✨')).toBe(1);
    expect(s.giveUps).toEqual([]);
    s.engine.dispose();
  });

  it('a card that can never be restored triggers the give-up callback exactly once (never silent)', async () => {
    const s = setup({ running: false, delaysMs: [60, 120, 180] });
    await s.engine.capture('Doomed', s.target);
    fs.writeFileSync(s.file, simpleBoard.replace('## Today', '## Tomorrow'));
    await sleep(600);
    expect(s.giveUps).toEqual([['Today', 'Doomed']]);
    s.engine.dispose();
  });

  it('the CLI tier arms no verifier (Obsidian owns the file)', async () => {
    const s = setup({ running: true, delaysMs: [30] });
    await s.engine.capture('CLI', s.target);
    await sleep(150);
    expect(s.giveUps).toEqual([]);
    s.engine.dispose();
  });

  it('dispose() cancels pending verifiers: no re-insert and no give-up afterwards', async () => {
    const s = setup({ running: false, delaysMs: [100, 200] });
    await s.engine.capture('Cancelled', s.target);
    fs.writeFileSync(s.file, simpleBoard);
    s.engine.dispose();
    await sleep(450);
    expect(s.giveUps).toEqual([]);
    expect(s.read()).toBe(simpleBoard);
  });
});
