# Manage-lists row takeover

Status: signed off 2026-08-06 21:43, content: 2c914614

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
visual promises. Also rejected: cloning or injecting replacement
rows (the menu entries' own technique): the drawer re-renders its
content per open and patches the same row nodes in place, so
injected nodes would be churned or duplicated on every open, while
in-place attribute corrections are idempotent and observer-safe.

## Probed ground truth (live app, 2026-08-05)

The formerly open questions were settled by direct probing:

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
  list order with `data-variant="primary"`. The `disabled`
  attribute was recorded as present on content rows; its value
  dynamics across opens were not recorded (see the transient-states
  note below).
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
  This survival is surface-specific: the repo-wide working rule
  that app-managed nodes shed foreign attributes on re-render (the
  buildChip comment, the rt-page-bridge closure tracking) holds for
  surfaces the app re-creates; drawer rows are patched in place,
  never re-created, which is exactly what this probe established.
- **Capture-phase suppression works.** A document-level
  capture-phase listener calling `stopPropagation`/`preventDefault`
  on events targeting a row fully suppresses the app's delegated
  handler (verified: zero handler activity, no optimistic flip, no
  request). The app's handlers accept untrusted events, which also
  makes the whole surface synthetically drivable in e2e.
- **Native removes confirm; adds do not.** The app's own remove
  flow (Watchlist and personal lists alike) opens a
  `.trakt-modal` confirmation; adds apply immediately.

Observed but not yet characterized (user report, 2026-08-06): the
quick-list rows have shown two distinct transient anomalies between
the first and second drawer open after a page load: a greyed state
(visually disabled) on the first open with normal rendering on the
second, and, separately, an occasional wrong background color on
either open. Presumed cause is the app rendering rows before its
membership query resolves. The greyed state's carrier (which
attribute or class produces it; note the always-present `disabled`
attribute above, whose value dynamics were not recorded), whether
that state also gates the app's own click handler, and what
produces the wrong background color are unprobed; the
pre-implementation probe in the Verification plan settles them
(live-claim: probed 2026-08-07; the transients did not reproduce
and no carrier was identified, see the re-probe record below).

Re-probed 2026-08-07 (pre-implementation probe, items (a)-(d)):

- Title equality (probe a): CONFIRMED byte-equal per entry point
  (summary heading vs drawer label title; card kebab aria-label
  title vs drawer label title).
- Greyed state and wrong background (probes b, c): did not
  reproduce across multiple first and second opens on two page
  loads and both surfaces; rows rendered with `disabled="false"`,
  parseable labels, and settled backgrounds from the first sampled
  frame. The greyed-state carrier is therefore unidentified: the
  clearing sub-step is dropped per its fallback, and the transients
  remain uncharacterized user observations (plausibly
  network-timing dependent).
- Pre-resolution labels (probe b): parseable with the correct title
  from the first sample in every observed open.
- Drawer lifecycle (supersedes the parked-singleton and cross-open
  row-reuse claims above for the current app version): the drawer
  UNMOUNTS on dismissal (a stamped data attribute never survived a
  close/reopen cycle, and `div.trakt-drawer` is absent from the DOM
  between opens, verified on both surfaces). Each open creates
  fresh row nodes, so cross-item node reuse does not occur; the
  stale-item marker arm and probe (d)'s fill-repaint question are
  moot for this version (the fill-normalization sub-step is NOT
  selected), and the marker machinery is retained as cheap defense
  in case the app reverts to a persistent drawer. A welcome
  corollary: every open mounts a new drawer subtree, which is
  childList churn the shared body observer sees, so the initial
  correction scan on open is mechanism-backed, not ambient. The
  in-place patching of rows during a native toggle within one open
  session (the 2026-08-05 observation) still holds.
- Menu row text: both surfaces render the row as the exact string
  "Manage lists…" (trailing U+2026 ellipsis), not "Manage lists".
- Menu rows did not respond to synthetic click sequences in this
  session (trusted clicks were required to open both the menus and
  the drawer), unlike the 2026-08-05 record; e2e drives these
  surfaces with trusted clicks.
