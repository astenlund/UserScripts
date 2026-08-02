# Fade on list pages

Status: signed off 2026-07-30 18:01, content: 310b2e80

Extend the fade filters feature in `trakt_improved.user.js` from its
current `/discover`-only scope to list surfaces, with the twist that a
list's own page must not count that list toward the "listed" fade:
every item on the page trivially belongs to the list being viewed, so
without an exclusion the Listed toggle would fade the entire grid.

Design approved 2026-07-30. Approach chosen: counts threshold (see
"Rejected alternative" at the end for the per-list-sets option and why
it lost).

## Route facts (verified live 2026-07-26)

- Bare `/lists` 404s; the original index-entry title mentioning it was
  wrong.
- Lists overview: `/users/me/lists`, with tab views at
  `/users/me/lists/view/personal`, `/view/liked`, `/view/collaborations`.
  These pages embed `div.trakt-card` media previews inside each list's
  summary card (`.trakt-list-summary-card`), whose header carries a
  title anchor with the list's `/users/<owner>/lists/<slug>` URL as
  href; smart list cards use `.trakt-smart-list-header` and carry no
  such anchor.
- Whether collaboration lists appear in `GET /users/me/lists` is
  unverified; the threshold rule below is correct under either
  resolution, so nothing hinges on settling it.
- List detail: `/users/<owner>/lists/<slug>`, exactly 4 path segments;
  `me` is accepted as owner. The slug may embed a uuid.
- Smart list views: `/lists/smart/view/<slug>`. Smart lists are dynamic
  filter queries, not real lists; no membership endpoint exists.
- `GET /users/me/lists` returns personal lists only, each with
  `ids.slug` and `user.ids.slug` (canonical owner). Liked lists live
  in the separate `GET /users/me/likes/lists` and are NOT in the
  corpus (corrected 2026-07-30 during live verification; an earlier
  note claimed saved lists rode along). Their absence is handled
  correctly by the identity rule: a liked list fails the `keys` match
  and contributes 0, which matches its zero contribution to `counts`.

## Activation scope

`fadingActive()` (currently `location.pathname` under `/discover`)
grows into a page-context classifier. Fading activates on:

- `/discover*`: existing behavior, unchanged.
- List detail pages: `/users/<owner>/lists/<slug>` (4 path segments,
  slug segment not `view`), any owner.
- Smart list views: `/lists/smart/view/<slug>`.
- Overview surfaces uniformly: exactly `/users/me/lists`, plus
  `/users/me/lists/view` and anything deeper under it. No per-tab
  special-casing. This is not a prefix rule: a 4-segment
  `/users/me/lists/<slug>` with a non-`view` slug is an own-list
  detail page, classified above, with different threshold scoping
  (page-wide rather than per containing card). Overview activation
  stays pinned to the `me` form deliberately: no foreign or
  username-form overview route is verified to exist, so activating
  there would be speculative; if the app ever exposes one, the
  per-card identity rule in the threshold section extends to it
  unchanged. An own overview reached via a hypothetical
  username-form URL would simply not activate, an accepted anti-goal
  rather than an oversight.

Everywhere else the scan keeps its current behavior: strip stale fade
classes, inject nothing, trigger no refreshes. In particular the
watchlist page (`/users/me/watchlist`) stays out of scope as an
explicit anti-goal: it reproduces the trivial-membership twist for
the Watchlisted toggle (every item there is watchlisted), so
activating it would need a watchlist-exclusion analog of the
containing-list rule. Deferred until a fade is actually wanted there.

## The listed rule becomes threshold-based

Core insight: `cache.listed.counts[slug]` already stores how many of
my lists (personal plus saved) contain each item. Where a displayed
card provably belongs to its containing list, subtracting that list's
own contribution to `counts` turns the aggregate into "on at least
one list other than this one": the page supplies the membership
relation the aggregate cache lacks.

Today `applyFades` checks the listed category via a Set built from the
keys of `counts` (effectively `counts >= 1`). The listed check changes
to `(counts[key] || 0) >= threshold`, where `key` is the same
composite card key the other categories already use (so season cards,
whose `show:<slug>:s<N>` keys never appear in `counts`, keep never
fading by listed), and the threshold follows one rule everywhere:

    threshold = 1 + (the containing list's contribution to counts)

The containing list is the list the displayed card provably belongs
to: the viewed list on a detail page, the list whose summary card
wraps the preview on an overview page. Its contribution to `counts`
is 1 when it is in the `/users/me/lists` corpus (personal or saved),
0 otherwise. Concretely:

- Detail pages: contribution is 1 iff the URL owner segment is `me`,
  or `<owner>/<slug>` from the URL matches a `keys` entry (next
  section). A foreign list, liked or not, fails the test and
  contributes 0, which is correct either way: its items were never
  counted into `counts`, so the plain `counts >= 1` check reads "on
  one of my lists" there. (The design originally excluded liked
  lists defensively on the belief they rode along in the corpus;
  live verification showed they do not, so the exclusion is simply
  never needed for them.)
