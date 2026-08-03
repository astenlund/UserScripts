# Fresh membership sweeps

Status: signed off 2026-08-03 23:16, content: f617fd30

Two changes to the list-membership engine in `trakt_improved.user.js`:
(A) cache-busting `marker=` params on the engine's user-data GETs, and
(B) a `storage`-event listener that triggers prompt sweeps when another
tab bumps an invalidation marker. Together they fix the same-tab
30-second fade revert after quick-toggle writes and, for same-origin
tabs within one browser profile, the cross-tab half of the fade
staleness bug.

## Diagnosis this design rests on (verified live 2026-08-03)

- Quick-toggle writes always land server-side; every coded failure
  path in `performToggle`/`postToggle` shows a toast. The historical
  "toggles rarely take effect" bug was closed as a verification-surface
  artifact (see BUGS_HISTORY.md).
- Trakt serves per-user GET responses from a server-side cache that
  the app busts with a per-page-load `marker=` token on its `/v3`
  calls. The script's marker-less v2-style GETs intermittently read
  stale copies: probes on one day measured fresh reads within ~1.3-3s,
  while a live user reproduction the same day hit staleness beyond
  35s on the same endpoint family. Staleness is intermittent and
  cannot be reproduced on demand; the fix must not depend on
  observing it.
- The fade revert at ~30s is the confirmed-write ledger
  (`WRITE_TRUST_WINDOW_MS`) expiring while sweeps still read the
  stale copy: reconciliation re-patches each stale sweep during the
  trust window, and the first post-expiry sweep commits pre-write
  membership, flipping the fade back. The app's own marker-busted
  reads were fresh at the same moment (its Manage lists panel showed
  the write at ~30s), which is what makes marker busting the right
  mechanism to adopt.
- An idle tab (no DOM mutations) queues no scans, so
  `markersChanged()` goes unconsulted until user interaction; that
  trigger gap, not data staleness, is the cross-tab bug's dominant
  mechanism.
- The app's Manage lists panel renders from a client-side query
  cache: it fires no request on reopen, ignores same-tab localStorage
  marker writes and synthetic StorageEvents (both tested dead), and
  self-converges within roughly 30s while open. No script-drivable
  invalidation channel into the app exists.

## Part A: marker-busted sweep reads