- Spinner markup (probed 2026-08-07 during the user-authorized
  native toggle pair): the app inserts `div.loading-indicator`
  into the row's `div.item-icon` and REMOVES the bookmark `svg`
  for the toggle's duration (about 700 ms), then restores it. The
  spinner contributes a `path` of its own and the row `label` is
  untouched throughout, so the ownership predicate's generic
  `path` check and label parse both hold across the window: the
  spinner cannot register a `drawer-markup` candidate at all, and
  the spinner re-arm arm is unnecessary rather than merely
  dropped. (This also empirically vindicates the generic `path`
  selector over the class-qualified form.)

## Design

All of this lives inside the existing quick-list-toggles IIFE,
sharing `QUICK_LIST_NAMES`, `quickLists`, `slugKeyOf`, and
`performToggle`.

### Drawer item context

The script must know which item the drawer shows to compute
membership. The drawer itself exposes only the item title (inside
each row's `label` attribute), so context is captured at the moment
a "Manage lists" menu row is clicked (the only observed open paths,
per the 2026-08-05 probe; the fail-closed posture below covers any
path the capture misses). The capture is a document-level
capture-phase click listener (the kebab-listener pattern; capture
phase is load-bearing here, because the card-popup source reads
sibling injected entries that the app tears down when the popup
closes, so the read must precede the app's own handler), and a row
qualifies when it is a menu-row `li` in either menu surface (the
summary actions menu or the card popup menu) whose trimmed
textContent equals the exact string "Manage lists…" (trailing
U+2026 ellipsis, verified on both surfaces 2026-08-07):

- Summary menu: context is `summaryContext()` (pathname-derived
  type/slug, heading title).
- Card popup menu: context is read from a sibling injected quick-list
  entry's `data-qlt-*` attributes (the entries already record card
  identity); fall back to `pendingContext` when entries are absent
  and the kebab click that stamped it is at most
  `DRAWER_CONTEXT_FRESH_MS` (15000 ms, a new constant) old, else no
  context. The existing `CONTEXT_FRESH_MS` (2000 ms) guards the
  kebab-click-to-first-scan handoff and menu dwell before a Manage
  lists click routinely exceeds it; the generous window is safe
  because the title cross-check below remains the correctness
  guard, freshness only bounds heuristic reuse.

Scope of identities: the takeover covers movie and show items only:
the summary path's two-segment pathname identity (/movies/<slug>,
/shows/<slug>; deliberately season-agnostic, since the app keeps
season selection in a query param on the show URL and the summary
surface stays show-scoped) and the card path's two-segment
identity, which additionally rejects season/episode query params.
Season- and episode-scoped drawers are reachable only via season
and episode cards, where the capture fails closed; this is an
explicit anti-goal for this slice, restated under "What
deliberately does not change".

A capture attempt that yields no context clears `drawerContext`
(fail closed: a stale context from an earlier item must not survive
a failed capture); otherwise the captured context persists until
replaced by the next capture. Either outcome queues a scan
(`queueScan`) from the capture handler itself, so the corrections a
new context enables (and the unwinds a cleared context requires) do
not wait on ambient churn or an app patch: the same
no-ambient-dependence principle as the drawer observer and the warn
gate's scheduled re-check. A context is slug-sourced exactly
when `context.title === context.slug`: both producers assign the
slug as the fallback title (summary page without a usable heading,
card aria-label that failed to parse), and the card entries stamp
both `data-qlt-slug` and `data-qlt-title`, so the comparison is
available from all three context sources with no new field. A
slug-sourced context is treated as no context by the cross-check
below: a slug is not a display title, so such a context must not
silently disable the feature while looking valid. Accepted narrow
false negative: an item whose display title literally equals its
slug reads as slug-sourced and stays native (fail closed, rare).

