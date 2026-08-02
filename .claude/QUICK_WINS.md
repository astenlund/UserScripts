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

## trakt_improved.user.js

- **Lift a shared list-URL parser to the shared plumbing section.** trakt_improved.user.js parses `/users/<owner>/lists/<slug>` URLs in two feature IIFEs: the fade feature's `listPathParts` (plus `listKeyKnown`'s owner/slug key building) and the list-counts feature's `parseListPath`/`canonicalKey`. Lift one helper next to `mediaType` in the shared plumbing section and migrate both call sites; this becomes the file's second explicit cross-feature surface after `quickLists`, which is the sanctioned pattern for shared machinery. Flagged by Code Reuse reviewers in the fade-on-list-pages code review (2026-07-30) and deferred to keep the shipping diff minimal. The quick-list fade toggles work (Trakt Improved 1.22) consolidated the fade side into named helpers (`listPartsIn` anchor scanning, `listIdentityKey` owner/slug identity) without crossing IIFEs, so the lift now has richer, already-named pieces to move.

## History

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
