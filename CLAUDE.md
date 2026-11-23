# WorkBar private plugins — notes for Claude sessions

TypeScript ports of the private Swift plugins for the Electron WorkBar.
The plan is the "WorkBar Electron Migration Plan" doc; host conventions are
in workbar-electron's CLAUDE.md.

## Layout

- `plugins/<name>/` — one plugin: `plugin.json` (schema v2, `main`
  `dist/index.mjs`), `src/index.ts` (default export `definePlugin(...)`,
  plus a `create…(options)` factory for tests), `test/` (vitest; fixtures
  copied byte-exact from the Swift repo).
- `shared/` — helpers bundled into plugins (atomic vault writes).
- `tools/build.mjs` — esbuild bundles each plugin (`--pack` zips it).
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