Every correction and interception first cross-checks the context:
parse the row label with `/^(Add|Remove) "(.*)" (?:to|from) /`
(greedy group tolerates quotes in titles) and require the parsed
title to equal `drawerContext.title`. This assumes the drawer
label's embedded title and the captured title (summary heading
text, or the card kebab aria-label title) are byte-identical
renderings of the same app-side item title; that equality is
runtime-owned and was probed per entry point (live-claim: probed
2026-08-07, byte-equal on both surfaces). Mismatch
means a title-format divergence, a drawer opened for a different
item through a path the capture missed, or the ordinary item-switch
transient (the capture-phase context install strictly precedes the
app's per-item row re-render, so a scan landing between them
compares the old item's labels against the new context); the rows
then stay fully native (fail closed, never wrong-item writes). A
mismatch where the label parsed but the titles differ warns once
(the `warnedTargets` pattern, warn key `drawer-title-mismatch`,
persistence-gated per the Ownership predicate, whose settle delay
and clearing rule absorb the item-switch transient), and a
systematic format divergence
shows up in the console instead of silently reading as the
pre-feature bug. No geometry gating is needed: in the current app
version the drawer unmounts on dismissal (re-probe 2026-08-07), so
there are no parked rows to correct; if a future version parks it
again, correcting invisible rows is harmless and the rows still
match the last capture's context (during an item switch the rows
lag the freshly captured context until the app's per-item render,
a transient the warn gate absorbs).

### Ownership predicate

One helper decides both mechanisms. A row is owned when all hold:

- it is inside the drawer node (`div.trakt-drawer` containment;
  the click listener is document-level, so containment is what
  scopes both mechanisms to the drawer surface),
- its `p` textContent is a `QUICK_LIST_NAMES` entry,
- its bookmark `path` node exists (a row without one cannot render
  or read membership; missing markup raises `drawer-markup`),
- its label parses and the title matches `drawerContext.title`,
- `quickLists.getListTarget(name)` resolves (missing or ambiguous
  list leaves the row native),
- membership data is not absent.

Predicate failures classify by reason, and the warn keys follow the
reason, never the marker: a row whose `p` textContent name-matches a
quick list but whose label fails to parse or whose bookmark `path`
is missing raises `drawer-markup`; a parsed label whose title
differs from `drawerContext.title` raises `drawer-title-mismatch`;
a matching title whose target de-resolved or whose membership data
went absent is an ownership loss and raises `drawer-ownership-lost`
via the unwind. Exactly one warn key fires per failure. The two
render-facing keys (`drawer-markup`, `drawer-title-mismatch`) are
persistence-gated: the drawer renders through known healthy
transients that match their triggers (the item-switch window,
where a freshly captured context precedes the app's per-item row
re-render, and the pre-resolution window, where labels may not yet
parse; the app's item-icon spinner was probed 2026-08-07 and
cannot trigger these keys at all, see Probed ground truth), and
`warnedTargets` keys are page-lifetime, so a spurious
fire would permanently silence the diagnostic. A candidate for
these keys therefore fires only when the same row still exhibits
the same failure on a scan at least `WARN_SETTLE_MS` (2000 ms)
after it was first seen, tracked in a WeakMap keyed by row; the
candidate clears when the row passes the predicate or the failure
reason changes, and registering a candidate schedules a one-shot
`setTimeout(queueScan, WARN_SETTLE_MS)` (the `notifyMutation`
idiom), so gated delivery does not depend on ambient churn
reaching an idle page. The transients are query-bound, not
time-bound, so the re-check must not fire on a row that is still
visibly loading: at the re-check, a row still carrying the
identified greyed-state carrier (the app's own not-ready signal;
when the probe identifies a class token rather than an attribute,
the check reads `classList.contains`) re-arms the candidate for
another
`WARN_SETTLE_MS` instead of firing, and re-arming reschedules the
one-shot `setTimeout(queueScan, WARN_SETTLE_MS)` along with the
deadline, so delivery never depends on ambient churn; a candidate
matures only on a row in settled presentation.
If probe (b) identifies no carrier, the pre-resolution window
cannot be detected per row, and a membership query slower than
`WARN_SETTLE_MS` on a cold reload with an immediate open can burn
a warn key spuriously; that narrow residual is accepted and stated
here rather than papered over. `drawer-ownership-lost` is exempt from the
gate: ownership loss is an engine-state change, not a rendering
transient (no healthy render window mimics it), and both of its
raise sites (the unwind and the click safety net) are one-shot by
construction because the marker drops, so it warns immediately.
Fail-closed behavior is immediate and unaffected in all cases;
only gated diagnostics wait out their transient.

