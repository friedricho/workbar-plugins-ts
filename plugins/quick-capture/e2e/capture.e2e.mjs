// End to end, against the REAL host and the REAL built plugin, with everything isolated:
//   * a temp user-data folder (never ~/Library/Application Support/WorkBar),
//   * a temp vault holding a copy of a board (never the real vault),
//   * the plugin loaded from a temp copy of its built files.
// The real Obsidian CLI is NEVER run: the plugin is pointed at a CLI path that does not exist, and the engine only tries
// the CLI when its binary exists, so every capture takes the DIRECT tier (asserted below). Run by hand:  node plugins/quick-capture/e2e/capture.e2e.mjs   (needs ../workbar-electron built)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = path.dirname(new URL(import.meta.url).pathname);
const pluginSrc = path.resolve(here, '..');
const hostDir = path.resolve(process.env.WORKBAR_ELECTRON_DIR ?? path.join(here, '../../../../workbar-electron'), 'apps/host');
const electronBin = createRequire(path.join(hostDir, 'package.json'))('electron');
// Playwright is not a dependency of this repo; borrow the host's own (the same way the SDK is borrowed).
const { _electron: electron } = createRequire(path.join(hostDir, 'package.json'))('@playwright/test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-e2e-'));
const userData = path.join(tmp, 'userdata'); const vault = path.join(tmp, 'vault'); const plugins = path.join(tmp, 'plugins');
fs.mkdirSync(vault, { recursive: true });
fs.writeFileSync(path.join(vault, 'Board.md'), '---\nkanban-plugin: board\n---\n\n## Backlog\n\n- [ ] old\n\n## Today\n\n- [ ] first\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","new-card-insertion-method":"append","date-format":"MM-DD-YY"}\n```\n%%\n');
// A copy of the built plugin, so the real one is never touched.
const dest = path.join(plugins, 'quickcapture');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['plugin.json', 'dist', 'views', 'resources']) fs.cpSync(path.join(pluginSrc, f), path.join(dest, f), { recursive: true });
// Pre-seed settings so it is configured and its hotkey cannot collide with the real one on this Mac.
fs.mkdirSync(path.join(userData, 'settings'), { recursive: true });
fs.writeFileSync(path.join(userData, 'settings', 'quickcapture.json'), JSON.stringify({ vaultPath: vault, boardPath: 'Board.md', column: 'Today', hotkey: 'Control+Alt+Shift+F11', activateOnOpen: false, obsidianCliPath: '/nonexistent/obsidian-cli-e2e' }));

const results = [];
const check = async (name, fn) => { try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };

const launch = () => electron.launch({
  executablePath: electronBin, args: [hostDir],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, WORKBAR_E2E: '1', WORKBAR_E2E_PANEL_BLUR_GRACE_MS: '3600000', WORKBAR_USER_DATA: userData, WORKBAR_PLUGINS_DIR: plugins },
});
let app = await launch();
const status = () => app.evaluate(() => globalThis.__workbar.snapshot().find(v => v.id === 'quickcapture'));
const panelPage = async () => { for (let i = 0; i < 100; i++) { const w = app.windows().find(x => x.url().includes('workbar-plugin://quickcapture/')); if (w) return w; await new Promise(r => setTimeout(r, 100)); } throw new Error('panel page never loaded'); };
const visible = () => app.evaluate(() => globalThis.__workbar.panelVisible('quickcapture'));
const wait = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out: ' + fn.toString().slice(0, 80)); await new Promise(r => setTimeout(r, 60)); } };
const board = () => fs.readFileSync(path.join(vault, 'Board.md'), 'utf8');

