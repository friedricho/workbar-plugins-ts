// The real capture engine for the running plugin: node:child_process for the Obsidian CLI, the real process list for
// "is Obsidian running", the real filesystem. Tests inject a fake engine instead and never reach this file.
import fs from 'node:fs';
import os from 'node:os';
import type { Platform } from '@workbar/sdk';
import { CaptureEngine } from './engine.js';
import { cliEnvironment, isObsidianRunning, resolveCliPath } from './obsidian.js';
import { nodeProcessRunner } from './process-runner.js';
import type { CaptureTarget } from './writers.js';

export interface EngineContext {
  readonly platform: Platform;
  /** The user's CLI-path override from settings, if any. */
  readonly cliOverride: () => string | undefined;
  readonly onGiveUp: (target: CaptureTarget, cardText: string) => void;
}

/** insert.js ships in the plugin folder next to dist/ (src/ in tests, dist/ when bundled: both are one level below it).
 *  Read lazily, so a missing file is a clear error at capture time and not a crash at load. */
export const readInsertSource = (): string => fs.readFileSync(new URL('../resources/insert.js', import.meta.url), 'utf8');

export function createRealEngine(c: EngineContext): CaptureEngine {
  return new CaptureEngine({
    runner: nodeProcessRunner,
    insertSource: readInsertSource,
    cliPath: () => { const override = c.cliOverride(); return resolveCliPath({ ...(override ? { override } : {}), platform: c.platform, home: os.homedir(), env: process.env, exists: fs.existsSync }); },
    cliExists: p => fs.existsSync(p),
    isObsidianRunning: () => isObsidianRunning(c.platform, nodeProcessRunner),
    env: () => cliEnvironment(c.platform, process.env),
    onGiveUp: c.onGiveUp,
  });
}