The helper returns `{ name, member }` (engine truth; membership is
looked up internally via `slugKeyOf` on the context) or null; the
write path takes `type`, `slug`, and `title` from `drawerContext`
itself. Null means native behavior everywhere, with one safety net:
a marked row whose marker key matches the current context AND whose
failure reason is ownership loss (title still matching the context)
is suppressed-without-write until the next scan drops its marker,
covering the one-scan race between de-resolution and unwind; a
marked row whose displayed title no longer matches the context, or
whose marker key differs, does not suppress and its click is
native.

### Rendering corrections

A drawer renderer joins the feature's existing scan callback. For
each owned row it compares the label verb/preposition and the
bookmark path `fill` against engine membership and rewrites them on
disagreement, preserving the app's exact label format. At the
first scan where it owns a row for the current item (whether or not
a correction is needed), the renderer stamps one marker attribute,
`data-mlrt-item` (the context's `slugKeyOf` key), compare-then-write;
stamping on ownership rather than on correction keeps the key
current on rows whose app state already agrees, so a key mismatch
always means an item change. The marker is
item-scoped because row nodes are reused across items and stamped
attributes survive re-renders (probed ground truth above). One
value per attribute, per the sibling `data-qlt-*` convention; the
`mlrt` prefix is a rename axis for namespaced e2e builds. All
writes are attribute-only, so they cannot retrigger the shared
childList body observer; the compare-then-write guard is still
applied per the repo idempotence rule.

On owned rows the renderer additionally clears the greyed state.
Its carrier is whatever attribute or class the pre-implementation
probe in the Verification plan identifies; the clearing write is
specified against that probe result before implementation begins,
and if the probe cannot identify a single carrier the clearing
sub-step is dropped (owned rows then keep the app's native
transient; the rest of the feature is unaffected). Probe outcome
2026-08-07: the transients did not reproduce and no carrier was
identified; the clearing sub-step IS dropped for this slice.
Rationale:
engine truth does not depend on the app's query, so the rows
become usable as soon as their labels are parseable, and the
visual affordance always agrees with the intercepted click.
Whether the pre-resolution render already carries parseable
labels with the item's title was probed (live-claim: probed
2026-08-07, parseable from the first sample in every observed
open), so corrections begin on the open's first scan. The
wrong-background anomaly is deliberately NOT corrected in this
slice: its cause is uncharacterized and the most plausible carrier
(`data-variant`) is fenced below; the probe records its cause for a
later decision. Clearing is predicate-gated like every other
correction; a row the predicate does not own keeps its native
greyed state untouched.

When a scan finds a marked row the predicate no longer owns, the
unwind is: drop the marker and write nothing (except, on
item-mismatch drops only, operationally `data-mlrt-item` differing
from a PRESENT context key, the single fill write of the
probe-selected fill-normalization sub-step below, when probe (d)
selected it; no-context drops and same-item losses write nothing,
matching Failure modes and the Ownership-loss verification
bullet). Warn once (warn key
`drawer-ownership-lost`, exempt from the persistence gate per the
Ownership predicate) only when the failure reason is a genuine
same-item ownership loss: `data-mlrt-item` matches the current
context's key AND the row's title still matches (typically
`getListTarget` de-resolving after a list rename or delete). Every
other case drops silently: a differing or missing context key
(stale residue from an earlier item, or a failed capture), and a
title mismatch on a matching key (a capture miss showing a
different item, whose warn is `drawer-title-mismatch` from the
predicate classification, not an ownership loss).

