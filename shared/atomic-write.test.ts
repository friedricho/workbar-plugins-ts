import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTextAtomic } from './atomic-write.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-write-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('writeTextAtomic (ported from ChangelogNoteWriterTests)', () => {
  it('writes the file, creating a missing folder, and leaves no temp files', async () => {
    const file = path.join(tmp, 'vault', 'Workato', '2026-Q4.md');
    await writeTextAtomic(file, '# hi', 'workatochangelog');
    expect(fs.readFileSync(file, 'utf8')).toBe('# hi');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['2026-Q4.md']);
  });
  it('overwrite replaces the content', async () => {
    const file = path.join(tmp, 'n.md');
    await writeTextAtomic(file, 'one', 'p');
    await writeTextAtomic(file, 'two', 'p');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
  });
  it.skipIf(process.platform === 'win32')('the original POSIX permissions survive the swap', async () => {
    const file = path.join(tmp, 'n.md');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(file, 0o640);
    await writeTextAtomic(file, 'new', 'p');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
  it('reports a folder it cannot create', async () => {
    const blocker = path.join(tmp, 'file');
    fs.writeFileSync(blocker, '');
    await expect(writeTextAtomic(path.join(blocker, 'sub', 'n.md'), 'x', 'p')).rejects.toThrow(/Couldn’t write the note: couldn’t create/);
  });
});
