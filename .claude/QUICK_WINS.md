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

## Membership engine

- **Split the list-membership engine closure into sub-scopes.** The
  `initListMembership` closure in trakt_improved.user.js spans
  roughly 790 lines carrying five concerns: API sweep fetchers
  (fetchAll/fetchPage/bustedGet and the busting latch), the
  cache-and-sets store, the confirmed-write ledger and its
  reconciliation, the cross-tab marker machinery, and the sweep
  triggers (mutation hook, storage listener, triggerForcedSweep).
  Confirmed as sprawl by the 1.29 revise-code loop; deferred there as
  too large for an inline fix. Preferred shape: sibling sub-closures
  or plain sections with narrow explicit interfaces, following the
  shipped initFadeFilters closure-split precedent (archived in
  QUICK_WINS_HISTORY.md). Land it next time the engine is touched
  substantially, not as a standalone churn commit.

## History

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
