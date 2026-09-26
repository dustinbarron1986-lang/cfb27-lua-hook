# CFB27 Lua Hook

Offline Lua scripting runtime, Node SDK, and MMC startup tooling for EA SPORTS
College Football 27 on PC.

> Developer preview `0.2.0-dev.2`. The runtime supports one verified game
> build, is intended only for offline play, and does not include or provide an
> anticheat bypass.

## Project identity

This repository is a fork of Eric Levinson's [`cfb27-lua-hook`](https://github.com/eric-levinson/cfb27-lua-hook),
used as the foundation for the CFB27 Coordinator Mod: an offline play-calling
assistant (`src/football/`, `src/coordinator/`) built on top of the Lua hook's
telemetry and native integration. Upstream remains
https://github.com/eric-levinson/cfb27-lua-hook.

## Project direction

CFB27 Lua Hook is the supported product in this repository:

- a persistent Lua 5.4 runtime loaded through MMC's existing startup proxy;
- exact-build and offline write gates;
- a versioned local named-pipe protocol;
- the reusable `@cfb27/lua-hook` CommonJS SDK;
- the `cfb27lua` developer CLI;
- safe examples and runtime research documentation.

The previous save editor, experimental injection hooks, and raw research tools
are retained under `archive/` for provenance. They are unsupported and excluded
from active packages and releases.

## CLI surface

```text
cfb27lua install
cfb27lua uninstall
cfb27lua status [--json]
cfb27lua run <script.lua>
cfb27lua eval <source>
cfb27lua events [--after <cursor>]
cfb27lua logs [--follow]
cfb27lua doctor
```

These commands are implemented in the `0.2.0-dev.2` developer preview. One-shot
`--json` output is a single object; followed logs use JSON Lines.

## Start here

Build and test the project, close the game, install the startup hook, then
launch through MMC in your offline configuration:

```powershell
npm ci
npm test
cmake -S native -B native/build-active -A x64
cmake --build native/build-active --config Release
node packages/cli/bin/cfb27lua.cjs install
```

The CLI requires explicit game, MMC, and artifact paths through flags or the
environment variables documented in the getting-started guide.

## Coordinator Mod

The Coordinator Mod is an offline play-calling assistant layered on top of the
Lua hook's telemetry. Its main pieces:

- **Hook / telemetry layer** — `native/host/lua_host.cpp` (native DLL) and
  `scripts/autorun.lua` (the Lua runtime script) read live game state and
  publish `coord.state` telemetry over the hook's named-pipe protocol.
- **Live coordinator orchestration** — `src/coordinator/live-coordinator.cjs`
  consumes that telemetry via the SDK, reduces raw ticks into completed plays
  (`src/coordinator/snap-reducer.cjs`), and drives the football engine.
- **Football engine** — `src/football/engine.js`, wiring together scoring,
  memory, and recommendation modules.
- **Knowledge layer** — `src/football/knowledge/` (concept/coverage rules,
  catalog resolution, curated play knowledge).
- **Offense/defense recommendation layer** — `src/football/recommendation/`
  (play selection, defensive selection/eligibility, execution advice).
- **Playbooks / reference data** — `src/football/playbooks/` and
  `data/playbooks/` (playbook catalog, verified play/formation membership,
  play-location index).
- **UI** — `src/football/ui/coordinator-window.js`, a local browser window
  showing recommendations and letting you switch playbooks.
- **Persistence/runtime state** — `src/football/db/coordinator-database.js`
  backs playbook storage; see "Runtime data" below for what is and isn't
  version-controlled.

### Normal run flow

Boot the game through MMC in your offline configuration as usual. The
installed hook auto-loads `scripts/autorun.lua` — **do not run `autorun.lua`
manually**; it is not a standalone script and is only meant to execute inside
the game process via the installed hook.

Once the game is running, start the coordinator separately:

```powershell
node .\scripts\run-coordinator.cjs
```

This opens the coordinator UI and begins following live telemetry from the
game.

### Runtime data

`data/coordinator.db`, `data/coordinator-config.json`, and `.vscode/` are
local, machine-specific runtime/editor state and are intentionally not
version-controlled (see `.gitignore`). Static football/playbook reference
data under `data/knowledge/` and `data/playbooks/` — including the large
`cfb27-playbook-index.json` and `pro-style-play-knowledge.json` — *is*
version-controlled: it is deterministic project knowledge, not runtime
output, and in some cases its original generator/source inputs no longer
exist, making the committed copy the only surviving version.

### Tests

```powershell
npm test
```

runs the full suite via `scripts/run-tests.cjs`, which auto-discovers every
`tests/*.test.cjs` and `packages/*/test/*.test.cjs` file, including the
coordinator/football tests. `npm run check` runs static syntax checks over
the SDK/CLI/native-adjacent scripts.

### Known architecture issue

Live per-game/per-snap performance history is currently **in-memory only**
(`src/football/memory/performance-store.js`) and resets whenever the
coordinator process restarts. Persistent cross-session performance/tendency
storage is a known future coordinator architecture task, not something this
revision implements.

## Safety boundary

- Close CFB27 before installing or restoring startup files.
- Writes require an exact recognized executable build.
- Writes are blocked when a real EA/Javelin anticheat process is present.
- Memory writes are compare-before-write and readback-verified.
- Do not disable or allowlist antivirus protection for this project.
- Keep scripts and integrations offline.

## Documentation

- [Lua API](docs/lua-api.md)
- [Getting started](docs/getting-started.md)
- [CLI reference](docs/cli.md)
- [Protocol v1](docs/protocol.md)
- [Safety boundary](docs/safety.md)
- [Runtime verification](docs/research/runtime-verification.md)
- [Legacy hook findings](docs/research/legacy-hook-findings.md)
- [Archive policy](archive/README.md)
- [Repository redesign](docs/superpowers/specs/2026-07-11-cfb27-lua-hook-repository-design.md)
- [Implementation plan](docs/superpowers/plans/2026-07-11-cfb27-lua-hook-repository.md)

## Development

Requirements:

- Windows x64
- Node.js 20 or later
- CMake 3.24 or later
- Visual Studio 2022 C++ build tools

```powershell
npm install
npm test
npm run check
```

Native build and release instructions will live under `docs/development/`.

## License

[MIT](LICENSE)
