# EA Assignment Library

The coordinator can now consume Frostbite `PositionAssignmentDefine` XML exports as a local football-knowledge source.

## Raw source

Keep the raw assignment corpus outside Git. The canonical backup currently lives in the project's private Google Drive assignment-library folder. Sync/copy that folder to the development PC before rebuilding the index.

The current corpus contains 5,540 XML assignment definitions across route, blocking, coverage, rush, player-action, hot-route, option-route, screen, and related categories. The importer observed 5,537 unique `positionAssignId` values and preserves the three duplicate IDs instead of silently selecting one.

## Build the local index

From the repository root:

```powershell
node .\scripts\build-ea-assignment-index.cjs "C:\path\to\EA Assignment Library"
```

The default output is:

```text
data/knowledge/ea-assignment-index.json
```

That generated file is intentionally gitignored for now. The source XML corpus and the derived index are local research/runtime data; the parser, normalizer, analysis engines, and tests are version-controlled.

## What is decoded

The index preserves and normalizes evidence from EA's own assignments, including:

- receiver route segments: distance, direction, speed, cuts, delays, get-open actions, and automotion waypoints
- option-route branch asset references and coverage selectors
- pass-block, lead-block, and run-block actions
- blocking techniques and designed gaps
- defensive hook/curl-flat/flat/deep zones
- man-coverage targets, shading, and bracket metadata
- pass-rush direction, blocker reads, stunts, and show-blitz behavior

## Provenance rules

Three levels must remain distinct in the coordinator UI and data:

1. **Verified** — manually/externally verified play-specific knowledge.
2. **EA assignment geometry** — exact decoded assignment data for a receiver/blocker/defender, but not necessarily the complete play.
3. **Coordinator-derived** — a read order or expectation calculated from decoded assignments plus the known defensive coverage/pressure.

A coordinator-derived read order is never labeled as an EA-authored progression.

Route `movementCost` and delay values are also deliberately treated as relative timing until live telemetry calibrates them to seconds.

## Current integration boundary

The legacy flattened playbook `assignment` numbers are **not** the same namespace as
`PositionAssignmentDefine.positionAssignId`. They must never be joined directly.

The authoritative offensive bridge is now:

```text
Formation asset
  -> Set asset
  -> Play asset
  -> ordered Play.positionAssignmentDefines[0..10]
  -> concrete PositionAssignmentDefine assets
```

Use `scripts/build-ea-play-knowledge.cjs` with the completed Pro Style Formation/Set/Play export
and the local assignment index. The builder preserves EA-authored Formation, Set, Play,
alignment, `PlayPassData`, concepts, blocking-scheme references, run-hole metadata, and
all 11 ordered assignment references. Any missing link is reported as unresolved rather
than guessed.

`PlayPassData.percentage` is retained as authored metadata; it is not treated as an exact
QB progression. Read progression remains coordinator-derived until separate evidence
proves an authored order.

The generated `data/knowledge/pro-style-ea-play-knowledge.json` file is gitignored while
its size and publication policy are evaluated. Runtime code should consume the compact
derived index rather than parse hundreds of XML assets at startup.