Restoring the pre-correction attributes was designed and rejected:
at unwind time the app's current belief is unobservable, because an
app patch that converged onto engine truth is
value-indistinguishable from the script's own standing correction
(the same property that makes the attribute observer loop-free), so
any stored snapshot can be silently stale and a restore can write a
state the app never settled on. The unwind therefore leaves the
row's attributes as they stand, and the resulting mismatch windows
are accepted as bounded and self-healing: a same-tab rename or
delete is a native list-affecting action, so the app's own
invalidation refetch re-renders the drawer rows within about a
second and the attribute observer re-scans that patch; a
de-resolution discovered by a sweep (the change happened in another
tab or device) leaves the row showing the server truth the script
last wrote, with the app's equally stale native handling behind it,
converging at the app's next refetch or reload. Residual risk,
accepted pending probe: on the fail-closed item-switch path the
app's in-place patch rewrites the label (it embeds the title) but
has not been probed to repaint a `fill` whose bound value is
unchanged across the switch, so a previously corrected fill could
survive onto the new item's row (live-claim: probed 2026-08-07:
moot, the drawer unmounts on dismissal and rows are not reused
across opens in the current app version, so the sub-step is NOT
selected; the machinery remains specified as defense against a
future persistent-drawer version). The same question applies to the greyed-state carrier
the renderer clears: probe item (d) records its repaint behavior
alongside fill; unlike a stranded fill, a stranded cleared carrier
self-heals when the new item's membership query resolves (the app
re-establishes the state it wants), so its exposure is bounded to
the pre-resolution window and accepted. If the probe shows the app does not repaint it, a
fill-normalization sub-step joins the stale-item drop, specified
against the probe result; it would stamp `data-mlrt-fill` and
`data-mlrt-asserted` (pre-correction and last-written fills, named
here so the e2e rename axis covers them). If the app repaints, no
such sub-step exists. `data-variant` and row order are never
touched. On scan with stale or absent membership
data, call `quickLists.refreshMembership()` (the menu-open heal
precedent), so an open drawer heals itself without a /discover
visit.

### Click interception

One document-level capture-phase listener set (the kebab-listener
pattern) suppresses the full sequence on owned rows: `pointerdown`,
`mousedown`, `pointerup`, `mouseup`, `click`, plus `keydown` and
`keyup` for Enter and Space (rows are `role=button` with dpad
navigation, so the app plausibly acts on keys; `keyup` is included
because the ARIA button convention activates Space on keyup and a
cancelled keydown does not suppress the corresponding keyup, while
`keypress` is subsumed by the cancelled keydown). Which single
event the app's delegated handler actually consumes was not
isolated during probing, and suppressing the whole sequence removes
the question. Suppression targets rows the predicate owns OR
marked rows in the same-item ownership-loss state (the predicate's
safety net): during the one-scan window between de-resolution and
unwind, such a row should not silently fall through to the app
while showing script truth, so its click is suppressed without a
write and warns once (`drawer-ownership-lost`); the next scan drops
the marker (Rendering corrections), after which the row is native.
A marked row showing a different item than the context, or one
marked for an earlier item, does not suppress; those rows are
native.

