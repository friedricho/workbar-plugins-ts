// The "is Obsidian running" check (it runs BEFORE any CLI spawn, so the CLI can never launch Obsidian) and CLI path
// resolution. Both take injected probes: no test touches the real process list or the real Obsidian CLI.
import { describe, expect, it } from 'vitest';
import { cliCandidates, cliEnvironment, isObsidianRunning, resolveCliPath } from '../src/obsidian.js';
import { MockRunner } from './support.js';

const probe = (stdout: string, exitCode = 0) => { const r = new MockRunner(); r.run = async (exe, args, env, timeoutMs) => { r.calls.push({ exe, args, env, timeoutMs }); return { exitCode, stdout, stderr: '' }; }; return r; };

describe('isObsidianRunning', () => {
  it('macOS: pgrep -x Obsidian exits 0 when the app is running', async () => {
    const r = probe('123\n');
    expect(await isObsidianRunning('darwin', r)).toBe(true);
    expect(r.calls[0]).toMatchObject({ exe: '/usr/bin/pgrep', args: ['-x', 'Obsidian'] });
  });
  it('macOS: exit 1 (no match) means not running; Obsidian Helper processes alone do not count (-x is an exact match)', async () => {
    expect(await isObsidianRunning('darwin', probe('', 1))).toBe(false);
  });
  it('Windows: tasklist output naming Obsidian.exe means running', async () => {
    const r = probe('Obsidian.exe                  4242 Console                    1    210,000 K\r\n');
    expect(await isObsidianRunning('win32', r)).toBe(true);
    expect(r.calls[0]!.args).toEqual(['/FI', 'IMAGENAME eq Obsidian.exe', '/NH']);
  });
  it('Windows: "No tasks are running" means not running', async () => {
    expect(await isObsidianRunning('win32', probe('INFO: No tasks are running which match the specified criteria.\r\n'))).toBe(false);
  });
  it('a probe that cannot run is "not running", never an exception (the direct tier then handles the capture)', async () => {
    const broken = new MockRunner(); broken.run = async () => { throw new Error('spawn failed'); };
    expect(await isObsidianRunning('darwin', broken)).toBe(false);
  });
  it('Linux: pgrep -x obsidian', async () => {
    const r = probe('9\n');
    expect(await isObsidianRunning('linux', r)).toBe(true);
    expect(r.calls[0]!.args).toEqual(['-x', 'obsidian']);
  });
});

describe('resolveCliPath', () => {
  const home = '/Users/me';
  it('an explicit setting wins, even if it does not exist (a wrong path must fail loudly, not be silently replaced)', () => {
    expect(resolveCliPath({ override: '/custom/obsidian', platform: 'darwin', home, exists: () => false })).toBe('/custom/obsidian');
  });
  it('a blank override is no override', () => {
    expect(resolveCliPath({ override: '   ', platform: 'darwin', home, exists: p => p === '/usr/local/bin/obsidian' })).toBe('/usr/local/bin/obsidian');
  });
  it('macOS tries /usr/local/bin/obsidian first, then Homebrew, then the app bundle', () => {
    const exists = (set: string[]) => (p: string) => set.includes(p);
    expect(resolveCliPath({ platform: 'darwin', home, exists: exists(['/opt/homebrew/bin/obsidian', '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli']) })).toBe('/opt/homebrew/bin/obsidian');
    expect(resolveCliPath({ platform: 'darwin', home, exists: exists(['/Applications/Obsidian.app/Contents/MacOS/obsidian-cli']) })).toBe('/Applications/Obsidian.app/Contents/MacOS/obsidian-cli');
  });
  it('falls back to the bare name (looked up in PATH at spawn time) when no known install exists', () => {
    expect(resolveCliPath({ platform: 'darwin', home, exists: () => false })).toBe('obsidian');
  });
  it('lists no candidates it was not told about on Linux', () => {
    expect(cliCandidates('linux', home, {})).toEqual(['/usr/local/bin/obsidian', '/usr/bin/obsidian']);
  });
});

describe('cliEnvironment', () => {
  it('guarantees a sane PATH ahead of the inherited one, and passes only the essentials', () => {
    const env = cliEnvironment('darwin', { PATH: '/weird/bin', HOME: '/Users/me', USER: 'me', SECRET_TOKEN: 'nope', LANG: 'en_US.UTF-8' });
    expect(env.PATH).toBe('/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/weird/bin');
    expect(env).toMatchObject({ HOME: '/Users/me', USER: 'me', LANG: 'en_US.UTF-8' });
    expect(env.SECRET_TOKEN).toBeUndefined();
  });
  it('works with no inherited PATH', () => {
    expect(cliEnvironment('darwin', {}).PATH).toBe('/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