`fetchAll` mints one nonce per call and threads it to every
`fetchPage` it makes; `fetchWatchedProgress` mints its own. The
nonce rides a `marker` query param, mirroring the app's own busting
mechanism against the same cache; the value just needs uniqueness
per sweep (e.g. `Date.now().toString(36)` plus a random base36
suffix), not the app's exact token format. The endpoints accept the
param today (observed 200s). Per-`fetchAll` minting is a single-site
convenience, not a consistency mechanism: each page URL is its own
cache key, so every page is an independent fresh origin read, and
pages (or sibling collections joined later, like the listed record's
per-list fetches or `splitWatchedShows`' two sources) can still
straddle a server-side write exactly as marker-less reads can today.
That torn-read exposure is unchanged by this feature; the next sweep
owns healing it, as it always has.

Busting was considered and rejected once before: the 1.26
confirmed-write-ledger design recorded "cache-defeating corrector
reads" as a rejected alternative, reasoning that a buster was
untested and could not reach server-internal replication lag (see
the 1.26 entry in QUICK_WINS_HISTORY.md). The 2026-08-03 observation
retires that rejection: the app's own marker-busted read was fresh
on the same endpoint family at the same instant the script's
marker-less read had been stale for over 35s, so the staleness lives
in a buster-reachable cache layer, not in replication lag. The
ledger stays regardless (see below), so the untested-mechanism risk
the old rejection guarded against is fenced by a second line of
defense instead of blocking the mechanism.

Consumers of the shared `apiGet`, and each one's handling:

- `fetchPage` (serving `fetchAll`: watched shows, watched movies,
  watchlist, lists index, per-list items): busted, per-call nonce.
- `fetchWatchedProgress` (season-numbers variant): busted, own nonce.
- External-links metadata GET (`/movies|shows/<slug>`): unchanged.
  Public, static-ish data that benefits from caching.
- List-counts feature (bulk `/users/me/lists`, per-list
  `/users/<owner>/lists/<slug>`, `/users/<owner>/watchlist?limit=1`):
  unchanged. Display-only totals on their own TTL; staleness there is
  cosmetic and out of this feature's scope.
- Truncate feature (its target list's items): unchanged. It re-reads
  immediately before writing on its own explicit trigger.

Writes (`apiPost`) are unaffected.

## Part B: storage-event sweep triggers

The membership engine registers one storage listener on `pageWindow`
(the real page window, the same surface the fetch hook patches:
storage events dispatch on the page window, sandbox-wrapper
forwarding of window events is manager-dependent, and registering
there makes a page-context e2e build exercise the same listener path
as the released sandboxed build), filtered on keys starting with
`MARKER_PREFIX` (a
null key, as from `localStorage.clear()`, simply fails the prefix
test). Storage events by spec fire only in tabs that did NOT perform
the write, so every matching event is a foreign bump by
construction; no self-exemption is needed (this tab's own
`SELF_MARKER_KEY` writes never echo back). Key removal events
(`newValue === null`) count as movement too, harmlessly.

A matching event does not sweep immediately: it (re)starts a single
settle timer of `WRITE_SETTLE_MS`, coalescing event bursts. The
writing side bumps its marker the moment its POST resolves, and the
server needs the same settle the local write path already waits out
(that is why `refreshMembership`'s write-triggered flavor exists); a
zero-delay sweep would read pre-write state, commit it as fresh, and
leave nothing to correct it, since a foreign write has no ledger
entry in this tab. When the timer fires, the trigger uses the
engine's established in-flight-collision idiom, the same one the
suspect resweep and the write-settle trigger use: if a sweep is in
flight, set `pendingForcedRefresh` (drained when that sweep
commits); otherwise set `forceRefresh` and call `queueRefresh()`.

This covers both foreign-write flavors with one listener: another
tab's script quick-toggle (bumps `SELF_MARKER_KEY`) and another
tab's native app action (bumps `listed:*`, `watchlisted:*`,
`mark_as_watched:*`, etc.).

Interaction notes:

- The settle timer plus the `pendingForcedRefresh` branch bound the
  cost per tab: an event burst coalesces into one sweep, plus at
  most one follow-up when a bump lands mid-sweep. The sweep-start
  marker snapshot additionally keeps any residual mid-sweep bump
  detectable to the scan-driven check on fade surfaces (existing
  machinery, unchanged); the explicit branch removes that path's
  preconditions (a committing sweep, and a page whose scan consults
  `needsRefresh`) from the correctness argument.
- Fan-out cost, named and accepted: each foreign burst costs one
  full membership sweep per open tab (roughly five category fetches
  plus one paginated fetch per personal list). Sustained slow
  toggling costs one sweep per toggle per tab, the same cost the
  writing tab already pays via its own write-triggered sweeps. Sweep
  failures, including HTTP 429, feed `apiGet`'s throw into the
  existing stale-keep + `lastFailureAt` path; a later bump bypasses
  that backoff via `forceRefresh` by design (the same promptness
  posture as the mutation-hook path), accepted at user-action rate.
- Storage events fire in hidden tabs. The sweep's fetches run fine
  in the background; repaint may lag under background timer
  clamping (which also stretches the settle timer, harmlessly,
  toward more settle rather than less), but data is committed before
  the user returns to the tab, which is the point.
- The scan-driven `markersChanged()` check stays: it catches bumps
  that landed while no listener was alive (e.g. during this tab's
  page load).

## What deliberately does not change

- The confirmed-write ledger, its 30s trust window, and the suspect
  resweep ladder. With A in place they become a rarely-exercised
  second line of defense; a "expired still contradicted" warn
  appearing after this feature ships is the diagnostic that busting
  stopped working. Widening `WRITE_TRUST_WINDOW_MS` instead of
  busting was considered and rejected: the observed lag is unbounded
  (about 2s in July, over 35s today), so any fixed window merely
  moves the cliff, and a longer window also lengthens the
  phantom-defense cost when `ok` was wrongly judged true. Busting
  removes the stale read itself.
- `WRITE_SETTLE_MS` / `MUTATION_SETTLE_MS` settle windows.
- The five un-busted `apiGet` call sites enumerated above (external
  links, the three list-counts reads, truncate).
- No UI changes; toasts unchanged.

## Anti-goals

- **Manage-lists row takeover (deferred).** Script-owned truth for
  the two quick-list rows inside the app's Manage lists panel was
  considered and deferred: the panel self-converges in ~30s, part A
  aligns the fades with that, and taking over app-managed Svelte
  rows is the highest-cost option on the table. Revisit only if the
  residual sub-30s panel lag proves annoying in practice.
- **Out-of-partition staleness.** The storage-event channel is
  scoped to same-origin tabs of one browser profile. Writes made
  anywhere else on the same or another device (a different browser
  or profile, an incognito window, the classic trakt.tv UI, another
  machine) reach no listener; convergence for those stays TTL-driven
  (or rides native marker bumps when the app itself acts in a
  covered tab). Accepted: no channel exists to do better.
- **No v3 endpoint migration.** The v2-style endpoints plus nonce
  are sufficient; v3 shapes are undocumented.

## Failure modes

- Server starts rejecting the `marker` param: unmitigated, this
  would be a permanent all-category sweep outage (every busted GET
  fails, on every sweep, until a script update removes the param),
  not a per-category degradation. Mitigation, part of this feature:
  when a busted GET fails with a param-rejection-shaped status (400
  or 422; explicitly not 401, 403, 404, 429, 5xx, or network
  failures, which keep their existing stale-keep + backoff routing
  unchanged), the engine sets a tab-session busting-disabled latch
  and warns once. The failing sweep keeps stale data per the
  existing path, and every later sweep in that tab runs marker-less,
  degrading wholesale to today's pre-feature behavior instead of an
  outage; the latch is in-memory and per-tab, so a server-side fix
  heals on the next page load. Deliberately no per-request retry:
  re-issuing inside the sweep would double request volume under
  rate limiting, and a succeeding un-busted retry could commit a
  mixed busted/marker-less sweep whose stale half forfeits exactly
  the guarantee Part A exists to provide.
- Server accepts the param but alters the response body because of
  it: the only class that could commit wrong data as fresh with no
  warn. Accepted on two fences: responses with and without the
  param were observed equivalent for the same membership state
  (2026-08-03), and the first verification bullet compares
  busted-sweep membership against a plain authenticated read, which
  fails loudly if the param ever shapes the body.
- Storage listener never fires (sandbox event isolation): part B
  degrades to today's scan-driven detection; part B is purely
  additive. Verified live at e2e before release.
- Nonce fails to bust (cache ignores unknown params): behavior
  degrades to today's; the ledger diagnostics (see above) surface
  it.
- Storage-triggered sweep fails: a partial failure keeps stale
  categories wholesale and arms `rearmedRefresh` (scan-consulted, so
  the next interaction heals it within the backoff rules); a total
  failure commits nothing and queues no scan, leaving the tab on its
  prior data until the next foreign bump, interaction, or TTL. Both
  are strictly no worse than today's behavior (Part B is additive),
  and the next foreign bump is the practical retry: a fresh event
  re-triggers regardless of the backoff. An idle-tab retry timer is
  deliberately not added; while nobody is viewing the tab the stale
  data is invisible, and the armed flags make the first interaction
  heal it.

## Verification plan

Live e2e per the repo CLAUDE.md constraints (namespaced injected
build; chain trusted clicks inside one browser_batch; network
tracker unreliable, verify via authenticated API reads and cache
state):

- Sweep URLs carry the nonce: the injected build records every URL
  `apiGet` is called with on its window debug handle; pass when each
  membership-sweep GET's recorded URL carries the minted `marker`
  value, the five un-busted call sites' recorded URLs carry none,
  and sweeps still commit (cache `fetchedAt` advancing, membership
  matching an authenticated API read).
- Busting efficacy cannot be forced on demand (staleness is
  intermittent); if a stale window occurs during verification, the
  marker-busted read must return post-write membership while the
  window is open. Otherwise the claim ships provisional, and the
  post-ship settling signal is the ledger's "expired still
  contradicted" warn staying absent in normal use. (live-claim:
  provisional)
- Quick-toggle an item and watch cache state for 60s+: no revert,
  no suspect-resweep churn (fetchedAt resets once, then ages).
- Two-tab, script flavor: with tab Y idle on a fade surface,
  quick-toggle an item in tab X (bumps `SELF_MARKER_KEY`); tab Y's
  `fetchedAt` resets within 15 seconds (generous: sweep duration
  and the settle window are unowned latencies; the baseline being
  beaten is the 15-minute TTL) without any DOM interaction in Y,
  and Y's fade state converges. This also probes whether storage
  events reach the Tampermonkey sandbox listener at all.
  (live-claim: provisional)
- Two-tab, native flavor: perform a native list action in tab X
  (e.g. a Manage-lists tick, expected to bump the app's `listed:*`
  markers); tab Y converges the same way. A separate probe because
  the app-bumped key names are themselves a claim the repo cannot
  settle. (live-claim: provisional)
- Regression: one sweep per trigger (no sweep loops); the five
  un-busted `apiGet` call sites still work; normal toggle round-trip
  unchanged.

`@version` bumps to 1.29 on release (Tampermonkey only updates on a
version increase; 1.28 already shipped with the list-URL parser quick
win).

## Interactions with open backlog work

- **Fixes** BUGS.md "Cross-tab list adds miss the fade treatment
  until it eventually self-heals" (same-profile tabs): that entry's
  `Requires:` line now points here, and the bug archives together
  with this feature's shipping.
- BUGS_HISTORY.md "Anticipated/Uninterested quick toggles rarely
  take effect": closed same day as diagnosis-only; the fade-revert
  residue it surfaced is what this feature fixes.
- QUICK_WINS_HISTORY.md "Write-triggered membership refresh can
  read server-cache-stale list items" (Trakt Improved 1.26): built
  the ledger this feature demotes to a second line of defense, and
  recorded cache-defeating reads as a rejected alternative; Part A
  documents why that rejection is now retired.

## Hardening

- revise-spec graduated 2026-08-04 00:15 at 29d3465, scope: whole file, content: d52b3cb8
- revise-spec refreshed 2026-08-04 00:55 at e16c220, scope: whole file, content: 2e498852 (final-review fold-back)