Every suppressed event gets `preventDefault`/`stopPropagation`;
only `click` (and qualifying `keydown` with `event.repeat` false,
so a held key cannot fire alternating toggles) additionally fires
the write: `performToggle({ name, type, slug, title, add })` with
`name` from the predicate, `type`/`slug`/`title` from
`drawerContext`, and `add` derived from the row's rendered label
verb at click time (`Add` means `add: true`): the exact
captured-state semantics of `onEntryClick`, so the action always
matches what the row displayed when clicked, even inside the
one-frame window where an app patch has not yet been re-asserted.
The predicate's `member` serves rendering only. Everything downstream is existing machinery:
in-flight dedup, optimistic engine flip (the row corrects on the
next scan frame), invalidation-marker bump, write-triggered sweep, failure toast
plus revert. A click landing while the same row's write is in
flight is a silent no-op (the dedup's bare return), accepted
behavior matching the menu entries. (The "invalidation-marker bump"
in that machinery is the engine's cross-tab marker, unrelated to
the row's `data-mlrt-item` correction marker.) The drawer stays open after an
owned-row write, matching the app's own row behavior (native
toggles were observed running inside the open drawer); the menu
entries' `closeMenus()` has no analogue here. Removes are one-click
by decision (consistent with the menu entries); the app's confirm
modal never appears for owned rows because its handler never runs.
Non-owned rows keep native behavior including the confirm flow.

### Reconciliation with the app

When the app patches drawer rows to its own belief (a
mutation-driven refetch, the first-open membership query resolving,
or the per-item re-render on open), a scan must follow or
corrections silently revert. Ambient triggers cannot guarantee
that: app patches are attribute-only (the shared body observer is
childList-only), the fetch hook's `notifyMutation` fires only for
non-GET calls so a resolving GET query patches without any scan,
and a mutation's settled scan (`MUTATION_SETTLE_MS`, 1000 ms) races
the refetch round trip. The drawer therefore gets its own
re-assert trigger: a drawer-scoped MutationObserver, attached per
drawer node and keyed by a WeakSet on the node (the rating-labels
feature's `instrumented` WeakSet idiom, so a drawer node replaced
across SPA route changes gets a fresh observer; the probe record
establishes within-page persistence only), watching the row subtree with an
attribute filter (the row `label`, the bookmark path `fill`, and
the greyed-state carrier once the probe names it; a class-token
carrier enters the filter as `class`, since attributeFilter
accepts attribute names only), whose callback queues the shared
scan. The scan's
compare-then-write guard makes this loop-free: the observer also
fires on the script's own corrections, but the follow-up scan finds
agreement and writes nothing, so the chain terminates after one
bounce. Every app patch is thus re-asserted within a frame of
landing, whatever transport delivered it; the mutation-settled scan
remains as existing unrelated machinery, not this feature's
guarantee. The one-frame window between a patch landing and its
re-assert stays safe for writes via the click path's rendered-verb
semantics (Click interception). Corrections converge to no-ops once
the app's next refetch includes the script's server writes (server
truth).

## Failure modes

- Markup drift: parsers fail, predicate returns null, rows stay
  native. `drawer-markup` warns once, raised when a row whose `p`
  textContent name-matches a quick list has an unparseable label or
  a missing bookmark `path` (the name match guards against warning
  on legitimately foreign rows). Whole-surface drift (the drawer
  class renamed, no rows found at all) is deliberately silent: it
  is indistinguishable from a drawer holding no quick-list rows.
  Warns go through the existing `warnedTargets` Set with
  drawer-prefixed keys so they cannot collide with the Set's
  existing `'markup'` and list-name entries; the drawer's complete
  key set is `'drawer-markup'`, `'drawer-title-mismatch'`, and
  `'drawer-ownership-lost'`, one key per failure reason (predicate
  classification); the render-facing keys are persistence-gated per
  the Ownership predicate, which absorbs the drawer's own
  transients (one accepted residual: the no-carrier slow-query
  case, stated at the gate), and `drawer-ownership-lost` is exempt
  (one-shot raise sites). The feature degrades to today's behavior,
  never to wrong writes.
- Context capture misses an open path, or the title-equality
  assumption fails: title cross-check fails and the rows go native:
  unmarked rows stay untouched, and marked rows drop their markers
  per the unwind rule (Rendering corrections): earlier-item markers
  may carry the probe-selected fill normalization (when selected),
  current-item markers drop with no writes; warn once
  (`drawer-title-mismatch`). Same degradation. Residual risk,
  accepted: the label carries no year, so a drawer opened through
  an unobserved path for a *different* item with an identical
  display title would pass the cross-check and correct against the
  wrong slug. This requires a missed capture and a same-titled pair
  back to back; every observed open path is captured, so the window
  is a double-fault.
- `getListTarget` de-resolves after corrections were written: the
  next scan drops the marker and warns once
  (`drawer-ownership-lost`); the mismatch window this leaves is
  bounded and self-healing (see the unwind rationale under
  Rendering corrections). A click racing that scan is suppressed
  without a write by the marker rule under Click interception. The
  predicate-gated write path never reaches `performToggle` with a
  missing target, so its internal warn-and-toast branch is not this
  feature's handler.
- A failed capture clears the context while the drawer still shows
  the same item: previously corrected rows drop their markers
  silently and go native with the script's last corrections still
  displayed. Accepted residual: the displayed state is the server
  truth the script last wrote, the app's next patch or per-item
  render replaces it, and reaching it requires a capture-path
  failure in the first place (same double-fault class as the
  capture-miss risk above).
- Engine data stale: rows render stale engine truth and heal via
  the sweep, the same posture as menu entries. Absent data (cold
  start) leaves the predicate null and rows native while the heal
  call fires; a marked row cannot coexist with absent data, since
  markers are stamped only on owned rows (ownership requires
  non-absent data) and absent is a per-page-load cold-start state.

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

- Pre-implementation probe (settles every claim marked
  `(live-claim: provisional)` above, in BOTH entry points, summary
  menu and card popup): (a) title equality: for a known item,
  capture the summary heading text, the card kebab aria-label
  title, and the drawer row label title, and confirm byte equality;
  passes when all three agree per entry point. (b) Greyed state:
  reload, open the drawer, record which attribute or class differs
  on the quick-list rows versus the second open, and whether a
  click on a greyed row reaches the app handler; also record
  whether the pre-resolution rows already carry parseable
  `Add|Remove` labels with the item's title (the first-open
  correction window depends on it, per Rendering corrections); and
  record the spinner markup the app injects into `div.item-icon`
  during its own toggle (node, class, and whether the bookmark
  `path` survives), which supplies the spinner-presence detector
  for the warn gate's re-arm rule; passes when a single carrier is
  identified (or the clearing sub-step is explicitly dropped) and
  the label and spinner questions are answered either way. (c) Wrong
  background: record the anomaly's carrier if it reproduces;
  observation only, no pass condition beyond recording. (d) Fill
  repaint on item switch: correct a row's fill for item X, then
  open the drawer for an item Y whose app-side membership state for
  that list equals X's pre-correction value; record whether the app
  rewrites the unchanged-value `fill` (and the greyed-state
  carrier, when one was identified) on the per-item render; passes
  either way, and selects between the fill-normalization sub-step
  and its absence (Rendering corrections). Probe ran 2026-08-07;
  outcomes are recorded in the Probed ground truth re-probe block:
  (a) passed on both entry points; (b)/(c) transients unreproduced,
  no carrier, clearing sub-step dropped, spinner recording blocked
  pending a native-toggle probe; (d) moot, sub-step not selected.
