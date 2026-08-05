# Manage-lists row takeover

Script-owned truth for the Anticipated and Uninterested rows inside the
app's Manage lists drawer, so the drawer stops misreporting quick-list
membership after script quick-toggle writes. The script corrects the
two rows' membership display from its own membership engine and
intercepts their clicks into the existing `performToggle` write path;
every other row stays fully native.

## Why this is the only path

Established across 2026-08-03/04 (diagnosis preserved in
`fresh-membership-sweeps.md`): the drawer renders from the app's
client-side TanStack Query cache and refetches only on the app's own
mutation-driven invalidation (any native list-affecting action) or a
full page load. There is no time-based self-convergence (an earlier
~30s observation was a confounded one-off), and no externally
drivable refresh channel exists: the QueryClient is
Svelte-context-bound and unexported (a same-module import finds no
instance), the app registers no storage or BroadcastChannel listener,
and the service worker does asset caching only. Rejected on
principle: synthetically driving a real native mutation (e.g.
watchlist on+off) to piggyback on the app's own invalidation costs
two real server writes plus activity noise per toggle. Also rejected:
visual-only sync; correcting the bookmark fill without owning the
click makes the app's stale model act opposite to what the corrected
visual promises.

## Probed ground truth (live app, 2026-08-05)

All five formerly open questions were settled by direct probing:

- **The drawer is a body-level singleton.** `div.trakt-drawer` is a
  direct child of `body`, shared by both entry points (summary-page
  actions menu and card popup menu) with identical markup and row
  ordering. It stays mounted when closed, parked at the right
  viewport edge (open: `rect.left` roughly `innerWidth - 400`;
  parked: `rect.left` roughly `innerWidth`), and re-renders its
  content per item on open. Row nodes are reused across items.
- **Row markup.** Content rows are
  `ul > li[role=button][tabindex=0][label][disabled]` holding
  `div.item-icon > svg > path.trakt-bookmark-path` and a
  `p.bold.capitalize.ellipsis` whose textContent is the verbatim
  list name. The Watchlist row comes first with
  `data-variant="secondary"`; personal lists follow in the user's
  list order with `data-variant="primary"`.
- **Membership signal is exactly two attributes.** The `label`
  attribute reads `Add "<title>" to <list>` /
  `Remove "<title>" from <list>` (Watchlist: `to your Watchlist` /
  `from your Watchlist`), and the bookmark path's `fill` is
  `transparent` (non-member) or `currentColor` (member). On
  personal-list rows nothing else changes with membership;
  `data-variant` flips only on the Watchlist row.
- **Rows are patched in place.** Through a native toggle, the app's
  own invalidation refetch, and a full close/reopen cycle, the same
  `li` nodes survived and a foreign `data-*` attribute stamped on a
  row was never stripped. The only childList churn is the app's
  transient spinner inside `div.item-icon` during its own toggles.
- **Capture-phase suppression works.** A document-level
  capture-phase listener calling `stopPropagation`/`preventDefault`
  on events targeting a row fully suppresses the app's delegated
  handler (verified: zero handler activity, no optimistic flip, no
  request). The app's handlers accept untrusted events, which also
  makes the whole surface synthetically drivable in e2e.
- **Native removes confirm; adds do not.** The app's own remove
  flow (Watchlist and personal lists alike) opens a
  `.trakt-modal` confirmation; adds apply immediately.

## Design

All of this lives inside the existing quick-list-toggles IIFE,
sharing `QUICK_LIST_NAMES`, `quickLists`, `slugKeyOf`, and
`performToggle`.

### Drawer item context

The script must know which item the drawer shows to compute
membership. The drawer itself exposes only the item title (inside
each row's `label` attribute), so context is captured at the moment a
"Manage lists" menu row is clicked (the only ways the drawer opens):

- Summary menu: context is `summaryContext()` (pathname-derived
  type/slug, heading title).
- Card popup menu: context is read from a sibling injected quick-list
  entry's `data-qlt-*` attributes (the entries already record card
  identity); fall back to `pendingContext` when entries are absent
  and the context is fresh, else no context.

The captured `drawerContext` persists until replaced by the next
capture. Every correction and interception first cross-checks it:
parse the row label with `/^(Add|Remove) "(.*)" (?:to|from) /` (greedy
group tolerates quotes in titles) and require the parsed title to
equal `drawerContext.title`. Mismatch means the drawer was reopened
for a different item through a path the capture missed; the rows then
stay fully native (fail closed, never wrong-item writes). No
geometry gating is needed: a parked drawer still holds the last
item's rows, which still match the context, and correcting invisible
rows is harmless.

### Ownership predicate

One helper decides both mechanisms. A row is owned when all hold:

- its `p` textContent is a `QUICK_LIST_NAMES` entry,
- its label parses and the title matches `drawerContext.title`,
- `quickLists.getListTarget(name)` resolves (missing or ambiguous
  list leaves the row native),
