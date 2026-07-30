# Fade on list pages

Extend the fade filters feature in `trakt_improved.user.js` from its
current `/discover`-only scope to list surfaces, with the twist that a
list's own page must not count that list toward the "listed" fade:
every item on the page trivially belongs to the list being viewed, so
without an exclusion the Listed toggle would fade the entire grid.

Design approved 2026-07-30. Approach chosen: counts threshold (see
"Rejected alternative" at the end for the per-list-sets option and why
it lost).

## Route facts (verified live 2026-07-26, recorded in memory notes)

- Bare `/lists` 404s; the original index-entry title mentioning it was
  wrong.
- Lists overview: `/users/me/lists`, with tab views at
  `/users/me/lists/view/personal`, `/view/liked`, `/view/collaborations`.
  These pages embed `div.trakt-card` media previews inside each list's
  summary card (`.trakt-list-summary-card`); smart list cards use
  `.trakt-smart-list-header` and are a different wrapper.
- List detail: `/users/<owner>/lists/<slug>`, exactly 4 path segments;
  `me` is accepted as owner. The slug may embed a uuid.
- Smart list views: `/lists/smart/view/<slug>`. Smart lists are dynamic
  filter queries, not real lists; no membership endpoint exists.
- `GET /users/me/lists` returns ALL personal and saved (liked) lists in
  one call, each with `ids.slug` and `user.ids.slug` (canonical owner).

## Activation scope

`fadingActive()` (currently `location.pathname` under `/discover`)
grows into a page-context classifier. Fading activates on:

- `/discover*`: existing behavior, unchanged.
- List detail pages: `/users/<owner>/lists/<slug>` (4 segments,
  segment 3 not `view`), any owner.
- Smart list views: `/lists/smart/view/<slug>`.
- Overview surfaces uniformly: exactly `/users/me/lists`, plus
  `/users/me/lists/view` and anything deeper under it. No per-tab
  special-casing. This is not a prefix rule: a 4-segment
  `/users/me/lists/<slug>` with a non-`view` slug is an own-list
  detail page, classified above, with different threshold scoping
  (page-wide rather than per containing card).

Everywhere else the scan keeps its current behavior: strip stale fade
classes, inject nothing, trigger no refreshes.

## The listed rule becomes threshold-based

Core insight: `cache.listed.counts[slug]` already stores how many of
my lists (personal plus saved) contain each item. On any surface where
a displayed card provably belongs to the containing list, "on at least
one list other than this one" reduces to `counts[slug] >= 2`. The page
itself supplies the membership relation the aggregate cache lacks.

Today `applyFades` checks the listed category via a Set built from the
keys of `counts` (effectively `counts >= 1`). The listed check changes
to `(counts[slug] || 0) >= threshold`, where the threshold is:

- **2** on a list detail page whose list is mine or saved. Decided by
  URL owner segment `me`, or by `<owner>/<slug>` from the URL matching
  a `keys` entry in the cache (next section). The saved-list case
  matters: `/users/me/lists` returns saved lists too, so viewing
  someone else's list that I have liked must also exclude it, or every
  item on it fades.
- **2** on overview/view pages for cards inside a
  `.trakt-list-summary-card` (the containing list is by construction
  personal or liked, both in my collection; no identity lookup
  needed). Decided per card via `closest('.trakt-list-summary-card')`.
- **1** for everything else: `/discover`, foreign list detail pages,
  smart list views, and overview cards not inside a list summary card
  (e.g. previews under smart list cards, which confer no real
  membership).

Watched/Started/Watchlisted checks are unchanged and
threshold-independent. All four toggles apply on the new surfaces per
the same stored state.

Staleness behaves fail-safe in both directions that matter: an item
just added to the viewed list but absent from a stale cache
under-fades (no false fade), and the sweep self-heals it.

## Cache addition and version bump

`fetchListedData` additionally returns `keys`: an array of
`"<user.ids.slug>/<ids.slug>"` strings for every fetched list, built
from data the sweep already fetches (no new API calls).
`normalizeCache` validates the new field alongside `counts` and
`targets`; `CACHE_VERSION` bumps 3 to 4 so pre-existing caches refetch
rather than serving records without `keys`. The `quickLists` shared
surface (membershipState, getListTarget, bumpInvalidationMarker) is
untouched.

URL-to-key comparison should lowercase both sides defensively; slugs
are canonically lowercase but the URL segment is user-visible input.

## What deliberately does not change

- **Fade section UI**: `ensureFadeSection` already no-ops when no
  filter pane (`div.trakt-display-section`) exists on the page. If
  list pages lack the pane, the stored toggles from `/discover`
  govern silently; if the pane exists there, the section appears
  natively. No new UI.
- **Season/episode cards**: episode cards never fade (lanes like
  Continue Watching surface unwatched episodes on purpose); season
  cards fade only via watched/started `show:<slug>:s<N>` keys.
  `counts` holds plain slugs, so season cards never fade by listed.
  Same semantics as `/discover` today.
- **Failure posture**: absent or stale counts under-fade, never
  over-fade, matching the sweep's existing keep-stale-data-on-failure
  behavior.
- **Idempotence**: the fade is `classList.toggle` compared against
  computed state, an attribute-only write, so the shared body observer
  does not retrigger (the file's standing observer-loop constraint).

## Refresh side effect (intended)

Activating on list pages means the scan's staleness triggers
(`forceRefresh`, markers, TTL) now also fire there, so list pages get
the same membership freshness as `/discover`. This widens where sweeps
start but changes no sweep mechanics.

## Verification plan

Live e2e per the repo's established constraints (disable the installed
Tampermonkey copy for the run, inject through browser tooling since
page CSP blocks localhost fetches, use real scrolls because card grids
are virtualized):

- Own list detail: only items on at least one other list fade.
- Foreign (unsaved) list detail: plain rule, my listed items fade.
- Saved list detail (someone else's list I liked): exclusion applies.
- Smart list view: plain rule.
- Overview root and `/view/*` tabs: previews fade only for items on a
  list other than their containing list.
- `/discover` regression pass: behavior unchanged.

`@version` bumps 1.20 to 1.21 (Tampermonkey only updates on a version
increase).

## Rejected alternative: per-list membership sets

Storing each list's slug set keyed by list identity would compute the
exclusion exactly, without the "card belongs to its containing list"
premise, and would stay correct even if list detail pages ever grow
non-member lanes (related items, recommendations). Rejected because
the premise is structural rather than incidental on the observed
pages, and the cost is real: the cache would duplicate every list's
item set where it now stores one aggregate count per slug. If live
verification finds non-member media cards on a list detail page, the
fix is to scope the threshold-2 rule to the list's item-grid
container, not to switch approaches.
