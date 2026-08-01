# Quick-list fade toggles

Status: signed off 2026-08-01 15:38, content: 293a6373

Add two fade categories to the Fade section in
`trakt_improved.user.js`, one per quick list (Anticipated,
Uninterested), mirroring how Watchlisted works today: each is an
independent, set-based toggle over a membership source disjoint from
the generic Listed category. Listed's meaning narrows accordingly to
"on at least one ordinary list": the two quick lists stop counting
toward it, so the three list-flavored toggles control disjoint
sources.

Decisions locked in during design (2026-08-01):

- Mirror-Watchlisted semantics: carve the quick lists out of the
  Listed counts rather than layering add-on toggles whose effect
  vanishes while Listed is on.
- Own-surface exclusion on both the list's detail page and its lane
  on the `/users/me/lists` overview: the toggles are sticky, so
  without the exclusion the Anticipated toggle would fade the entire
  Anticipated page wholesale.
- Both new toggles default on. Combined with the carve-out this
  preserves today's visible behavior for unsaved state: the items
  currently fade via Listed, and after the change they fade via
  their own toggles instead.

## Categories and UI

The category keys derive from the existing user-config surface:
lowercased entries of `QUICK_LIST_NAMES` (a `QUICK_CATS` map of
category key to display name), so a list rename stays a one-place
edit consistent with the standing "names are user config" comment on
`QUICK_LIST_NAMES`. A derived key must stay distinct from the four
built-in keys and from the other quick key; a colliding name is out
of contract for this source-edited config (recorded beside the
existing rename-must-touch-ICONS coupling), not a runtime-handled
case.

