// Atomic text writes for notes in a vault (the Swift PendoReportWriter
// discipline): temp file in the destination folder with a non-.md name (a
// vault watcher never sees it as a note), the original's permissions kept,
// then rename over the destination, so a reader never sees half a note.
// Windows can refuse the rename while Obsidian, a sync client or antivirus
// briefly holds the file: retry with backoff.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class WriteError extends Error {
  constructor(detail: string) {
    super(`Couldn’t write the note: ${detail}`);
    this.name = 'WriteError';
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function writeTextAtomic(file: string, content: string, tempPrefix: string): Promise<void> {
  const dir = path.dirname(file);
  try { await fs.mkdir(dir, { recursive: true }); }
  catch (e) { throw new WriteError(`couldn’t create ${dir}: ${(e as Error).message}`); }
  let mode: number | undefined;
  try { mode = (await fs.stat(file)).mode & 0o7777; } catch { mode = undefined; }
  const tmp = path.join(dir, `.${tempPrefix}-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); return; }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt < 6 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) { await sleep(25 * 2 ** attempt); continue; }
        throw e;
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (e instanceof WriteError) throw e;
    throw new WriteError(`${file}: ${(e as Error).message}`);
  }
}
