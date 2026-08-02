# Popup menu scroll shield

Status: signed off 2026-08-02 13:00, content: 814882ae

Keep the card popup menu (the kebab menu on media cards, and the same
popup on list pages) open while the page scrolls, so a menu taller than
the remaining viewport can be scrolled into full view instead of
closing on the first wheel tick.

## Problem

app.trakt.tv closes the popup menu on any scroll. The menu frequently
opens partially clipped by the viewport bottom edge (observed live: a
286px menu whose bottom landed at the viewport boundary), and the
natural reaction, scrolling to reveal the rest, dismisses it. The quick
list toggles feature makes this worse in practice: injected rows grow
the menu (`growPopupMenu` lifts the app's max-height cap), so tall
menus are now common.

## Diagnosis (verified live, 2026-08-02)

Established by injecting instrumentation into a live app.trakt.tv tab
and driving trusted input through browser tooling:

- The popup container (`.trakt-popup-menu-container`) is rendered as a
  direct child of `body` with `position: absolute` and document
  coordinates. It scrolls with the page content, so a surviving menu
  tracks its owning card visually with no repositioning needed.
- Two independent listener paths close the menu on scroll:
  - A `scroll` listener registered at app boot (it predates userscript
    injection; instrumentation installed after page load never saw its
    registration, only its effect). Document scroll events reach it and
    the menu closes immediately.
  - Capture-phase `wheel` listeners on the `html` element, registered
    by an app class named `EventTracker` each time a menu opens and
    removed when it closes. Blocking only the `scroll` path left the
    menu open at first but it closed within a few seconds, so this
    wheel path also closes it, on a deferred schedule.
- Swallowing both event types at the window capture stage while a menu
  is open kept the menu open across scrolls and through a 7 second
  soak, with normal click-to-dismiss behavior intact.
- Post-implementation e2e (2026-08-02, injected build) added: the
  popup container's own height animates from 0 on the card surface
  and stays 0 permanently on the list-page kebab surface (the inner
  `ul` overflows it visibly), so the menu `ul` is the only reliable
  geometry source; and the container is removed from the DOM a
  moment after close (it lingers only through the close animation),
  so retained-container states are transient in practice.
- Escape does not close these menus; trusted clicks and scroll are the
  app's only dismissal paths. Synthetic (untrusted) clicks are ignored
  by these menus (consistent with the e2e notes in CLAUDE.md), which
  rules out any design where the userscript closes or reopens the menu
  itself.

## Design

A small standalone IIFE in trakt_improved.user.js. At init it registers
two window-level listeners, `wheel` and `scroll`, both
`{ capture: true, passive: true }`. Handler logic, identical for both
events:

1. `document.querySelector('.trakt-popup-menu-container')`; if absent,
   return. This is the permanent fast path: no menu, no work beyond one
   selector probe, and the shield needs no state, no observer, and no
   teardown.
2. If the container holds no rendered menu, return without swallowing.
   Concretely: no inner `ul`, or a `ul` bounding rect with zero width
   or height. The rect MUST come from the inner `ul`, not the
   container: live e2e (2026-08-02) showed the container is a
   zero-height positioning anchor on some surfaces (permanently so on
   list-page kebab popups; transiently during the card popup's open
   animation), so the container's own rect cannot distinguish open
   from closed, while the `ul` carries the menu's real geometry on
   every observed surface. Container presence alone is not proof of
   an open menu either: the repo's own notes record that the SPA can
   reuse one popup container across opens (the quick-list and
   Truncate per-open-lifecycle comments in trakt_improved.user.js),
   and e2e observed the container lingering through the close
   animation before being removed from the DOM. Without this guard, a
   hidden or emptied container state reports a zero rect, which none
   of step 3's offscreen tests match, and the shield would swallow
   every wheel and scroll event for the rest of the session, silently
   starving hydration and infinite scroll with no menu on screen. The
   guard mirrors the shape `renderPopup` already uses (it requires
   `container.querySelector('ul')` before treating the popup as
   rendered) and fails toward native app behavior, including during
   the open animation's brief zero-height window.
3. If the menu `ul`'s `getBoundingClientRect()` is fully outside the
   viewport (`bottom < 0`, `top > innerHeight`, `right < 0`, or
   `left > innerWidth`), return without swallowing. The event then
   reaches the app's own listeners, which close the menu through the
   app's normal code path. This bounds how far an open menu can be
   scrolled away: the app remains the sole authority on closing, and
   the shield only scopes when the app is allowed to hear scroll
   input.
4. Otherwise `stopImmediatePropagation()`.

Why this shape holds:

- Capture-phase ordering is what makes a late-loading userscript able
  to outrank the app: window capture listeners run before any listener
  on `document` or `html` regardless of registration order.
- `stopImmediatePropagation()` controls propagation only; native
  scrolling is a default action and proceeds untouched. `passive: true`
  makes it impossible for the shield to block scrolling even by
  accident.
- `stopImmediatePropagation()` rather than `stopPropagation()` also
  covers hypothetical window-capture listeners the app might add later.
  When two script instances both shield (installed copy plus an
  injected e2e build), whichever registered first swallows the event
  and starves the other; the net effect is identical and order does
  not matter.
- Both event types must be swallowed. Wheel input dispatches `wheel`
  then `scroll`; scrollbar drags and keyboard scrolling dispatch only
  `scroll`. Touchpads dispatch the same `wheel` events as mouse wheels
  (finer deltas), so no input-device-specific handling exists
  anywhere. Touchscreen `touchmove` is out of scope for a desktop
  userscript manager, and the app was not observed listening for it.
- The rendered-menu and offscreen checks run at most once per
  swallowed event while a menu is open, and `scroll` events fire
  after the scroll position updates, so the rect reflects the
  post-scroll layout. The residual edge is benign: stopping exactly
  when the menu crosses fully offscreen leaves it open, offscreen,
  until the next scroll tick or click closes it.

Alternatives considered and rejected:

- **Reposition the menu to fit the viewport** (shift its absolute
  `top` so nothing is clipped): solves only the opens-clipped case,
  not the actual goal of scrolling freely while a menu is open;
  detaches the menu from its owning card, which the app's absolute
  document-coordinate placement keeps visually anchored; and writes
  to app-owned inline styles on a node the app positions, a more
  fragile contract than passively filtering events.
- **Keep the app's max-height cap so tall menus scroll internally**:
  the quick list toggles feature deliberately lifts that cap
  (`growPopupMenu`) because injected rows would otherwise clip, so
  this would revert shipped behavior; an inner scrollbar on a popup
  menu is also the poorer reading experience, and it again addresses
  only the clipped case.
- **Neutralize the app's two closing listeners directly**: the boot
  scroll listener predates userscript injection (`@run-at
  document-idle`), so no listener reference exists to hand to
  `removeEventListener`; capturing one would mean patching
  `addEventListener` from document-start, which is invasive, fragile
  across app updates, and affects unknown other consumers of those
  events. The EventTracker wheel listeners re-register on every menu
  open, compounding the same problem.
- **Close and rebuild or reopen the menu ourselves**: already ruled
  out in Diagnosis; these menus ignore synthetic clicks.

## Interactions

- **Quick list toggles / Truncate rows**: both features' rows land in
  the same popup container at runtime (quick list toggles query
  `.trakt-popup-menu-container` directly; Truncate locates the menu
  structurally from its Share row anchor), so both benefit directly;
  no code in either feature changes. The shield has no DOM writes,
  so the shared body observer's idempotence rule is not in play.
- **Virtualized grid hydration and infinite scroll**: the app's own
  scroll listeners are also starved while a popup menu is rendered
  and at least partially in the viewport, so card hydration and
  page-append pause during that window. The pause ends with the
  shield's gate, not strictly at close: a pass-through event (menu
  fully offscreen) reaches the hydration listeners and the app's
  closing listener at the same time, and after a click-dismiss the
  next scroll flows normally. Accepted trade; the window is short and
  self-healing.