- Correction, per entry point (summary menu AND card popup):
  quick-toggle an item via the menu entry, open the drawer while
  the app cache is stale; the two rows must show engine truth (this
  is the bug being fixed). Watchlist and other rows untouched
  (byte-identical attributes).
- Interception: synthetic-click an owned row; verify via
  authenticated API read that the write landed, no confirm modal
  appeared, and the row flipped optimistically; on a forced
  failure (invalid target id in the injected build) verify toast
  plus revert.
- Non-owned rows stay native while corrections are active: with
  the two owned rows corrected, click a non-quick-list row
  (Watchlist or a personal list) in the same open drawer; the
  app's native behavior must be fully intact, including the
  confirm modal on a remove (cancel it for a zero-write probe),
  proving suppression never over-captures beyond the predicate.
- Keyboard: synthetic Enter keydown plus keyup, and separately
  Space keydown plus keyup (Space is the ARIA keyup-activation case
  the suppression set exists for), each on an owned row, plus a
  repeated keydown with `repeat: true`; exactly one write lands per
  activation, no confirm modal, no double toggle.
- Fail closed (rows never corrected for this item): with a
  mismatched `drawerContext` title, verify clicks reach the app
  (its confirm modal appears on remove; cancel it for a zero-write
  probe), no attribute corrections occur, and the
  `drawer-title-mismatch` warn fired once. With rows still marked
  for an EARLIER item, verify the stale markers are dropped with no
  writes beyond the probe-selected fill normalization (when
  selected) and the rows behave natively for the new item. With rows
  marked for the CURRENT context key but displaying a different
  title (simulated capture miss), verify the same drop with no
  writes at all (the fill-normalization detector cannot fire when
  the marker key matches), that only `drawer-title-mismatch`
  fires, and that clicks are native.