`CATEGORIES` itself is untouched. It is the cache-record iteration
list (`normalizeCache`, `categoryStale`/`cacheStale`, and
`buildSets`' record loop all iterate it), and appending record-less
keys to it would make `cacheStale()` permanently true, turning the
scan/refresh pair into an unbounded full-sweep loop (scan queues a
refresh on staleness, a successful refresh queues a scan, and the
backoff only engages on failure). Instead a new `FADE_CATEGORIES`
list (`CATEGORIES` plus the two quick keys, in that order) drives
the fade-facing consumers: `state` and its defaults, the pane
row-building loop, and `applyFades`' category iteration. The Fade
pane therefore reads Started, Watched, Watchlisted, Listed,
Anticipated, Uninterested. Labels and aria-labels come from the
display names: the row loop's label lookup extends to cover the two
quick keys (LABELS gains the two entries from `QUICK_CATS`, or an
equivalent fallback lookup).

`state` defaults both new keys to `true`. The stored-state merge
loop already copies only per-key booleans, so previously saved
filter state loads without migration and the new keys keep their
defaults until the user saves again. The movie-mode hiding of the
Started row is untouched; both new rows show in both modes.

## Membership carve-out and cache format

`fetchListedData` changes in three ways, and a fourth aspect is
recorded as explicitly unchanged:

- **Counts exclusion.** Lists that resolved to an actual quick-list
  target (unique name match) are skipped when building `counts`. A
  name that resolves to zero or multiple lists yields a null target
  as today, and those lists keep counting toward Listed: a broken
  target degrades to current behavior (items still fade via Listed)
  instead of un-fading the items entirely. Fail closed in the
  fade-preserving direction.
- **Target identity.** Each non-null target record gains `key`: the
  same `"<user.ids.slug>/<ids.slug>"` lowercased identity format the
  `keys` array uses, so the containing-list machinery can recognize
  a quick list's own surfaces. A list missing either slug yields
  `key: null` (identity matching then cannot fire; see Failure
  modes).
- **Fade membership.** Each non-null target record gains
  `fadeSlugs`: `itemSlug` mapped over ALL the list's items, so a
  season or episode entry contributes its parent show's slug,
  exactly the mapping `counts` and the watchlisted set use. This,
  not the existing `slugs`, is the fade source. The two fields
  answer different questions: `slugs` is the exact show/movie
  membership the toggle menus need (per the standing comment, a
  season sitting in a list does not make its show a toggle member),
  while the fade must mirror the membership the carve-out removes
  from `counts`, or a show whose only quick-list entry is a season
  would silently stop fading under every toggle, breaking both the
  behavior-preservation claim and the Watchlisted mirror (the
  watchlisted set uses the full `itemSlug` mapping). Two fields,
  two consumers, one fetch.
- **`keys` unchanged.** Quick lists stay in `keys`; the containing
  -list classification handles them before the `keys` test, so their
  presence there is inert.

`CACHE_VERSION` bumps 4 to 5: old targets lack `key` and
`fadeSlugs`, and old `counts` still include quick-list
contributions, so serving either under the new matching logic would
misread. The stamp is top-level,
so the bump empties all category records and targets until the first
post-update sweep, the same brief self-healing window as earlier
bumps.

`buildSets` builds the two new sets from `targets[name].fadeSlugs`
(empty set when the target is null, when the targets map has no
entry for the name at all, as after a `QUICK_LIST_NAMES` source
edit meets a cache written before it, or when `cache.listed` is
absent).
`counts` remains the only Listed derivation, `target.fadeSlugs` the
only quick-list fade derivation, and `target.slugs` the only
toggle-menu derivation; none is derived from another stored field.
`normalizeCache`'s target shape test extends to require `key`
(string or null) and `fadeSlugs` (array).

## Containing-list identity and per-card exclusion

The scan-scoped contribution resolver generalizes from "compute the
Listed contribution" to "resolve the containing list's
`{owner, slug}` per card, then classify once":

- Detail pages: parts come from the URL, page-invariant.
- Overview pages, decided per card by the first matching rule, in
  this order:
  1. Inside a `.trakt-list-summary-card` ancestor (via `closest`,
     cached per summary card as today): parts come from the first
     anchor inside it that parses as a list URL. The landmark match
     is terminal: a summary card none of whose anchors parse yields
     no identification (rule 4's outcome) and never falls through
     to lane resolution, preserving the predecessor's enumerated
     anchorless-summary-card case.
  2. Lane resolution, the machinery absorbed from the backlog entry
     "Lane-identity contribution on overview list lanes": live
     verification of the shipped fade-on-list-pages feature
     (2026-07-30, see `fade-on-list-pages.md`) found overview lanes
     render as plain heading-plus-grid with no summary-card
     wrapper, so without it the chosen overview-lane exclusion
     could never fire. A lane's heading is a
     `.trakt-list-inset-title` element; its parts come from the
     first anchor inside it that parses as a list URL.
     Card-to-heading association is pinned at implementation time
     against the live DOM (the same deferral the predecessor spec
     used for this machinery); the two candidate rules are the
     nearest card ancestor containing exactly one inset heading,
     and the nearest preceding inset heading in document order from
     the card's grid. Whichever is pinned, identification must be
     unambiguous and containment-validated: a walk that reaches a
     container holding multiple inset headings (or none) yields no
     identification, and a candidate heading is accepted only when
     the card lies inside that heading's own lane container, so the
     document-order candidate cannot silently attribute a card to a
     neighboring lane; failed validation likewise yields no
     identification. Unlike rule 1, rule 2 is not terminal: a card
     whose lane walk yields no identification falls through to rule
     3, preserving today's smart-lane contribution path (smart
     lanes carry inset headings whose anchors do not parse as list
     URLs, so a terminal rule 2 would strand them at rule 4).
     Resolution is cached per resolved lane container.
  3. Positive smart-list identification (`insideSmartListCard`'s
     landmark walk, unchanged): contribution 0, no exclusion.
     Contribution-only: rule 3 never qualifies as positive
     identification for the quick-category gate below.
  4. Anything else: contribution 1 for the Listed threshold, and no
     containing-list identification (see the gating rule below).
- `/discover` and smart list views (`/lists/smart/view/*`): no
  containing list, contribution 0, no exclusion, unchanged.

Classification of resolved parts, first match wins:

1. Parts match a quick target's `key` (full-key match for
   username-form URLs; list-slug-part match when owner is `me`,
   which is safe because quick lists are always mine and a foreign
   list sharing the slug arrives in username form and fails the
   full-key match): that card's matching quick category is excluded
   from the set check, and the Listed contribution is 0, since the
   list's items were never counted.
2. Otherwise: the existing owner-`me`-or-`keys` test decides the
   Listed contribution (1 when mine/saved, else 0), no exclusion.

URL-derived parts are lowercased before comparison, as the shipped
threshold machinery already does.

Exclusion polarity inverts when identification fails, so the
overview gets a gating rule. On detail pages the URL always
identifies the containing list and the set check simply skips the
matching quick category. On the overview, identification can fail
(rule 4), and the two halves of the predecessor's fallback point
opposite ways for a set-based category: contribution 1 under-fades
the Listed threshold (safe), but "no exclusion" would let the quick
set check fire on every card of an unidentified quick-list lane and
fade that lane wholesale, exactly the over-fade this feature exists
to prevent, and a markup-drift cause is structural: no sweep heals
it. So on the overview context the quick-category check requires
positive identification: a card fades by a quick category only when
its containing list was positively resolved (rule 1 or 2) to a list
other than that category's own. Rule 3 deliberately does not
qualify: `insideSmartListCard` tests subtree containment at the
nearest landmark-holding ancestor rather than identifying the
card's own lane, so a rule-2 failure could route a quick-list
lane's cards into a spuriously true smart verdict on a page whose
only landmarks sit in a sibling smart lane, and letting that
verdict permit fades would reopen the wholesale over-fade. The cost
is a small accepted anti-goal: smart-list previews on the overview
take no quick-category fade (they still do on `/discover`, detail
pages, and smart list views). Cards not positively resolved by rule
1 or 2 take no quick-category fade at all; under markup drift the
quick toggles degrade to under-fade on the overview, consistent
with the predecessor's positive-identification-only posture.
`/discover` and smart list views have no containing list, and
detail-page identification comes from the URL and cannot fail, so
the gate only ever bites on the overview.

