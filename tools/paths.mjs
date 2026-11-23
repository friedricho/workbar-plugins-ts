// Where the sibling workbar-electron checkout lives (side-by-side layout):
// ../workbar-electron next to this repo, or WORKBAR_ELECTRON_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const electronDir = path.resolve(process.env.WORKBAR_ELECTRON_DIR ?? path.join(repoRoot, '..', 'workbar-electron'));
export const sdkSrc = (file = 'index.ts') => path.join(electronDir, 'packages', 'sdk', 'src', file);

export function assertElectronCheckout() {
  if (!fs.existsSync(sdkSrc())) {
    console.error(`workbar-electron not found at ${electronDir}.\nClone it next to this repo (or set WORKBAR_ELECTRON_DIR):\n  git clone https://github.com/friedricho/workbar-electron ${path.join(repoRoot, '..', 'workbar-electron')}`);
    process.exit(1);
  }
}
