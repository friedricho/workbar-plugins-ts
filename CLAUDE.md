# WorkBar private plugins — notes for Claude sessions

TypeScript ports of the private Swift plugins for the Electron WorkBar.
The plan is the "WorkBar Electron Migration Plan" doc; host conventions are
in workbar-electron's CLAUDE.md. **Start with `../workbar-electron/docs/HANDOFF.md`**:
it has the remaining work (Audio Fix, Claude Spend, Quick Capture, live
checks) and the parts of the plan those need.

## Layout

- `plugins/<name>/` — one plugin: `plugin.json` (schema v2, `main`
  `dist/index.mjs`), `src/index.ts` (default export `definePlugin(...)`,
  plus a `create…(options)` factory for tests), `test/` (vitest; fixtures
  copied byte-exact from the Swift repo).
- `shared/` — helpers bundled into plugins (atomic vault writes).
- `tools/build.mjs` — esbuild bundles each plugin (`--pack` zips it).
- `tools/build-helpers.mjs` — builds `plugins/<name>/helper/` (Swift, macOS only)
  into `bin/` as a universal, ad-hoc-signed binary; `pnpm pack` runs it first.
- The SDK is imported from `../workbar-electron/packages/sdk/src` (side by
  side; `WORKBAR_ELECTRON_DIR` overrides).

## Rules

- Keep each plugin's Swift id, settings keys and SQLite schema, and make
  dedup keys (fingerprints) byte-identical: the importer copies Swift data.
- Port the Swift tests case for case; add tests for anything new.
- HTTP only through `ctx.http`. Notes are written with `shared/atomic-write`.
- Pin dev dependencies exactly (at least two weeks old).

## Commands

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
WORKBAR_PLUGINS_DIR=$PWD/plugins  # point the host here for a dev run
```

## Handoff

- 2026-11-23 — Phase 5 started: repo scaffold, shared atomic writer, build
  tool; Workato Changelog ported (57 tests; live scrape verified through the
  CLI). Needs the WORKBAR_ELECTRON_TOKEN secret for CI. Next: MuleSoft
  Changelog, Pendo Feedback, AI Gateway Budget.
- 2026-11-23 — MuleSoft Changelog ported (PR #2; 85 tests incl. the shared
  ones; live run through the host + CLI with capped page limits: index
  phase, history walk and incremental run all verified). Health now
  refreshes "next run" after the host re-plans (the same fix went into
  Workato, PR #1). Next: Pendo Feedback, AI Gateway Budget.
- 2026-11-23 — Pendo Feedback ported (PR #3; 64 tests incl. shared; golden
  reports byte-exact; fingerprints pinned against the Swift basis). Needs
  workbar-electron PR #6 (path fields with pick: 'save') for the output-file
  picker. Live check in the real host with a bogus key: net.fetch reached
  app.pendo.io, 401 → red health + inbox, key absent from logs/settings.
  Next: AI Gateway Budget.
- 2026-11-23 — AI Gateway Budget ported (PR #4, folder gateway-budget, id
  boomibudget; 44 tests incl. shared). The corporate token helper runs via
  node:child_process execFile (an external program, not a native module);
  on Windows there is no helper, so only a saved token works. Live check:
  catch-up fetch at launch, helper missing → sign-in line + error health.
  Phase 5 plugins are all ported; next is phase 6 (needs the Windows
  phase 0 run first).
- 2026-11-23 — PRs #1–#4 merged into main (all four phase 5 plugins).
  Next work moves to the Mac; see workbar-electron/docs/HANDOFF.md.
- 2026-11-23 — Audio Fix ported (plugin `audiofix`, darwin only). The
  CoreAudio listener and format toggle are a Swift helper (`helper/`, JSON
  lines, protocol in `src/protocol.ts`); settle delay, recency guard and the
  2 s/5 s retry schedule are TypeScript (`RepairGate` tests ported case for
  case + plugin tests with a fake helper; mutation-checked). Verified on the
  Mac: the owner installed the package in the packaged app and a real repair
  of the monitor worked (exit criterion met). Build with `pnpm run pack`
  (plain `pnpm pack` is pnpm's own command).
- 2026-11-23 — Claude Spend ported (plugin `claudespend`, darwin only; Windows
  later: DPAPI + paste-a-cookie fallback). Chromium crypto in `cookie-crypt.ts`
  pinned with independent vectors (python hashlib PBKDF2, `openssl enc` AES,
  `sha256sum` digest) and mutation-checked; the cookie DB copy is read with
  `ctx.storage.openReadOnly`, the Keychain through `/usr/bin/security` (reader
  injectable; tests use stub executables, never the real Keychain), the temp
  copy is deleted on every call. Pasted override = plugin secret
  `sessionCookie` (a valid secret name). Settings keys, snapshot shape, band
  memory and job id (`claudespend.poll`) match Swift. Fixtures are byte-exact
  copies. Verified on the Mac: the owner installed the package in the packaged app
  and it works against the real Keychain and claude.ai (exit criterion met;
  the Keychain prompt names `security`, not WorkBar).
- 2026-11-23 — Quick Capture ported (plugin `quickcapture`, needs workbar-electron
  SDK 3.1.0 for `ctx.panel`). Engine in `src/`: `board.ts` (parser; differentially
  tested against the verbatim `resources/insert.js` on 6000 generated boards),
  `writers.ts` (Obsidian CLI tier via `obsidian eval`, atomic direct writer, +1/+3/+6 s
  clobber verifier), `engine.ts` (tier choice, one FIFO queue), `due-date.ts` (moment.js
  formats, `@{…}` tokens, picker text surgery; moment's FIXED two-digit-year pivot),
  `editor.ts` (DOM-free state machine for the bar: picker, type-ahead, key routing),
  `view-model.ts`, `index.ts` (hotkey, settings, panel conversation, capture action).
  The page is `views/panel.html|css` + `src/views/panel.ts` bundled to the git-ignored
  `views/panel.js` (the host serves views with `script-src 'self'`); page scripts are
  typechecked by `tsconfig.views.json` (DOM lib). `build.mjs` also packs `resources/`.
  Tests never touch the real Obsidian CLI or a real vault (mock runner, temp folders);
  `e2e/capture.e2e.mjs` drives the real host against a temp vault. Verified by the owner
  on the Mac in the installed app: capture via the direct tier on a copy of the board and
  via the CLI tier on the real board. The Swift hotkey (Carbon key code + modifiers) is
  converted once with `carbonToAccelerator` and never overwrites a user-chosen accelerator.
  Known gaps: the due-date token is plain text in the field (no chip styling); Windows
  untested. The installed app's first `open -a` after a swap did not start it (starting
  the binary did); Pendo Feedback timed out once in `activate()` right after the swap and
  recovered on restart (watch for a repeat).