- Overview pages, decided per card by the first matching rule:
  1. Inside a `.trakt-list-summary-card` (via `closest`) whose title
     anchor parses as `/users/<owner>/lists/<slug>`: the same
     owner-`me`-or-`keys` test as detail pages.
  2. Inside a `.trakt-list-summary-card` without a parsable anchor:
     contribution 1, the conservative direction (at worst an
     under-fade).
  3. Positively identified as a smart-list preview (its wrapper
     carries the `.trakt-smart-list-header` landmark, per the route
     facts; the exact traversal is pinned at implementation time
     against the live DOM): contribution 0, since a smart list is a
     dynamic query and confers no membership.
  4. Anything else: contribution 1. Contribution 0 is granted only
     on positive identification, never by mere absence of a
     recognized wrapper: were absence enough, a drift of the
     summary-card class would drop every preview to threshold 1 and
     fade the whole overview grid, a structural over-fade no sweep
     heals. Under this fallback, drift produces at worst an
     under-fade, consistent with the failure posture; and
     `.trakt-list-summary-card` is already load-bearing in the
     shipped list-counts feature, so drift would surface visibly
     there too.
- `/discover` and smart list views: no containing list, contribution
  0, existing behavior unchanged.

Live verification (2026-07-30) found that the overview surfaces
render list lanes as plain heading-plus-grid, with NO
`.trakt-list-summary-card` wrapping around the media cards: rules
1-3 above are dormant robustness against future markup, and rule 4's
conservative contribution 1 governs every lane card. That is exact
for personal-list lanes (the containing list is in the corpus) and
under-fades liked-list lanes for items on exactly one of my lists
(observed on 2 of 30 cards; direction matches the accepted failure
posture). That refinement shipped with the quick-list fade toggles
feature (Trakt Improved 1.22, see `quick-list-fade-toggles.md`),
whose generalized resolver adds lane-heading resolution with
containment validation. Its live verification (2026-08-01) found
the overview markup changed again: lists render as
`.trakt-list-summary-card` entries whose fanned previews are not
media cards, so both the summary-card rules and the lane
resolution are dormant robustness on the current shape.

This per-card identity rule replaces an earlier blanket
threshold-2-inside-summary-cards rule, which rested on the premise
that every summary card's list is personal or liked. The
`/view/collaborations` tab breaks that premise: under the blanket
rule, a collaboration list absent from the `/users/me/lists` corpus
would cause a structural under-fade on that tab (an item on the
collab list plus exactly one of my own lists would never fade, and
no sweep could heal it). The identity rule is immune to the
unverified corpus question: a collab list in the corpus matches
`keys` and is excluded like any mine/saved list; one absent from the
corpus fails the match and contributes 0, exactly matching its
contribution to `counts`.

Watched/Started/Watchlisted checks are unchanged and
threshold-independent. All four toggles apply on the new surfaces per
the same stored state. On list surfaces those three can legitimately
dim large portions of a grid (a list of already-watched favorites,
say). Deliberate: the fade is information, hover still reveals, and
the toggles remain controllable from the `/discover` filter pane.

Staleness on `counts` stays fail-safe: an item just added to the
viewed list but absent from a stale cache under-fades (no false
fade), and the sweep self-heals it. A just-saved list is equally
safe: `keys` and `counts` come from the same fetch and go stale
together, so a list not yet in `keys` has items not yet in `counts`
either, and its threshold-1 classification produces exactly the
right fades. The realistic over-fade path is a rename of a list
already in the collection: the URL carries the new slug while the
stale `keys` entry holds the old one, so the detail page is
classified foreign at threshold 1 while stale `counts` still include
the list's items, and the whole grid fades until the next sweep
records the new identity. Accepted because it is transient and
bounded: a rename made in this account's own session trips the app's
invalidation markers and sweeps promptly, while a saved foreign list
renamed by its owner produces no local signal and heals at the
15-minute cache TTL instead. A stale surplus is the second over-fade
path, newly exposed by the threshold comparison (under the old
`counts >= 1` check a surplus was invisible): a removal performed on
another device leaves `counts` one too high until the TTL sweep, so
an item remotely removed from its one other list keeps fading on the
viewed list's page for up to 15 minutes. Local removals trip the
fetch hook or markers and heal promptly. The only other over-fade
path is the theoretical missing-slug edge noted in the cache
section; the Failure posture bullet below is scoped accordingly.

