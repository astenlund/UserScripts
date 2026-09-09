# Fade filter controls incompatible with redesigned drawer

Reported 2026-08-11; re-probed in signed-in Chrome on 2026-09-09.
Fixed in the local Trakt Improved 1.42 source.

## Verified cause

The original diagnosis blamed a missing Display section. Live inspection
corrected that: `div.trakt-display-section`, `.display-title`,
`.display-toggles`, `div.trakt-filter`, and `span.secondary` still exist.
The native checkbox was replaced with a segmented radiogroup containing
Default, On, and Off buttons. `buildFadeSection` required a checkbox and
returned null. The save button still uses the aria-label
`Set filters as default`.

Card fading continued from saved or default state while the controls
were absent.

## Fix

Clone the native Display section and support both its legacy checkbox
and current button shape. Fade categories are binary: remove Default
from the cloned controls and wire On/Off state, selected styling,
keyboard navigation, and accessibility attributes. Changes apply in
memory; the existing explicit save button persists them. Reopening the
drawer reconstructs current state, movie mode hides Started, and repeat
scans do not append duplicate controls or rewrite child nodes.

A missing Display section warns once when the save-button landmark
indicates an open filter drawer. Unsupported row markup also warns once.

## Related season fade defect

On the Taskmaster Hall of Fame list, season cards have a
`.trakt-card-subtitle` containing `Season N` but their links omit
`season=`. The script therefore classified them as whole shows. Live
inspection found the UK and NZ cards faded, and AU season 2 unfaded;
the precise membership category behind each old fade was not inspected.

The fix reads the season subtitle only when the show link has neither
a season nor an episode parameter. Explicit URL identity stays
authoritative. Specials maps to season 0. Recognizable season cards
whose season cannot be read stay unfaded instead of inheriting a show
fade. Existing membership and show-level Watched/Started bucketing rules
remain unchanged.

## Verification

`tests/trakt-fade-filters.test.cjs` exercises season-specific fading,
identity fallback, drawer controls, saving, keyboard interaction,
remounts, mode changes, warning bounds, and scan idempotence.
The live DOM was inspected through signed-in Chrome. The updated source
has not been installed or visually verified there; that connection's
page evaluation is read-only.