Net effects: the Anticipated toggle never fades the Anticipated
detail page or its overview lane wholesale (same for Uninterested);
the Listed threshold stays correct on quick-list surfaces (their
items are absent from `counts`, so contribution 1 would under-fade);
and lane-identity resolution incidentally fixes the known liked-lane
under-fade (a liked list fails the `keys` match and now correctly
contributes 0 on its lane, where the old blanket fallback
contributed 1).

The pane rows stay visible and functional on excluded surfaces; the
exclusion is silent, same as Listed's existing containing-list
exclusion.

## Optimistic sync

`applyListToggle` today mutates `target.slugs` and patches `counts`
up or down, because quick-list membership counted toward Listed.
After the carve-out the `counts` mutation is wrong (quick lists are
excluded from `counts`), so it goes away wholesale: the optimistic
patch becomes mutate `target.slugs` and `target.fadeSlugs`, rebuild
`sets` via `buildSets(cache)` (the new sets are derived at build
time, so the patch must re-derive them; the other categories
rebuild to identical values), persist without touching `fetchedAt`,
queue a rescan. On add, the written show/movie slug set-adds to
both fields (idempotent; `fadeSlugs` may already hold it via a
season or episode entry). On remove, it deletes from both, and the
`fadeSlugs` half is a deliberate approximation: `fadeSlugs` has set
semantics and cannot record whether a surviving season or episode
entry of the same show independently justifies membership, so in
that rare state a removal transiently un-fades the card until the
post-write corrector sweep restores it. Same posture as today's
counts patch, which is documented in code as deliberately
approximate for exactly this reason (the sweep is authoritative). A
quick-toggle click then flips the fade in the same frame as the
icon, and the post-write corrector sweep replaces the patch with
authoritative data as today. No changes to `membershipStale`,
markers, or the `quickLists` surface contract.

## Failure modes

- Null target (name resolves to zero or multiple lists): empty set,
  checkbox present but inert, the lists keep counting toward Listed.
  Matches the toggles feature's fail-closed convention.
- Target with `key: null` (list missing its own or its owner's
  slug): membership fading works, but own-surface exclusion cannot
  identify the page, so the toggle would fade that list's own
  surfaces. Accepted: Trakt populates both slugs on every observed
  list, and the failure is visible and self-explaining.
- Overview identification failure (markup drift in the summary-card
  or lane-heading landmarks): the positive-identification gate
  withholds the quick-category fade on the overview, and the Listed
  threshold takes the conservative contribution-1 fallback. Both
  directions are under-fade; no over-fade path exists. The same
  landmarks are already load-bearing in the shipped list-counts
  feature, so drift would surface visibly there too.
- Sweep failure: the `listed` record is kept stale wholesale as
  today; both new categories ride the same staleness. Stale
  membership under-fades (a just-added item does not fade until the
  sweep) and the corrector heals it, matching the standing failure
  posture. The known over-fade windows of the threshold machinery
  (rename staleness, remote-removal surplus) are unchanged by this
  feature.

## What deliberately does not change

- **Season and episode cards**: episode cards never fade; season
  cards fade only via watched/started season keys. Quick-list fade
  membership (`fadeSlugs`) holds plain show/movie slugs (a season
  entry contributes its parent show's slug, never a
  `show:<slug>:s<N>` key) and the set check compares the composite
  card key, so season cards do not fade by quick-list membership,
  mirroring Watchlisted exactly.
- **Activation scope**: the page-context classifier, sweep
  mechanics, staleness triggers, and marker machinery are
  untouched. In particular `CATEGORIES` and the record-driven
  staleness machinery keep iterating exactly the four cache-backed
  categories; the quick categories live only in the new
  `FADE_CATEGORIES` list, and `membershipStale()` keeps consulting
  the `listed` record directly.
- **Idempotence**: the fade remains an attribute-only
  `classList.toggle` against computed state, so the shared body
  observer does not retrigger (the file's standing observer-loop
  constraint).

