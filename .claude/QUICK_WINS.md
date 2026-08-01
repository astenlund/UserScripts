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

- **Write-triggered membership refresh can read server-cache-stale list items.** Observed live 2026-07-28: the corrector sweep fetched `/users/me/lists/{id}/items` about 2s after a successful add and got a response not yet reflecting the write, so the optimistic filled icon reverted to outline until a later interaction healed it. The write-settle delay (shared `MUTATION_SETTLE_MS`, 1000ms) may be too short for Trakt's list-items caching. Candidate fixes: a longer settle for the write-triggered flavor of `refreshMembership`, or treating a corrector result that contradicts a just-confirmed write (body-judged success) as suspect and scheduling one re-sweep. Adjacent to the BUGS.md entry "Cross-tab list adds miss the fade treatment until it eventually self-heals", which covers the out-of-tab side of the same server-cache staleness. Since the fade-on-list-pages feature shipped (Trakt Improved 1.21), fades render on list surfaces too, so a stale corrector read now also reverts the fade itself on threshold-2 surfaces, not just the toggle icon; see the Interactions section in `features/fade-on-list-pages.md`.

- **initFadeFilters has outgrown single-closure comprehension.** The fade feature's IIFE in trakt_improved.user.js is the file's largest by far and now mixes cache versioning (`normalizeCache`, `CACHE_VERSION`), sweep scheduling (`refresh`, backoff and marker machinery), cross-tab invalidation, page/URL classification (`pageContext`, `listPathParts`, the contribution helpers), filter-pane DOM injection, theme luminance detection, and the shared `quickLists` surface in one closure. Preferred shape: group the concerns under clear section-banner comments first (zero-risk), then consider splitting the URL-classification and sweep machinery into sibling closures wired through explicit surfaces the way `quickLists` already is. Flagged by both Structural Health reviewers in the fade-on-list-pages code review (2026-07-30). The quick-list fade toggles feature (Trakt Improved 1.22) grew the closure further with the containing-list resolver family (`quickCatFor`, `classifyParts`, `listPartsIn`, `laneContainer`, `walkAncestors`, the enlarged `contributionResolver`), strengthening the case for the split; re-flagged by Structural Health reviewers in that feature's code review (2026-08-01).

- **Lift a shared list-URL parser to the shared plumbing section.** trakt_improved.user.js parses `/users/<owner>/lists/<slug>` URLs in two feature IIFEs: the fade feature's `listPathParts` (plus `listKeyKnown`'s owner/slug key building) and the list-counts feature's `parseListPath`/`canonicalKey`. Lift one helper next to `mediaType` in the shared plumbing section and migrate both call sites; this becomes the file's second explicit cross-feature surface after `quickLists`, which is the sanctioned pattern for shared machinery. Flagged by Code Reuse reviewers in the fade-on-list-pages code review (2026-07-30) and deferred to keep the shipping diff minimal. The quick-list fade toggles work (Trakt Improved 1.22) consolidated the fade side into named helpers (`listPartsIn` anchor scanning, `listIdentityKey` owner/slug identity) without crossing IIFEs, so the lift now has richer, already-named pieces to move.

## History

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