- Markup drift: in the injected build, corrupt one owned row's
  label format persistently; verify `drawer-markup` fires once
  (after the `WARN_SETTLE_MS` gate, delivered by the candidate's
  scheduled re-check even with no further page churn), the row
  stays native, and no other warn key fires. Also assert the
  negative: with the injected build delaying the membership
  response past `WARN_SETTLE_MS` on a cold reload with an
  immediate open, no warn key fires during the healthy
  pre-resolution window (the re-arm rule holding, when a
  greyed-state carrier was identified).
- Ownership loss (two page loads, since both raise sites share the
  page-lifetime key): first, in the injected build, de-resolve the
  owned list's target (remove it from the engine store) while
  corrected rows are on screen, with no click; the next scan must
  drop the marker attribute with no other writes and warn once
  (`drawer-ownership-lost`), and clicks afterwards reach the app
  natively. Then, after a reload and fresh corrections, de-resolve
  and click before the next scan; the click must be suppressed
  with no write (API read confirms no membership change) and
  carries this page load's single warn.
- Reconciliation: with owned rows corrected, simulate an app patch
  in the injected build by writing stale label/fill values directly
  onto a corrected row. (No native trigger reliably produces a
  disagreeing patch once corrections stand: a native-action refetch
  returns server truth that already includes the script's write, so
  its patch agrees with the standing correction and no re-assert
  write exists to observe.) Instrument with an in-page attribute
  log (a temporary observer in the injected build timestamping
  label/fill mutations): pass when the re-assert write lands within
  one animation frame of the simulated patch, and when renderer
  write counts across N driven scans settle to zero after the
  re-assert (the mutation-count method), proving no scan loop.
- First-open state: after a full reload, open the drawer once; the
  owned rows must show engine truth from the first scan where their
  labels parse (before query resolution if probe (b) found
  parseable pre-resolution labels, otherwise at resolution), with
  the greyed state cleared when a carrier was identified; when the
  query resolves and patches the rows, the corrections must
  re-assert within one animation frame of the patch mutation,
  instrumented by the same in-page attribute log as the
  Reconciliation bullet. The
  wrong-background anomaly is out of scope for this slice (see
  Rendering corrections). Non-owned rows may still show the app's
  native transients.

`@version` bumps on release (Tampermonkey updates only on version
increase).

## Interactions with open backlog work

This spec supersedes two earlier records: the
`fresh-membership-sweeps.md` anti-goal that recorded the drawer
takeover as considered-and-deferred, and the BUGS_HISTORY residual
clause naming the script surfaces as the only truthful verification
points for the two rows (superseded only for these two rows; the
no-drivable-invalidation-channel half of that clause stays true and
this spec reaffirms it). Both files get forward pointers when this
feature ships; the ship-time docs pass owns those edits. No other
open backlog entry touches the drawer, the quick-list machinery, or
these rows; contention is nil against BUGS.md, QUICK_WINS.md, and
the open features.

## What deliberately does not change

- The membership engine, sweeps, invalidation markers, and ledger
  (the row-level `data-mlrt-item` correction marker is this
  feature's own, distinct machinery).
- `performToggle` / `postToggle` and the menu quick-toggle entries.
- The Watchlist row and all non-quick-list rows, including their
  native confirm-on-remove flow.
- Row order and drawer layout; no cloned or injected rows on this
  surface.
- Season- and episode-scoped drawer items: their rows stay fully
  native this slice (the context capture covers movie and show
  identities only).

## Hardening

- revise-spec graduated 2026-08-07 00:15 at e89c3bb, scope: whole file, content: c6ee0b17 (Completeness at cap: final fix applied unverified)
- revise-spec refreshed 2026-08-07 00:27 at 2d6489e, scope: whole file, content: 823267cf (live-claim fold-back)
- revise-spec refreshed 2026-08-07 01:07 at 01673be, scope: whole file, content: 01ebea9e (spec reconciliation)
- revise-spec refreshed 2026-08-07 11:00 at fbb72f4, scope: whole file, content: 8c42b769 (live-claim fold-back)
- handover completed 2026-08-07 11:00 at fbb72f4, scope: whole file, content: 8c42b769
