# Fresh membership sweeps

Status: designed and approved in-session 2026-08-03

Two changes to the list-membership engine in `trakt_improved.user.js`:
(A) cache-busting `marker=` params on the engine's user-data GETs, and
(B) a `storage`-event listener that triggers prompt sweeps when another
tab bumps an invalidation marker. Together they fix the same-tab
30-second fade revert after quick-toggle writes and the same-device
half of the cross-tab fade staleness bug.

## Diagnosis this design rests on (verified live 2026-08-03)

- Quick-toggle writes always land server-side; every coded failure
  path in `performToggle`/`postToggle` shows a toast. The historical
  "toggles rarely take effect" bug was closed as a verification-surface
  artifact (see BUGS_HISTORY.md).
- Trakt serves per-user GET responses from a server-side cache that
  the app busts with a per-page-load `marker=` token on its `/v3`
  calls. The script's marker-less v2-style GETs intermittently read
  stale copies: probes on one day measured fresh reads within ~1.3s,
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
`fetchPage` it makes, so all pages of one collection read from the
same cache generation (pages straddling two generations could
duplicate or drop items). `fetchWatchedProgress` mints its own. The
nonce rides a `marker` query param, mirroring the app's own busting
mechanism against the same cache; the value just needs uniqueness
per sweep (e.g. `Date.now().toString(36)` plus a random base36
suffix), not the app's exact token format. The endpoints accept the
param today (observed 200s).

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

The membership engine registers one `window.addEventListener(
'storage', ...)` filtered on keys starting with `MARKER_PREFIX`. Any
matching event sets `forceRefresh = true` and calls `queueRefresh()`
directly, without waiting for a DOM-mutation-driven scan. Storage
events by spec fire only in tabs that did NOT perform the write, so
every matching event is a foreign bump by construction; no
self-exemption is needed (this tab's own `SELF_MARKER_KEY` writes
never echo back). Key removal events (`newValue === null`) count as
movement too, harmlessly.

This covers both foreign-write flavors with one listener: another
tab's script quick-toggle (bumps `SELF_MARKER_KEY`) and another
tab's native app action (bumps `listed:*`, `watchlisted:*`,
`mark_as_watched:*`, etc.).

Interaction notes:

- The single-flight guard in `refresh()` absorbs multi-key bump
  bursts; the marker snapshot captured at sweep start covers bumps
  that land mid-sweep (existing machinery, unchanged).
- `forceRefresh` bypasses the failure backoff by design (same
  promptness rationale as the mutation-hook path); marker events
  arrive at user-action rate, so no storm guard is needed.
- Storage events fire in hidden tabs. The sweep's fetches run fine
  in the background; repaint may lag under background timer
  clamping, but data is committed before the user returns to the
  tab, which is the point.
- The scan-driven `markersChanged()` check stays: it catches bumps
  that landed while no listener was alive (e.g. during this tab's
  page load).

## What deliberately does not change

- The confirmed-write ledger, its 30s trust window, and the suspect
  resweep ladder. With A in place they become a rarely-exercised
  second line of defense; a "expired still contradicted" warn
  appearing after this feature ships is the diagnostic that busting
  stopped working.
- `WRITE_SETTLE_MS` / `MUTATION_SETTLE_MS` settle windows.
- The four un-busted `apiGet` consumers enumerated above.
- No UI changes; toasts unchanged.

## Anti-goals

- **Manage-lists row takeover (deferred).** Script-owned truth for
  the two quick-list rows inside the app's Manage lists panel was
  considered and deferred: the panel self-converges in ~30s, part A
  aligns the fades with that, and taking over app-managed Svelte
  rows is the highest-cost option on the table. Revisit only if the
  residual sub-30s panel lag proves annoying in practice.
- **Cross-device staleness.** No marker channel exists between
  devices; convergence stays TTL-driven (or rides native marker
  bumps when the user acts on the other device). Accepted.
- **No v3 endpoint migration.** The v2-style endpoints plus nonce
  are sufficient; v3 shapes are undocumented.

## Failure modes

- Server starts rejecting the `marker` param: per-category fetch
  failure feeds the existing stale-keep + backoff + warn path;
  fades degrade to stale data, never break. The warns identify the
  cause.
- Storage listener never fires (sandbox event isolation): part B
  degrades to today's scan-driven detection; part B is purely
  additive. Verified live at e2e before release.
- Nonce fails to bust (cache ignores unknown params): behavior
  degrades to today's; the ledger diagnostics (see above) surface
  it.

## Verification plan

Live e2e per the repo CLAUDE.md constraints (namespaced injected
build; chain trusted clicks inside one browser_batch; network
tracker unreliable, verify via authenticated API reads and cache
state):

- Sweep URLs carry the nonce and sweeps still commit fresh data
  (assert via the injected build's cache `fetchedAt` advancing and
  membership matching an API read).
- Quick-toggle an item and watch cache state for 60s+: no revert,
  no suspect-resweep churn (fetchedAt resets once, then ages).
- Two-tab test: with tab Y idle on a fade surface, bump a marker in
  tab X (script toggle or native action); tab Y's `fetchedAt`
  resets within seconds without any DOM interaction in Y, and its
  fade state converges.
- Regression: one sweep per trigger (no sweep loops); the four
  un-busted consumers still work; normal toggle round-trip
  unchanged.

`@version` bumps to 1.28 on release (Tampermonkey only updates on a
version increase).

## Interactions with open backlog work

- **Fixes** BUGS.md "Cross-tab list adds miss the fade treatment
  until it eventually self-heals" (same-device): that entry's
  `Requires:` line now points here, and the bug archives together
  with this feature's shipping.
- BUGS_HISTORY.md "Anticipated/Uninterested quick toggles rarely
  take effect": closed same day as diagnosis-only; the fade-revert
  residue it surfaced is what this feature fixes.
