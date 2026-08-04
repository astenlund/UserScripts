---
status: exploring
---

# Manage-lists row takeover

Capture-stage stub, queued 2026-08-04; detail deferred to a dedicated
brainstorm. Script-owned truth for the Anticipated and Uninterested
rows inside the app's Manage lists panel, so the panel stops
misreporting quick-list membership after script quick-toggle writes.

## Why this is the only path

Established across 2026-08-03/04 (diagnosis in
`fresh-membership-sweeps.md` and bundle archaeology recorded in
session memory): the panel renders from the app's client-side TanStack
Query cache and refetches only on the app's own mutation-driven
invalidation (any native list-affecting action) or a full page load.
There is no time-based self-convergence (an earlier ~30s observation
was a confounded one-off), and no externally drivable refresh channel
exists: the QueryClient is Svelte-context-bound and unexported (the
same-module-import trick finds no instance), the app registers no
storage or BroadcastChannel listener, and the service worker does
asset caching only. Rejected on principle: synthetically driving a
real native mutation (e.g. watchlist on+off) to piggyback on the
app's own invalidation costs two real server writes plus activity
noise per toggle.

## Candidate shape

Take over (or replace with native-looking clones, the toggles
feature's established technique) the two quick-list rows when the
panel opens: render membership from the script's membership engine
(authoritative since 1.29's busted sweeps), and intercept clicks to
route through the existing `performToggle` write path. Visual-only
sync is a known trap, not an option: correcting the bookmark fill
without owning the click makes the app's stale model act opposite to
what the corrected visual promises.

## Open questions (for the brainstorm)

- Panel row markup and stability: are the rows app-managed nodes that
  Svelte re-renders mid-open (attr stripping, node replacement), and
  does a WeakSet-tracked correction survive?
- Interception mechanics: capture-phase listener vs row replacement;
  what the app's own click handler does when suppressed; underlay and
  dismissal interactions.
- Identification: rows are labeled by list name (the same
  user-config names as QUICK_LIST_NAMES); ordering and markup
  variance between the summary-page and card-popup panel instances.
- Reconciliation: what happens when the app eventually refetches
  (its next native mutation) while a script-corrected row is showing;
  the handover back to app-rendered state must not flicker or fight.
- Idempotence under the shared body observer (childList refires on
  node swaps; corrections must be state-compared).
