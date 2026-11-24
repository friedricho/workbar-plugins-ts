// Builds every plugin under plugins/: bundles src/index.ts (and the SDK code
// it uses) into dist/index.mjs, the entry plugin.json points at.
// --pack also writes dist/<id>-<version>.workbarplugin (a zip of the files
// the host needs: plugin.json, dist/index.mjs, views/, bin/).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { assertElectronCheckout, repoRoot, sdkSrc } from './paths.mjs';

assertElectronCheckout();
const pack = process.argv.includes('--pack');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const pluginsDir = path.join(repoRoot, 'plugins');

for (const name of fs.readdirSync(pluginsDir).sort()) {
  const dir = path.join(pluginsDir, name);
  const manifestFile = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestFile) || (only.length && !only.includes(name))) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.main !== 'dist/index.mjs') throw new Error(`${name}: plugin.json main must be "dist/index.mjs"`);
  await build({
    entryPoints: [path.join(dir, 'src', 'index.ts')],
    outfile: path.join(dir, 'dist', 'index.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    alias: { '@workbar/sdk': sdkSrc('index.ts') },
    logLevel: 'warning',
    legalComments: 'none',
  });
  // A plugin's page scripts (views/*.js) may be built from TypeScript in src/views/: the host serves views with a strict
  // CSP (script-src 'self'), so the page needs one plain script file, with no imports. Each src/views/*.ts is bundled
  // to views/<name>.js next to the page; that output is a build product (git-ignored), never edited by hand.
  const viewsSrc = path.join(dir, 'src', 'views');
  if (fs.existsSync(viewsSrc)) {
    for (const f of fs.readdirSync(viewsSrc).filter(f => f.endsWith('.ts'))) {
      await build({
        entryPoints: [path.join(viewsSrc, f)],
        outfile: path.join(dir, 'views', f.replace(/\.ts$/, '.js')),
        bundle: true, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'warning', legalComments: 'none',
      });
    }
  }
  console.log(`built ${manifest.id} ${manifest.version}`);
  if (pack) {
    const out = path.join(dir, 'dist', `${manifest.id}-${manifest.version}.workbarplugin`);
    fs.rmSync(out, { force: true });
    // A plugin that declares native helpers must ship them: a package without bin/ would install and then fail at first use.
    if (manifest.helpers && !fs.existsSync(path.join(dir, 'bin'))) throw new Error(`${name}: plugin.json declares helpers but bin/ is missing (run pnpm build:helpers on macOS)`);
    // `resources/` holds files the plugin reads at run time (Quick Capture's insert.js, which runs inside Obsidian).
    const files = ['plugin.json', 'dist/index.mjs', ...['views', 'bin', 'resources'].filter(d => fs.existsSync(path.join(dir, d)))];
    execFileSync('zip', ['-qr', out, ...files], { cwd: dir });
    console.log(`packed ${path.relative(repoRoot, out)}`);
  }
}
