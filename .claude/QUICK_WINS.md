# Quick wins

Refactors ready to land when time allows; not blocking any feature, but
would improve the codebase meaningfully.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `FEATURES.md`, `BUGS.md`, `PATTERNS.md`). Active
entries are kept inline, organized under thematic `##` sections you
invent as work emerges. When a quick win lands, append a shipped-note
entry to [`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md); do not move
it within this file. Negative-knowledge findings (approaches attempted
and reverted) are first-class promotion candidates from the history
into the relevant `.claude/patterns/<slug>.md` Cautionary tales sections.

Capture shorthand: name the refactor, describe the current smell in a
sentence or two, sketch the preferred shape. A reader should be able to
start work from the entry alone. Anchor entries on identifiers that
survive refactors -- symbol names, entry titles, commit hashes, config
keys -- never on line numbers, plan-phase ordinals, bullet positions,
or temporal qualifiers ("new", "recent"): a precise locator that rots
misleads harder than a coarse one that holds.

## trakt_improved structure

### Wrap score hydration in a named sub-module

The score-hydration subsystem inside `initExternalLinks` (the
`hydrationFetchDue` / `renderPlan` / `mergeHydration` decision
helpers, the `trackedTiles` tracker with `maintainTracker` /
`trackTakenTiles` / `writeTileText`, and the `hydrateScores` /
`hydrateTiles` pair) is a ~200-line, 13-function unit with its own
state living at the same closure depth as chip rendering and id
resolution; it crosses the boundary through six primitives
(`cacheGet`, `cachePut`, `RT_TILE_KINDS`, `fetchRtPage`,
`queueScan`, `warn`). Preferred shape: a named sub-IIFE returning a
curated interface, following the `initListMembership` precedent in
the same file (its `store` / `markers` / `fetchers` / `ledger` /
`sweep` decomposition). Confirmed by revise-code review 2026-08-06
with the precedent verified; deferred to keep freshly e2e-verified
code untouched. Note for the mover: the `.tmp` extract-and-eval
test scripts locate these functions by `function <name>(` search,
which survives a nesting change but not renames.

## History

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
