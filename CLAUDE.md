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