- membership data is not absent.

The helper returns `{ name, slugKey, member }` (engine truth) or
null. Null means native behavior everywhere.

### Rendering corrections

A drawer renderer joins the feature's existing scan callback. For
each owned row it compares the label verb/preposition and the
bookmark path `fill` against engine membership and rewrites them on
disagreement, preserving the app's exact label format. Both writes
are attribute-only, so they cannot retrigger the shared childList
body observer; the compare-then-write guard is still applied per the
repo idempotence rule. `disabled`, `data-variant`, and row order are
never touched. On scan with stale or absent membership data, call
`quickLists.refreshMembership()` (the menu-open heal precedent), so
an open drawer heals itself without a /discover visit.

### Click interception

One document-level capture-phase listener set (the kebab-listener
pattern) suppresses the full sequence on owned rows: `pointerdown`,
`mousedown`, `pointerup`, `mouseup`, `click`, plus `keydown` for
Enter and Space (rows are `role=button` with dpad navigation, so the
app plausibly acts on keys). Which single event the app's delegated
handler actually consumes was not isolated during probing, and
suppressing the whole sequence removes the question. Every
suppressed event gets `preventDefault`/`stopPropagation`; only
`click` (and qualifying `keydown`) additionally fires the write:
`performToggle({ name, type, slug, title, add: !member })` using the
predicate's state, mirroring `onEntryClick` acting on the rendered
state. Everything downstream is existing machinery: in-flight
dedup, optimistic engine flip (the row corrects on the next scan
frame), marker bump, write-triggered sweep, failure toast plus
revert. Removes are one-click by decision (consistent with the menu
entries); the app's confirm modal never appears for owned rows
because its handler never runs. Non-owned rows keep native behavior
including the confirm flow.

### Reconciliation with the app

When the app refetches (only ever from a same-tab native action),
it patches row attributes in place to its own belief; the next scan
re-asserts engine truth. Worst case is a one-frame flicker on a
surface that was already wrong, and only until the app's next
refetch includes the script's server writes (server truth), after
which both agree and corrections become no-ops. App-side
attribute-only patches do not queue a scan (the shared observer is
childList-only), but every path that makes the app refetch involves
same-tab DOM churn (the native action itself), and the drawer's own
open render is childList churn, so a scan always follows in
practice.

## Failure modes

- Markup drift (label format changes, `p` or `svg path` missing,
  drawer class renamed): parsers fail, predicate returns null, rows
  stay native. Warn once per drift kind (the `warnedTargets`
  pattern). The feature degrades to today's behavior, never to
  wrong writes.
- Context capture misses an open path: title cross-check fails,
  rows stay native. Same degradation. Residual risk, accepted: the
  label carries no year, so a drawer opened through an unobserved
  path for a *different* item with an identical display title would
  pass the cross-check and correct against the wrong slug. This
  requires a missed capture and a same-titled pair back to back;
  every observed open path is captured, so the window is a
  double-fault.
- `getListTarget` de-resolves between render and click:
  `performToggle` already warns and toasts.
- Engine data stale: rows render stale engine truth and heal via
  the sweep, the same posture as menu entries.

## Verification plan

Live e2e per the repo CLAUDE.md constraints (namespaced injected
build covering key, class, and marker-attribute axes; API reads for
server truth). Drawer-specific mechanics learned 2026-08-05: the
drawer survives tool-call boundaries (unlike the popup menus), the
menus' "Manage lists" rows and the drawer's own rows all accept
synthetic click sequences, presence checks must measure
`rect.left` against `innerWidth` because a closed drawer stays in
the DOM, and after a full reload the first trusted click on the
summary kebab may only focus it (a trusted Enter on the focused
button opens the menu reliably).

- Correction: quick-toggle an item via the menu entry, open the
  drawer while the app cache is stale; the two rows must show
  engine truth (this is the bug being fixed). Watchlist and other
  rows untouched (byte-identical attributes).
- Interception: synthetic-click an owned row; verify via
  authenticated API read that the write landed, no confirm modal
  appeared, and the row flipped optimistically; on a forced
  failure (invalid target id in the injected build) verify toast
  plus revert.
- Fail closed: with a mismatched `drawerContext` title, verify
  clicks reach the app (its confirm modal appears on remove; cancel
  it for a zero-write probe) and no attribute corrections occur.
- Reconciliation: perform a native action on a third list while
  owned rows are corrected; verify the rows re-assert within a
  frame and no scan loop occurs (the loop guard being the
  attribute-only write discipline).

`@version` bumps on release (Tampermonkey updates only on version
increase).

## What deliberately does not change

- The membership engine, sweeps, markers, and ledger.
- `performToggle` / `postToggle` and the menu quick-toggle entries.
- The Watchlist row and all non-quick-list rows, including their
  native confirm-on-remove flow.
- Row order and drawer layout; no cloned or injected rows on this
  surface.
