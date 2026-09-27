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

The current Pro Style play-knowledge layer already has receiver-button-to-assignment IDs for a subset of plays. Those IDs are enriched automatically when the local EA index is present, so exact EA route geometry can reach the execution guide.

The remaining major linker is the complete play -> all 11 offensive assignments / all 11 defensive assignments relationship. Once that is recovered, the same library can drive full protection/run-gap analysis, defense-vs-offense simulation, and expected-vs-observed player grading.