- **Summary actions menu** (`div.trakt-summary-actions`, detail
  pages): inline element, not `.trakt-popup-menu-container`, does not
  close on scroll, unaffected.
- **Filter pane, tooltips**: the `EventTracker` wheel listeners on
  `html` appear and disappear with other UI too (observed adds and
  removes while no popup was open). The shield keys on a rendered
  popup menu (Design steps 1 and 2), so other consumers hear wheel
  events normally whenever no popup menu is open.

## Interactions with open backlog work

- BUGS.md "Anticipated/Uninterested quick toggles rarely take effect,
  and failures are silent": same card popup surface, but no
  interaction in either direction. The card popup dismisses itself on
  any trusted click, including the toggle click on an injected row
  (per Diagnosis; the userscript's `closeMenus` targets only the
  summary-actions underlay and cannot close this surface), so the
  menu is gone before the write settles with or without the shield;
  the shield changes only scroll-driven dismissal. That bug's
  diagnosis and this feature can land in any order.
- QUICK_WINS.md "Lift a shared list-URL parser to the shared
  plumbing section" and the closure-split refactor "initFadeFilters
  has outgrown single-closure comprehension" (shipped 2026-08-02,
  archived in QUICK_WINS_HISTORY.md): same file, different closures.
  This slice adds one standalone IIFE and touches no existing
  closure, so neither refactor blocks it or is blocked by it; any
  landing order works.
- QUICK_WINS.md "Write-triggered membership refresh can read
  server-cache-stale list items" and BUGS.md "Cross-tab list adds
  miss the fade treatment until it eventually self-heals": membership
  sweep machinery driven by timers and fetch hooks, with no scroll
  path. The shield neither touches nor delays the sweeps, so neither
  entry is affected in either direction; landing order is free.

## Testing

E2e via the established injected-build route (trimmed bundle in
`.tmp/`, trusted input through browser tooling, real scrolls for
virtualized grids):

- Open a card popup, scroll: menu stays open and tracks its card.
  Keep observing for at least 10 seconds after the scroll: the app's
  wheel-path close fires on a deferred schedule (Diagnosis), so a
  shield that swallows only `scroll` passes an instantaneous check
  and fails a few seconds later. The validating live run soaked for
  7 seconds; 10 gives margin.
- Keep scrolling until the menu is fully offscreen: next scroll closes
  it (app-driven).
- With menu open, click elsewhere: closes as before.
- Open a menu, dismiss it with a click, then scroll: hydration and
  page-append behave normally, proving no lingering swallow from a
  retained container (Design step 2's guard).
- With no menu open on a fresh page, scrolling hydrates cards and
  appends pages as before (shield inert).
- List page kebab popup gets the same treatment.

This feature has no localStorage keys, CSS classes, or style ids, so
the e2e namespacing protocol (key suffixes, renamed classes and style
ids, version-stamped cache keys) has nothing to rename; installed
copy and injected build coexist as described in Design.

## Shipping

Single slice. Bump `@version` (minor) in the same change.

## Hardening

- revise-spec graduated 2026-08-02 13:38 at 9eb2d02, scope: whole file, content: 4f8612bb
- handover completed 2026-08-02 16:34 at 80d6b7d, scope: whole file, content: afc93864