## Cache addition and version bump

`fetchListedData` additionally returns `keys`: an array of
`"<user.ids.slug>/<ids.slug>"` strings for every fetched list, built
from data the sweep already fetches (no new API calls). A list
missing either slug contributes no key and its detail page falls to
threshold 1; Trakt populates both slugs on every observed list, so
this is a theoretical edge, noted for its over-fade direction.
`normalizeCache` validates the new field alongside `counts` and
`targets`; `CACHE_VERSION` bumps 3 to 4 so pre-existing caches refetch
rather than serving records without `keys`. The version stamp is
top-level, so the bump empties all four category records and the
quick-toggle targets, not just listed: every surface runs on no data
(nothing fades, quick-toggle menus show their no-data state) until
the first post-update sweep completes. Same brief self-healing window
as any earlier version bump.

The `quickLists` shared surface keeps its API (membershipState,
getListTarget, refreshMembership, applyListToggle,
bumpInvalidationMarker) but is not untouched internally: there are two
derivation sites for the listed membership view, `buildSets` and
`applyListToggle` (which, after optimistically mutating `counts` in
place, re-derives `sets.listed = new Set(Object.keys(counts))`,
mirroring `buildSets`). With the threshold rule the listed check
consults `counts` directly, so `sets.listed` and both lines deriving
it go away; the optimistic patch keeps working unchanged, because
mutating `counts` in place is the patch and the queued rescan re-reads
it. `buildSets` keeps building the other three categories' sets.

URL-to-key comparison should lowercase both sides defensively; slugs
are canonically lowercase but the URL segment is user-visible input.

## What deliberately does not change

- **Fade section UI**: `ensureFadeSection` has three outcomes, all
  acceptable here. No filter pane (`div.trakt-display-section`) on
  the page: silent no-op, the stored `/discover` toggles govern. A
  pane matching `/discover`'s markup: the section appears natively.
  A pane whose inner markup diverges: `buildFadeSection` returns
  null and warns; widened activation makes this branch newly
  reachable on per-frame scans, so the warn gains a fire-once guard
  as part of this feature (console hygiene, no behavior change). If
  the section does inject on a list page, the Started row's
  visibility follows `activeMode()`, which reads `/discover`-scoped
  inputs; accepted as the same inheritance the stored-toggles
  posture already endorses. No new UI either way.
- **Season/episode cards**: episode cards never fade (lanes like
  Continue Watching surface unwatched episodes on purpose); season
  cards fade only via watched/started `show:<slug>:s<N>` keys.
  `counts` holds plain slugs, so season cards never fade by listed.
  Same semantics as `/discover` today.
- **Failure posture**: absent or stale counts under-fade, never
  over-fade, matching the sweep's existing keep-stale-data-on-failure
  behavior. The over-fade exceptions are the rename-staleness window
  and the remote-removal surplus described in the threshold section
  (both transient, TTL-bounded) and the theoretical missing-slug edge
  in the cache section.
