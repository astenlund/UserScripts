# Quick wins (history)

Implemented quick wins, archived from `QUICK_WINS.md` so the active
backlog stays scannable. **Archaeological**: loaded on demand, not at
session start. When a quick win lands, append its entry here rather
than to the active file.

Entries appear in the order they shipped. Write each with enough
context to recover the reasoning from the entry alone: investigation
findings, reverted approaches, benchmarks, the commit or scope it
landed in. Negative-knowledge findings (approaches attempted and
reverted, with the reason) are the most valuable content here for
preventing re-attempts; consider promoting those into the relevant
`.claude/patterns/<slug>.md` Cautionary tales section when touching
the pattern doc, leaving a one-line redirect here if cross-referenced.

## Cross-reference resolution

`/nightshift:ready` does **not** scan this file. When a quick win lands, every
other `**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced
it is edited at the same time to drop the now-satisfied reference. The
active `Requires:` lines therefore describe what is *currently*
blocking. This file is purely archaeological — read it when you want
to know what already shipped or to mine negative-knowledge findings,
not to resolve dependencies.

## Entries

- **initFadeFilters has outgrown single-closure comprehension** (shipped
  2026-08-02, commits f9ef49a and fc9abbb, Trakt Improved 1.25). The
  backlog entry staged the work as banner-grouping first, then a
  considered split of the URL-classification and sweep machinery into
  sibling closures. Shipped shape: the membership cache, cross-tab
  invalidation markers, API sweep fetchers, sweep scheduling, and the
  whole `quickLists` population moved out of `initFadeFilters` into a
  new top-level `initListMembership` closure (between shared plumbing
  and the feature IIFEs), which populates `quickLists` for the toggles
  feature and returns an explicit read surface (`sets`, `listedCounts`,
  `listedKeys`, `quickTargetKey`, `needsRefresh`, `queueRefresh`)
  consumed by the fade feature at exactly four seams (`listKeyKnown`,
  `quickCatFor`, `applyFades`, `scan`). `CATEGORIES` and `QUICK_CATS`
  graduated to shared plumbing next to `QUICK_LIST_NAMES` because both
  closures need them. The dependency audit that justified the split:
  it is one-directional (fade reads membership; membership never calls
  back into fade), so the extraction needed a read surface only. The
  URL-classification family (`cardTarget`, `pageContext`,
  `listPathParts`, the containing-list resolvers) deliberately stayed
  inside the fade closure under a section banner: it serves only the
  fade scan, and a third top-level surface with a single consumer
  would add wiring without a second consumer to justify it; the
  pending "Lift a shared list-URL parser to the shared plumbing
  section" quick win thins it from the shared-plumbing side instead.
  Both closures carry `// ---- <section> ----` banners; the pane
  save-button listener moved next to the filter-pane code it serves.
- **Write-triggered membership refresh can read server-cache-stale list
  items** (shipped 2026-08-03, commits 86274d8..e111375 with review
  fixes autosquashed in, Trakt Improved 1.26). Observed live
  2026-07-28: the corrector sweep fetched `/users/me/lists/{id}/items`
  about 2s after a confirmed add and got pre-write state, reverting the
  optimistic toggle icon (and, since 1.21/1.22, the quick-category
  fade). Shipped shape: a tab-local confirmed-write ledger in the
  membership engine defends body-judged-successful quick-toggle writes
  for a 30s trust window (`WRITE_TRUST_WINDOW_MS`); `refresh()`
  reconciles fetched `listed` data against the ledger at commit time,
  patching contradictions pre-commit via the extracted
  `patchTargetMembership` helper (exact-membership guard INSIDE, so a
  no-op touches neither `slugs` nor `fadeSlugs`, protecting
  season-backed fades on the agree path) and scheduling an escalating
  re-sweep (single timer, 5/10/20s ladder, advances at most once while
  a timer pends, reset on new writes, cancelled when the ledger
  empties). Other writers always win via two drop signals: the page
  fetch hook's successful-native-write branch, and per-entry marker
  snapshots (captured at `noteConfirmedWrite` time, compared with a
  `SELF_MARKER_KEY`/`selfMarkerValue` exemption; `bumpInvalidationMarker`
  reads the live key before overwriting so a foreign bump's evidence is
  acted on before it is destroyed). `WRITE_SETTLE_MS = 2000` widened
  the write-triggered corrector's settle and coverage check
  (`MUTATION_SETTLE_MS` stayed 1000 for `notifyMutation`). Rejected
  alternatives recorded in the design: blind settle lengthening for
  native writes (guess against unbounded lag), patch-time ledgering
  (a failed write would defend phantom state), cache-defeating
  corrector reads (untested; the ledger is lag-agnostic and a buster
  cannot reach server-internal replication lag). Known accepted holes:
  the pre-confirmation window (a sweep committing during the POST round
  trip finds no entry yet; self-heals at the forced sweep), the coarse
  whole-ledger drops, and the read-then-write instant in the bump.
  E2e-verified live 2026-08-03 with a namespaced injected build and
  real writes: both simulated-lag directions held with the designed
  retry ladder and agree-drops, and two no-simulation probes confirmed
  Trakt's real list-items cache caught up within the trust window with
  zero reverts (live-claim probed). Design hardened through a
  6-iteration revise-spec loop whose reviewers caught, pre-code, the
  helper guard-order defect, the marker-drop ordering hole, and the
  null-target prune crash.
- **Lift a shared list-URL parser to the shared plumbing section**
  (shipped 2026-08-03, commit 9fd4c4b, Trakt Improved 1.28). One
  `listPathParts(pathname)` now lives next to `mediaType` in the shared
  plumbing section, the file's second explicit cross-feature surface
  after `quickLists`. The fade feature's segment-based local copy (and
  its now-orphaned `pathSegments` helper) is deleted with its three
  call sites migrated; the list-counts feature's `parseListPath` became
  a thin wrapper adding `kind` and the `canonicalKey` cache key.
  Deliberate behavior delta on the counts side: the shared parser
  carries the fade side's stricter guard rejecting slug `view` (the
  lists-overview tab route), so `/users/me/lists/view` no longer parses
  as a list named "view" that the counts feature would resolve against
  the API and cache as gone. `listKeyKnown` / `canonicalKey` key
  building stayed per-feature: the two features canonicalize
  differently (lowercasing vs. me-resolution via `cache.me`), so only
  the URL shape test was shared. Originally flagged by Code Reuse
  reviewers in the fade-on-list-pages code review (2026-07-30).
  Post-ship review (fixup to 9fd4c4b) found a third copy the entry's
  two-feature framing had hidden: the truncate feature's
  `isTargetListPath` re-implemented the same shape test and was
  migrated onto the shared parser too; behavior-neutral there because
  `TRUNCATE_SLUG` is UUID-suffixed and can never be the rejected
  'view' slug. Textbook instance of the extraction-audit rule:
  sibling duplication co-located with the named trigger stays
  invisible unless audited for explicitly.
