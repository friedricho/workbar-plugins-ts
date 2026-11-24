// Finding boards and columns in a vault (port of the Swift SettingsStore.scanBoards / columnNames).
import fs from 'node:fs/promises';
import path from 'node:path';
import { columnNames } from './board.js';

const HEAD_BYTES = 1024;

async function looksLikeKanban(file: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8').includes('kanban-plugin');
  } catch { return false; } finally { await handle?.close().catch(() => {}); }
}

/** .md files whose first 1 KB mentions "kanban-plugin" (obsidian-kanban boards). Hidden entries are never entered, so
 *  .obsidian, .trash and any dot-folder are skipped; symlinks are not followed, so a link loop cannot hang the scan.
 *  Returns vault-relative paths with forward slashes, sorted. */
export async function scanBoards(vaultPath: string): Promise<string[]> {
  if (!vaultPath) return [];
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, r);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && (await looksLikeKanban(full))) found.push(r);
    }
  };
  await walk(vaultPath, '');
  return found.sort();
}

/** Depth-2 headings of the configured board (empty when unreadable). */
export async function boardColumns(o: { vaultPath: string; boardPath: string }): Promise<string[]> {
  if (!o.vaultPath || !o.boardPath) return [];
  try { return columnNames(await fs.readFile(path.join(o.vaultPath, o.boardPath), 'utf8')); } catch { return []; }
}
