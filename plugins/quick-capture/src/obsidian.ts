// Finding and detecting Obsidian. The "is it running" check happens BEFORE any CLI spawn, so the CLI can never launch
// Obsidian as a side effect of a capture. Everything environmental is injected, so tests never touch the real
// process list, filesystem or Obsidian CLI.
import path from 'node:path';
import type { Platform } from '@workbar/sdk';
import type { ProcessRunner } from './process-runner.js';

const PROBE_TIMEOUT_MS = 5_000;

export async function isObsidianRunning(platform: Platform, runner: ProcessRunner): Promise<boolean> {
  try {
    if (platform === 'win32') {
      const r = await runner.run('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], {}, PROBE_TIMEOUT_MS);
      return /Obsidian\.exe/i.test(r.stdout);
    }
    // -x: exact process name, so "Obsidian Helper" alone does not count. Exit 0 = a match.
    const r = await runner.run(platform === 'darwin' ? '/usr/bin/pgrep' : 'pgrep', ['-x', platform === 'darwin' ? 'Obsidian' : 'obsidian'], { PATH: '/usr/bin:/bin' }, PROBE_TIMEOUT_MS);
    return r.exitCode === 0;
  } catch { return false; } // can't tell: treat as not running, and the direct tier handles the capture
}

/** Where the Obsidian CLI usually lives, most specific first. */
export function cliCandidates(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  if (platform === 'darwin') return ['/usr/local/bin/obsidian', '/opt/homebrew/bin/obsidian', '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli'];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(local, 'Programs', 'Obsidian', 'Obsidian.com'), path.win32.join(local, 'Obsidian', 'Obsidian.com')];
  }
  return ['/usr/local/bin/obsidian', '/usr/bin/obsidian'];
}

/** An explicit setting wins even if it does not exist: a wrong path should fail loudly, not be silently replaced.
 *  Otherwise the first known install; otherwise the bare name, looked up in PATH at spawn time. */
export function resolveCliPath(o: { override?: string; platform: Platform; home: string; env?: Record<string, string | undefined>; exists: (p: string) => boolean }): string {
  const override = o.override?.trim();
  if (override) return override;
  return cliCandidates(o.platform, o.home, o.env ?? {}).find(o.exists) ?? 'obsidian';
}

/** A guaranteed PATH (the CLI may shell out to node/open) plus only the essentials: never the whole inherited environment. */
export function cliEnvironment(platform: Platform, inherited: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (platform === 'win32') {
    for (const k of ['PATH', 'Path', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) { const v = inherited[k]; if (v) out[k] = v; }
    return out;
  }
  const sane = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  out.PATH = inherited.PATH ? `${sane}:${inherited.PATH}` : sane;
  for (const k of ['HOME', 'USER', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL']) { const v = inherited[k]; if (v) out[k] = v; }
  return out;
}
