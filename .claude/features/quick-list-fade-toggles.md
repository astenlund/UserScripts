# Quick-list fade toggles

Status: design approved 2026-08-01 (chat sign-off)

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
`QUICK_LIST_NAMES`. `CATEGORIES` appends the two keys after
`listed`; the Fade pane renders rows in `CATEGORIES` order, so the
section reads Started, Watched, Watchlisted, Listed, Anticipated,
Uninterested. Labels and aria-labels come from the display names via
the existing row-building loop.

`state` defaults both new keys to `true`. The stored-state merge
loop already copies only per-key booleans, so previously saved
filter state loads without migration and the new keys keep their
defaults until the user saves again. The movie-mode hiding of the
Started row is untouched; both new rows show in both modes.

## Membership carve-out and cache format

`fetchListedData` changes in three ways:

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
- **`keys` unchanged.** Quick lists stay in `keys`; the containing
  -list classification handles them before the `keys` test, so their
  presence there is inert.

`CACHE_VERSION` bumps 4 to 5: old targets lack `key`, and old
`counts` still include quick-list contributions, so serving either
under the new matching logic would misread. The stamp is top-level,
so the bump empties all category records and targets until the first
post-update sweep, the same brief self-healing window as earlier
bumps.

`buildSets` builds the two new sets from `targets[name].slugs`
(empty set when the target is null or `cache.listed` is absent).
`counts` remains the only Listed derivation and `target.slugs` the
only quick-list derivation; no second derivation is stored.
`normalizeCache`'s target shape test extends to require `key` to be
a string or null.

## Containing-list identity and per-card exclusion

The scan-scoped contribution resolver generalizes from "compute the
Listed contribution" to "resolve the containing list's
`{owner, slug}` per card, then classify once":

- Detail pages: parts come from the URL, page-invariant.
- Overview pages: parts come from the first anchor that parses as a
  list URL, looked up per summary card (`.trakt-list-summary-card`,
  cached per card as today) or per lane heading
  (`.trakt-list-inset-title`, cached per lane container). The lane
  resolution is new machinery this feature absorbs from the backlog
  entry "Lane-identity contribution on overview list lanes":
  live verification of the shipped fade-on-list-pages feature
  (2026-07-30, see `fade-on-list-pages.md`) found overview lanes
  render as plain heading-plus-grid with no summary-card wrapper, so
  without lane resolution the chosen overview-lane exclusion could
  never fire. Positive identification only; a lane or summary card
  with no parsable anchor keeps the conservative fallback
  (contribution 1, no exclusion).
- Smart-list previews and `/discover`: no containing list,
  contribution 0, no exclusion, unchanged.

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
patch becomes mutate `target.slugs`, rebuild `sets` via
`buildSets(cache)` (the new sets are derived at build time, so the
patch must re-derive them; the other categories rebuild to identical
values), persist without touching `fetchedAt`, queue a rescan. A
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
- Sweep failure: the `listed` record is kept stale wholesale as
  today; both new categories ride the same staleness. Stale
  membership under-fades (a just-added item does not fade until the
  sweep) and the corrector heals it, matching the standing failure
  posture. The known over-fade windows of the threshold machinery
  (rename staleness, remote-removal surplus) are unchanged by this
  feature.

## What deliberately does not change

- **Season and episode cards**: episode cards never fade; season
  cards fade only via watched/started season keys. Quick-list exact
  membership holds only show/movie slugs and the set check compares
  the composite card key, so a show on Anticipated does not fade its
  season cards, mirroring Watchlisted and Listed.
- **Activation scope**: the page-context classifier, sweep
  mechanics, staleness triggers, and marker machinery are untouched.
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
  fix).
- Optimistic path: quick-toggling an item flips its fade immediately,
  before any sweep runs, in both directions.
- Cache migration: with a version-4 cache in localStorage, the first
  scan refetches instead of serving keyless targets or un-carved
  counts.
- Regression pass on the four existing toggles on `/discover` and a
  list detail page.

`@version` bumps on release (Tampermonkey only updates on a version
increase).

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