## Verification plan

Live e2e per the repo's established constraints (namespaced
injection with `-e2e` key suffixes and `tff2-*` class/style-id
constants when the installed copy cannot be disabled; page CSP
blocks localhost fetches, so inject through browser tooling; real
scrolls for virtualized grids):

- `/discover`: both new toggles fade and unfade their lists' items;
  an item only on a quick list no longer fades under Listed alone
  (carve-out regression), and fades again when its toggle is on.
- Anticipated detail page: no wholesale fade with the Anticipated
  toggle on; an item there on exactly one ordinary list fades under
  Listed (threshold 1 via contribution 0); same shape for
  Uninterested.
- Overview lanes: the Anticipated lane does not fade wholesale under
  its own toggle; a liked-list lane item on exactly one of my
  ordinary lists now fades under Listed (the absorbed lane-identity
  fix); smart-lane previews take no quick-category fade there (the
  accepted contribution-only anti-goal for rule 3).
- Optimistic path: quick-toggling an item flips its fade immediately,
  before any sweep runs, in both directions.
- Season-entry membership: a show whose only quick-list entry is a
  season (add one natively via Manage lists if none exists) fades
  under that list's toggle, and with the toggle off does not fade
  under Listed (the carve-out removed it from `counts`).
- Cache migration: with a version-4 cache in localStorage, the first
  scan refetches instead of serving targets lacking `key` and
  `fadeSlugs` or un-carved counts.
- Sweep cadence regression: with the feature active on a fade
  surface, exactly one membership sweep runs per staleness trigger
  (no back-to-back sweep loop), confirming the `FADE_CATEGORIES`
  split left `cacheStale()` record-scoped.
- Regression pass on the four existing toggles on `/discover` and a
  list detail page.

`@version` bumps on release (Tampermonkey only updates on a version
increase).

Live verification (2026-08-01, Trakt Improved 1.22, namespaced tff2
build injected alongside the installed 1.21 copy): every bullet above
passed. Highlights: /discover matched the six-category predicate on
all hydrated cards with zero mismatches, and the carve-out
differential was directly observable (quick-only cards kept the 1.21
fade, lost the e2e fade with their toggles off); the Anticipated
detail page (username-form URL, full-key match) showed no wholesale
fade with all rendered fades justified; the optimistic patch flipped
fades in both directions before any sweep; the season-entry case
occurred naturally (one Anticipated show was season-backed only) and
reproduced the documented removal approximation plus the corrector
heal; and 12 seconds of active per-frame scans produced zero API
calls, confirming the FADE_CATEGORIES split leaves `cacheStale()`
record-scoped. One discovery: the overview markup changed since the
predecessor's verification and now renders personal AND liked lists
as `.trakt-list-summary-card` entries whose fanned previews are not
media cards, with section inset anchors that do not parse as list
URLs; rules 1 and 2 (including the absorbed lane-identity machinery)
are therefore dormant robustness on the current shape, the gate
withheld quick fades on every unidentified card (zero quick-only
fades observed), and no traversal-candidate swap was needed. Cache
migration was covered only in the absent-cache direction; the real
v4-to-v5 rejection runs when 1.22 reaches installed copies.

## Interactions with open backlog work

- **Absorbs** the FEATURES.md entry "Lane-identity contribution on
  overview list lanes": the lane resolution is required machinery
  for the chosen overview-lane exclusion and ships here; its index
  entry is folded into this feature and graduates with it.
- BUGS.md "Anticipated/Uninterested quick toggles rarely take
  effect, and failures are silent" contends on `applyListToggle`,
  which this feature simplifies (the counts patch is deleted). The
  optimistic-path verification bullet depends on writes actually
  landing; if the bug bites during verification, diagnose it first
  or exercise the patch directly rather than reading a toggle no-op
  as a regression here. Landing order: this feature first, so the
  diagnosis reasons about the simpler surface.
- QUICK_WINS.md "Write-triggered membership refresh can read
  server-cache-stale list items" and BUGS.md "Cross-tab list adds
  miss the fade treatment": unchanged sweep mechanics, so neither
  is fixed nor worsened; a stale corrector read can now also revert
  a quick-list fade, the same exposure the shipped listed fade
  already has.
- QUICK_WINS.md "initFadeFilters has outgrown single-closure
  comprehension" and "Lift a shared list-URL parser": this feature
  grows the resolver the entries describe; their preferred shapes
  remain valid afterward and neither blocks this work.

## Hardening

- revise-spec graduated 2026-08-01 16:44 at ca9de2b, scope: whole file, content: 16a45211
- handover completed 2026-08-02 01:43 at b7fe68c, scope: whole file, content: 28ca7a95
