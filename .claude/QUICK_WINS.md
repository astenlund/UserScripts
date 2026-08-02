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

- **Write-triggered membership refresh can read server-cache-stale list items.** Observed live 2026-07-28: the corrector sweep fetched `/users/me/lists/{id}/items` about 2s after a successful add and got a response not yet reflecting the write, so the optimistic filled icon reverted to outline until a later interaction healed it. Adjacent to the BUGS.md entry "Cross-tab list adds miss the fade treatment until it eventually self-heals", which covers the out-of-tab side of the same server-cache staleness. Since the fade-on-list-pages feature shipped (Trakt Improved 1.21), fades render on list surfaces too, so a stale corrector read now also reverts the fade itself on threshold-2 surfaces, not just the toggle icon; see the Interactions section in `features/fade-on-list-pages.md`. **Design settled 2026-08-02**, scoped to the script's own quick-toggle writes (native app writes keep current timing; the fetch hook cannot know their expected end state, so only the blind settle delay could help them, rejected as a guess against unbounded cache lag):
  - **Settle bump.** New engine constant `WRITE_SETTLE_MS = 2000` replaces `MUTATION_SETTLE_MS` in both places the write-triggered flavor of `refreshMembership` uses it: the outer delay before forcing the sweep, and the coverage check (`sweepStartedAt < settledAt + WRITE_SETTLE_MS`). `notifyMutation` keeps `MUTATION_SETTLE_MS` at 1000ms; it feeds other consumers and native-write paths.
  - **Confirmed-write ledger.** In-memory `Map` inside the membership engine, keyed `` `${name}:${slugKey}` ``, value `{add, confirmedAt}`, latest write to the same item wins. New surface `quickLists.noteConfirmedWrite(name, slugKey, add)`; `performToggle` calls it only on body-judged success, right before its existing `refreshMembership({ writeTriggered: true })` call. Tab-local and non-persisted on purpose: cross-tab clobbering stays with the adjacent BUGS.md entry, and a reload inside the trust window is left to self-healing.
  - **Commit-time reconciliation in `refresh()`.** When the `listed` fetch fulfills, before `cache.listed` is assigned: prune ledger entries older than `WRITE_TRUST_WINDOW_MS = 30_000`, then check each survivor against the fetched `targets[name]`. Missing target: skip, keep the entry until window expiry. Agreement (`target.slugs.includes(slugKey) === add`): drop the entry, server caught up. Contradiction: patch the expected state onto the fetched record pre-commit and flag the sweep suspect. The rest of the sweep commits normally with a fresh `fetchedAt` (the re-sweep below is the reconciler, not TTL staleness). Running at commit time closes every fetch/write interleaving in one place, subsuming races the `pendingForcedRefresh` bookkeeping does not catch.
  - **Escalating re-sweep.** A suspect commit schedules one delayed forced re-sweep, reusing the write-triggered in-flight handling (`pendingForcedRefresh` if a sweep is running, else `forceRefresh = true` plus `queueRefresh()`). Delay starts at 5s and doubles per suspect commit (5s, 10s, 20s), resets to 5s whenever a new write is noted, one pending retry timer at a time. The 30s window terminates the loop: worst case is the initial sweep plus 3 retries, then server truth wins unconditionally. A suspect read is not a failure: it never touches `lastFailureAt`, backoff, or `rearmedRefresh`.
  - **Shared patch helper.** Extract `patchTargetMembership(target, slugKey, add)` from `applyListToggle`'s inline slugs/fadeSlugs set logic; both the optimistic toggle and the commit-time patch use it, keeping the removal-direction approximation documented at `applyListToggle` in exactly one place.
  - **Verification and landing.** E2e via namespaced injected build with the sandbox `fetchListedData` wrapped to strip the just-written slug for ~15s (deterministic cache-lag simulation), observing: icon/fade hold, escalating retries, reconciliation, and the agree path dropping the ledger entry with no retry. Bump `@version` to 1.26. On landing: archive this entry to history and update the cross-tab BUGS.md entry's prose to note the same-tab side is fixed (no `Requires:` lines reference this entry, so no walk needed).


- **Lift a shared list-URL parser to the shared plumbing section.** trakt_improved.user.js parses `/users/<owner>/lists/<slug>` URLs in two feature IIFEs: the fade feature's `listPathParts` (plus `listKeyKnown`'s owner/slug key building) and the list-counts feature's `parseListPath`/`canonicalKey`. Lift one helper next to `mediaType` in the shared plumbing section and migrate both call sites; this becomes the file's second explicit cross-feature surface after `quickLists`, which is the sanctioned pattern for shared machinery. Flagged by Code Reuse reviewers in the fade-on-list-pages code review (2026-07-30) and deferred to keep the shipping diff minimal. The quick-list fade toggles work (Trakt Improved 1.22) consolidated the fade side into named helpers (`listPartsIn` anchor scanning, `listIdentityKey` owner/slug identity) without crossing IIFEs, so the lift now has richer, already-named pieces to move.

## History

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
