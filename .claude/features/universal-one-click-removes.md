# Universal one-click removes

Suppress the app's remove-from-list confirmation dialog everywhere:
any surface where removing an item from a list (Watchlist, personal
lists, the Manage lists drawer's native rows) opens the app's
confirm modal becomes one-click, matching the shipped behavior of
the script-owned Anticipated/Uninterested drawer rows. Captured
2026-08-07 from a direct user request after the manage-lists row
takeover shipped; scope decisions below are the user's rulings from
that conversation.

## Decided

- **Scope: universal.** Not gated to the drawer; every appearance
  of the app's remove-from-list confirmation is auto-confirmed.
- **No flash.** The modal must never be visible, not merely
  dismissed quickly.
- **Mechanism: auto-confirm, not ownership.** Extending the row
  takeover's ownership model to all rows was considered and
  rejected: it would require the membership engine to resolve
  targets and membership for every list (cache widening, Watchlist
  via a different endpoint) and would reintroduce the app-cache
  staleness problem on every newly owned surface. Auto-confirming
  the app's own modal keeps the app's write path, optimistic
  updates, and mutation-driven cache invalidation fully native, so
  no staleness handling is needed at all.

## Design sketch

- Detection: the shared scan (or a small dedicated childList
  observer) watches for the app's confirm modal. Known anatomy from
  the 2026-08-07 live session, drawer surface: container
  `.trakt-modal`, heading "Remove from list?", buttons "Cancel" and
  "Remove from list". Match on the remove-from-list shape
  specifically, never on `.trakt-modal` generically, so other
  confirmations (deleting a list, dropping a show, anything else
  destructive) stay untouched.
- Auto-confirm: synthetically click the confirm button as soon as
  the modal is recognized (the modal accepted synthetic clicks in
  the 2026-08-07 session's confirm step; re-verify at
  implementation time).
- Flash suppression: an injected CSS rule hides the matched modal
  (and its backdrop) from its first frame; a failsafe timer unhides
  it if auto-confirm has not succeeded within a short window
  (unrecognized variant, click swallowed), so a detection miss
  degrades to today's visible dialog, never to a stuck invisible
  modal. CSS must gate on the remove-from-list shape, which likely
  means hiding all `.trakt-modal` instances briefly until the shape
  check runs, then either confirming or unhiding; the exact
  gating order is an implementation decision.
- Fail-open everywhere: markup drift (renamed classes, changed
  button text) means the modal simply appears as it does today.

## Open questions (probe before implementation)

- Enumerate the modal's variants across surfaces: drawer native
  rows, list-detail pages, the summary-page Watchlist button, and
  any other remove path; confirm heading/button text is identical
  everywhere (live-claim: provisional).
- Localization: the user's UI is English; decide whether matching
  the English strings is acceptable or whether a structural
  signature (button order, modal shape) is available.
- Whether the app ever reuses the same modal shape for a
  non-remove destructive action that the string match must exclude.

**Requires:** none.
