# WorkBar plugins (private)

The private plugins for the Electron WorkBar (`workbar-electron`), ported
from the Swift `workbar-plugins` repo. Each folder under `plugins/` is one
plugin: `plugin.json`, `src/`, `test/`, and the built `dist/index.mjs` the
host loads.

| Plugin | Id | Status |
| --- | --- | --- |
| Workato Changelog | `workatochangelog` | Ported (phase 5) |
| MuleSoft Changelog | `mulesoftchangelog` | Phase 5 |
| Autopilot Pendo Feedback | `pendofeedback` | Ported (phase 5) |
| AI Gateway Budget | `boomibudget` | Phase 5 |
| Obsidian Quick Capture | `quickcapture` | Phase 6 |
| Audio Fix | `audiofix` | Phase 7 (macOS only) |

## Layout: side by side with workbar-electron

Plugins import `@workbar/sdk` straight from a `workbar-electron` checkout
next to this one, and bundle what they use. Clone both into one folder:

```sh
git clone https://github.com/friedricho/workbar-electron
git clone https://github.com/friedricho/workbar-plugins-ts
cd workbar-plugins-ts
pnpm install
pnpm typecheck && pnpm test
pnpm build          # writes plugins/*/dist/index.mjs
pnpm pack           # also writes dist/<id>-<version>.workbarplugin zips
```

Point somewhere else with `WORKBAR_ELECTRON_DIR=/path/to/workbar-electron`.

## Run the plugins in the app (development)

```sh
cd ../workbar-electron
WORKBAR_PLUGINS_DIR=$PWD/../workbar-plugins-ts/plugins pnpm dev
```

## CI

CI checks out both repos. Because `workbar-electron` is private, it needs
one repository secret here: `WORKBAR_ELECTRON_TOKEN`, a fine-grained
personal access token with **read-only Contents** access to
`friedricho/workbar-electron` (GitHub → Settings → Developer settings →
Fine-grained tokens). Add it under this repo's Settings → Secrets and
variables → Actions.

## Rules

- Plugins depend only on `@workbar/sdk` (plus `shared/` helpers in this
  repo). Plugin HTTP goes through `ctx.http`; files can use Node directly.
- Each plugin keeps its Swift id, settings keys and database schema, so the
  importer can carry your data over.
- Test fixtures are byte-exact copies of the Swift ones (`.gitattributes`).
- No secrets in this repo: API keys live in the host's encrypted secrets.