- **Idempotence**: the fade is `classList.toggle` compared against
  computed state, an attribute-only write, so the shared body observer
  does not retrigger (the file's standing observer-loop constraint).
- **Stale cards after in-page removal**: removing an item from the
  very list being viewed (via the script's quick toggles) leaves the
  app's card on screen while the containing-list premise no longer
  holds for it; if the item remains on exactly one other list, it
  under-fades until navigation re-renders the grid. Accepted: the
  card itself is stale app UI at that point, the direction is
  under-fade, and no cached state is corrupted.

## Side effects of widened activation (intended)

Activating on list pages means the scan's staleness triggers
(`forceRefresh`, markers, TTL) now also fire there, so list pages get
the same membership freshness as `/discover`. This widens where sweeps
start but changes no sweep mechanics.

It also means `injectStyles()` installs its document-wide sheet from
a session that never visits `/discover`, including the rule that
neutralizes the app's native `is-deemphasized` watched dimming. That
neutralization is the fade feature's existing premise (the script's
fade supersedes the app's, governed by the Watched toggle) and is
already the steady state for any session that touched `/discover`,
since the sheet persists across SPA navigation; it is recorded here
because widened activation makes it reachable without `/discover`.

## Verification plan

Live e2e per the repo's established constraints (disable the installed
Tampermonkey copy for the run, inject through browser tooling since
page CSP blocks localhost fetches, use real scrolls because card grids
are virtualized):

- Own list detail: only items on at least one other list fade.
  (Verified live 2026-07-30, username-form URL via keys match: 10
  cards faded solely by second-list membership, 10 single-list cards
  unfaded, zero mismatches.)
- Foreign list detail, liked or unsaved: plain rule, my listed items
  fade. (Verified live 2026-07-30 on a liked list: contribution 0,
  zero mismatches. Liked lists are not in the corpus, so no
  exclusion arises for them.)
- Smart list view: plain rule. (Verified live 2026-07-30; bare
  /lists/smart/view stays inactive.)
- Overview root and `/view/*` tabs: previews fade only for items on a
  list other than their containing list.
- Collaborations tab (`/view/collaborations`): an item on a
  collaboration list plus exactly one of my own lists fades under
  either resolution of the corpus question: a collab list absent
  from `/users/me/lists` fails the `keys` match (threshold 1,
  counts 1), one present in it matches (threshold 2, counts 2).
  (Not exercisable in the 2026-07-30 verification: the account has
  no collaboration lists; the rule needs no per-tab code either
  way.)
- Quick-toggle optimistic path on a threshold-2 surface: toggling an
  item onto a second list fades it immediately, toggling it back off
  unfades it immediately, both before any sweep runs (the
  `applyListToggle` counts mutation is the mechanism that must
  survive the `sets.listed` removal).
- Cache migration: with a version-3 cache in localStorage, the first
  scan refetches instead of serving keyless records; quick-toggle
  menus show their no-data state only until that first sweep lands.
- Negative activation: on the watchlist page (`/users/me/watchlist`)
  and other out-of-scope routes, the scan strips stale fade classes
  and applies none, injects no Fade section, and starts no membership
  sweeps (the global style sheet may already be present from an
  earlier active page; that alone is not a failure).
- `/discover` regression pass: behavior unchanged.

`@version` bumps 1.20 to 1.21 (Tampermonkey only updates on a version
increase).

## Interactions with open backlog work

Two backlog entries touched the same membership machinery:
QUICK_WINS.md's "Write-triggered membership refresh can read
server-cache-stale list items" (shipped 2026-08-03 in Trakt Improved
1.26, archived in QUICK_WINS_HISTORY.md: it added `WRITE_SETTLE_MS`
and a confirmed-write ledger with commit-time reconciliation, keeping
`MUTATION_SETTLE_MS` at 1000ms) and BUGS.md's still-open "Cross-tab
list adds miss the fade treatment until it eventually self-heals"
(out-of-tab invalidation). This feature widened where sweeps start
and where fades render but changed no sweep mechanics, and the
landing order played out as recorded: this feature first, so the
staleness work tuned the final shape of the listed derivation once.

A third entry contends on the exact function this feature edits:
BUGS.md's "Anticipated/Uninterested quick toggles rarely take effect,
and failures are silent" concerns the write path feeding
`applyListToggle`, whose `sets.listed` re-derivation line this
feature deletes. The verification plan's quick-toggle bullet depends
on that path actually performing writes; if the bug bites during
verification, diagnose it first (or verify the optimistic mechanism
by mutating `counts` directly in the console) rather than reading a
toggle no-op as a regression of this feature. The landing order
stays this feature first: the deletion simplifies the surface the
bug's diagnosis must reason about.

## Rejected alternative: per-list membership sets

Storing each list's slug set keyed by list identity would compute the
exclusion exactly, without the "card belongs to its containing list"
premise, and would stay correct even if list detail pages ever grow
non-member lanes (related items, recommendations). Rejected because
the premise is structural rather than incidental on the observed
pages, and the cost is real: the cache would duplicate every list's
item set where it now stores one aggregate count per slug. If live
verification finds non-member media cards on a list detail page, the
fix is to scope the containing-list exclusion to the list's item-grid
container, not to switch approaches.

## Hardening

- revise-spec graduated 2026-07-30 19:15 at d3c0e6c, scope: whole file, content: 9b4f5765
- handover completed 2026-07-31 00:25 at e4eff14, scope: whole file, content: 78692bf6
