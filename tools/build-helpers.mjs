// Builds native helpers (Swift, macOS only) into each plugin's bin/.
// A plugin opts in by having helper/Package.swift; the product name is the
// executable that plugin.json's `helpers` points at. Universal (arm64 + x86_64).
// Run before `pack`; skipped with a note on other OSes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot } from './paths.mjs';

if (process.platform !== 'darwin') {
  console.log('helpers: Swift helpers build on macOS only; skipping');
  process.exit(0);
}
const pluginsDir = path.join(repoRoot, 'plugins');
for (const name of fs.readdirSync(pluginsDir).sort()) {
  const pkg = path.join(pluginsDir, name, 'helper');
  if (!fs.existsSync(path.join(pkg, 'Package.swift'))) continue;
  execFileSync('swift', ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', pkg], { stdio: 'inherit' });
  const products = path.join(pkg, '.build', 'apple', 'Products', 'Release');
  const binDir = path.join(pluginsDir, name, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const f of fs.readdirSync(products)) {
    const src = path.join(products, f);
    if (!fs.statSync(src).isFile() || (fs.statSync(src).mode & 0o111) === 0 || f.includes('.')) continue;
    fs.copyFileSync(src, path.join(binDir, f));
    fs.chmodSync(path.join(binDir, f), 0o755);
    // Apple silicon refuses unsigned code; an ad-hoc signature is enough for a locally installed helper.
    execFileSync('codesign', ['--force', '--sign', '-', path.join(binDir, f)], { stdio: 'inherit' });
    console.log(`helper ${name}/bin/${f}`);
  }
}
