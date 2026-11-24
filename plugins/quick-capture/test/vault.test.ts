// Ported from SettingsStoreTests (scanBoards, columnNames). Real temp folders, real files.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boardColumns, scanBoards } from '../src/vault.js';
import { simpleBoard, tempDir } from './support.js';

const put = (root: string, rel: string, content: string | Buffer) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

describe('scanBoards', () => {
  it('finds only kanban boards, skips hidden folders, returns sorted vault-relative paths with forward slashes', async () => {
    const vault = tempDir('vault');
    put(vault, 'Kanban.md', '---\nkanban-plugin: board\n---\n\n## Today\n');
    put(vault, 'Notes/Plain.md', '# Just notes\n## Today\n');
    put(vault, 'Projects/DeepBoard.md', '---\nkanban-plugin: board\n---\n\n%% kanban:settings\n```\n{"new-card-insertion-method":"append"}\n```\n%%\n## Today\n');
    put(vault, '.obsidian/Config.md', '---\nkanban-plugin: board\n---\n');
    put(vault, '.trash/Gone.md', '---\nkanban-plugin: board\n---\n');
    put(vault, 'Notes/.hidden/Secret.md', '---\nkanban-plugin: board\n---\n');
    expect(await scanBoards(vault)).toEqual(['Kanban.md', 'Projects/DeepBoard.md']);
  });
  it('only .md files count, in any letter case', async () => {
    const vault = tempDir('vault-ext');
    put(vault, 'a.txt', 'kanban-plugin: board');
    put(vault, 'b.MD', 'kanban-plugin: board');
    expect(await scanBoards(vault)).toEqual(['b.MD']);
  });
  it('looks at the first 1 KB only', async () => {
    const vault = tempDir('vault-1k');
    put(vault, 'late.md', 'x'.repeat(1100) + 'kanban-plugin');
    put(vault, 'early.md', 'kanban-plugin' + 'x'.repeat(2000));
    expect(await scanBoards(vault)).toEqual(['early.md']);
  });
  it('a missing or unreadable vault is an empty list, never a throw', async () => {
    expect(await scanBoards('/nonexistent/vault')).toEqual([]);
    expect(await scanBoards('')).toEqual([]);
  });
  it('does not follow a symlink loop', async () => {
    const vault = tempDir('vault-loop');
    put(vault, 'Board.md', 'kanban-plugin: board');
    if (process.platform !== 'win32') fs.symlinkSync(vault, path.join(vault, 'loop'), 'dir');
    expect(await scanBoards(vault)).toEqual(['Board.md']);
  });
  it('a file that cannot be read is skipped, not fatal', async () => {
    const vault = tempDir('vault-perm');
    put(vault, 'ok.md', 'kanban-plugin: board');
    put(vault, 'locked.md', 'kanban-plugin: board');
    if (process.platform !== 'win32') { fs.chmodSync(path.join(vault, 'locked.md'), 0o000); }
    const found = await scanBoards(vault);
    if (process.platform !== 'win32') fs.chmodSync(path.join(vault, 'locked.md'), 0o644);
    expect(found).toContain('ok.md');
  });
});

describe('boardColumns', () => {
  it('lists the depth-2 headings of the configured board', async () => {
    const vault = tempDir('cols');
    put(vault, 'Board.md', simpleBoard);
    expect(await boardColumns({ vaultPath: vault, boardPath: 'Board.md' })).toEqual(['Backlog', 'Today', 'Done']);
  });
  it('is empty when the board is unreadable or the paths are unset', async () => {
    expect(await boardColumns({ vaultPath: '/nonexistent', boardPath: 'x.md' })).toEqual([]);
    expect(await boardColumns({ vaultPath: '', boardPath: '' })).toEqual([]);
  });
});