try {
  await wait(async () => (await status())?.status === 'active');
  const page = await panelPage();
  await check('plugin is active and healthy (hotkey registered, configured)', async () => assert.deepEqual((await status()).health, { kind: 'ok' }));
  await check('the page has only the panel bridge, and no Node', async () => {
    assert.deepEqual(await page.evaluate(() => Object.keys(window.workbarPanel).sort()), ['hide', 'onMessage', 'onShown', 'post']);
    assert.deepEqual(await page.evaluate(() => [typeof window.workbar, typeof window.require, typeof window.process]), ['undefined', 'undefined', 'undefined']);
  });
  await check('the page script loaded under the strict CSP (the field exists and is wired)', async () => {
    assert.equal(await page.evaluate(() => !!document.getElementById('field')), true);
  });

  await app.evaluate(() => globalThis.__workbar.perform('quickcapture', 'scan-boards')); // exercises an action through the host
  await check('"Find boards" finds the temp board through the real host', async () => assert.match(await app.evaluate(() => globalThis.__workbar.perform('quickcapture', 'scan-boards')), /Board\.md/));

  // Show the bar through the plugin's own menu entry (the global hotkey itself needs OS focus, which a test cannot rely on).
  await app.evaluate(() => globalThis.__workbar.click('quickcapture', 'capture'));
  await wait(visible);
  await check('the bar opens, focused, in editing mode, 46 px tall', async () => {
    await wait(async () => (await page.evaluate(() => document.activeElement?.id)) === 'field');
    assert.equal(await page.evaluate(() => document.getElementById('bar').dataset.mode), 'editing');
    const b = await app.evaluate(() => globalThis.__workbar.panelBounds('quickcapture'));
    assert.equal(b.height, 46); assert.equal(b.width, 700);
  });
  await check('the key hint reads as the Swift bar did', async () => assert.equal(await page.evaluate(() => document.getElementById('hint').textContent), '⏎ to add · ⇧⏎ newline · ⎋ cancel'));

  await check('typing "@" opens the date picker, and the bar grows to fit it', async () => {
    await page.locator('#field').pressSequentially('Pay rent @');
    await wait(async () => !(await page.evaluate(() => document.getElementById('picker').hidden)));
    assert.match(await page.evaluate(() => document.querySelector('.picker-title').textContent), /^[A-Z][a-z]+ \d{4}$/);
    await wait(async () => (await app.evaluate(() => globalThis.__workbar.panelBounds('quickcapture'))).height > 200);
    assert.equal(await page.evaluate(() => document.getElementById('hint').textContent), '⏎ pick date · ⎋ close');
  });
  await check('"tom" narrows to Tomorrow; Enter picks it in the board’s MM-DD-YY format and closes the picker (no submit)', async () => {
    await page.locator('#field').pressSequentially('tom');
    await wait(async () => (await page.evaluate(() => document.querySelectorAll('.ahead-row').length)) === 1);
    await page.locator('#field').press('Enter');
    await wait(async () => await page.evaluate(() => document.getElementById('picker').hidden));
    const v = await page.locator('#field').inputValue();
    assert.match(v, /^Pay rent @\{\d\d-\d\d-\d\d\}$/);
    assert.equal(board().includes('Pay rent'), false); // not submitted yet
  });
  await check('Backspace deletes the whole due-date token as one unit', async () => {
    await page.locator('#field').press('Backspace');
    assert.equal(await page.locator('#field').inputValue(), 'Pay rent ');
    await page.locator('#field').pressSequentially('@');
    await page.locator('#field').press('Enter'); // picks today from the grid
    assert.match(await page.locator('#field').inputValue(), /^Pay rent @\{\d\d-\d\d-\d\d\}$/);
  });

  let bytesBefore = board();
  await check('Enter submits: the card lands on the real board file (direct tier), appended after "first", and the bar shows the flash', async () => {
    await page.locator('#field').press('Enter');
    await wait(async () => /Pay rent @\{/.test(board()));
    const out = board();
    assert.ok(out.indexOf('- [ ] first') < out.indexOf('- [ ] Pay rent'), 'appended after the last card');
    assert.ok(out.indexOf('- [ ] Pay rent') < out.indexOf('%% kanban:settings'), 'inside the Today section');
    assert.ok(out.startsWith('---\nkanban-plugin: board\n---\n'), 'frontmatter untouched');
    await wait(async () => /^Added to Today · due /.test(await page.evaluate(() => document.getElementById('flash').textContent)));
  });
  await check('the bar closes itself after the flash', async () => { await wait(async () => !(await visible()), 4000); });
  await check('no temp files are left in the vault', async () => assert.deepEqual(fs.readdirSync(vault).sort(), ['Board.md']));

  await check('a second capture starts with an EMPTY field (every show is fresh)', async () => {
    await app.evaluate(() => globalThis.__workbar.click('quickcapture', 'capture'));
    await wait(visible);
    await wait(async () => (await page.evaluate(() => document.getElementById('bar').dataset.mode)) === 'editing');
    assert.equal(await page.locator('#field').inputValue(), '');
  });
  await check('Shift+Enter inserts a newline (the field grows) and Enter submits a multi-line card', async () => {
    await page.locator('#field').pressSequentially('line one');
    await page.locator('#field').press('Shift+Enter');
    await page.locator('#field').pressSequentially('line two');
    assert.equal(await page.locator('#field').inputValue(), 'line one\nline two');
    await wait(async () => (await app.evaluate(() => globalThis.__workbar.panelBounds('quickcapture'))).height >= 60);
    await page.locator('#field').press('Enter');
    await wait(async () => board().includes('- [ ] line one\n  line two\n'));
  });

  await check('Escape in the field hides the bar without writing', async () => {
    await wait(async () => !(await visible()), 4000);
    const before = board();
    await app.evaluate(() => globalThis.__workbar.click('quickcapture', 'capture'));
    await wait(visible);
    await wait(async () => (await page.evaluate(() => document.activeElement?.id)) === 'field');
    await page.locator('#field').pressSequentially('never saved');
    await page.locator('#field').press('Escape');
    await wait(async () => !(await visible()));
    assert.equal(board(), before);
  });
  await check('Enter on empty text just dismisses (nothing written)', async () => {
    const before = board();
    await app.evaluate(() => globalThis.__workbar.click('quickcapture', 'capture'));
    await wait(visible);
    await wait(async () => (await page.evaluate(() => document.activeElement?.id)) === 'field');
    await page.locator('#field').press('Enter');
    await wait(async () => !(await visible()));
    assert.equal(board(), before);
  });

  await check('a missing column is LOUD: the bar stays open with the reason, the typed text is kept, and the board is untouched', async () => {
    // The host keeps a plugin's settings in memory, so a changed file takes effect on the next launch (as for a real user).
    await app.close();
    fs.writeFileSync(path.join(userData, 'settings', 'quickcapture.json'), JSON.stringify({ vaultPath: vault, boardPath: 'Board.md', column: 'Nope', hotkey: 'Control+Alt+Shift+F11', activateOnOpen: false, obsidianCliPath: '/nonexistent/obsidian-cli-e2e' }));
    app = await launch();
    await wait(async () => (await status())?.status === 'active');
    const p2 = await panelPage();
    const before = board();
    await app.evaluate(() => globalThis.__workbar.click('quickcapture', 'capture'));
    await wait(visible);
    await wait(async () => (await p2.evaluate(() => document.activeElement?.id)) === 'field');
    await p2.locator('#field').pressSequentially('keep my words');
    await p2.locator('#field').press('Enter');
    try { await wait(async () => (await p2.evaluate(() => document.getElementById('bar').dataset.mode)) === 'error'); }
    catch (e) {
      const snap = await p2.evaluate(() => ({ mode: document.getElementById('bar').dataset.mode, field: document.getElementById('field').value, hint: document.getElementById('hint').textContent, err: document.getElementById('error-text').textContent, flash: document.getElementById('flash').textContent }));
      const logs = await app.evaluate(() => globalThis.__workbar.logs().filter(l => l.source === 'quickcapture').slice(-6).map(l => `${l.level}: ${l.message}`));
      throw new Error(`stuck: ${JSON.stringify(snap)} | plugin log: ${JSON.stringify(logs)} | health ${JSON.stringify((await status()).health)}`);
    }
    assert.match(await p2.evaluate(() => document.getElementById('error-text').textContent), /“Nope” column no longer exists/);
    assert.equal(await p2.locator('#field').inputValue(), 'keep my words');
    assert.equal(await visible(), true);
    assert.equal(board(), before);
    assert.equal((await status()).health.kind, 'warning');
  });
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const [verdict, name, why] of results) console.log(`${verdict}  ${name}${why ? '\n      ' + why : ''}`);
const failed = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
