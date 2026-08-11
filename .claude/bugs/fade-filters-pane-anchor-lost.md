# Fade filters lost their filter-pane anchor

Reported 2026-08-11: trakt.tv redesigned the filters panel, so the
script's Fade section no longer renders on list pages. No fix yet;
tracked from the redesign report, not yet re-probed against the live
app.

## Symptom

The Fade section (a cloned "Display" section carrying the Watched /
Started / Watchlisted / quick-list / Listed toggles) is absent from the
filter pane after the redesign. Card fading itself still runs from
default or persisted `trakt-fade-filters` state, so posters keep
fading, but the pane offers no toggle UI anymore: a category switched
off in the past cannot be turned back on, and the mode-based hiding of
the Started row (hidden for `mode=movie`) also stops. The user report
included a screenshot of the redesigned panel, but the new markup has
not been probed; the selector map below is the fixer's starting point.

## Mechanism

`ensureFadeSection` (trakt_improved.user.js:1320) locates the clone
source with `div.trakt-display-section:not([data-tff-section])` and
returns early when nothing matches. After the redesign that class does
not match, so the section is never built and the failure is silent:
the `Filter pane markup changed` warn (line 1329) only fires when the
section is found but `buildFadeSection` cannot clone its internals, and
is never reached when the anchor class itself vanished. Worth fixing
too: a vanished anchor class should warn as loudly as an unbuildable
section.

## Anchor surface

All selectors live in `initFadeFilters` (trakt_improved.user.js),
confirm which ones the redesign actually broke when re-probing:

- :1321 `div.trakt-display-section:not([data-tff-section])` clone
  source, the primary anchor; confirmed broken.
- :1289 `div.trakt-filter` row template inside the Display section.
- :1291 `.display-title`, :1292 `.display-toggles` section internals.
- :1299 `span.secondary`, :1300 `input[type=checkbox]` row internals.
- :1158 / :1344 `button[aria-label="Set filters as default"]` the
  persistence save-button delegate. Verify separately; the redesign may
  have renamed this aria-label or replaced the control.
- Unaffected so far: `injectStyles` (styles run unconditionally each
  scan with no pane dependency, so the app deemphasis neutralization
  and hover transitions still apply), `applyFades` (drives off state
  only), `activeMode` (URL param and stored mode).

## Fix path

Re-probe the redesigned filter pane in a live session and map the new
markup: the section that replaced the Display section, its cloneable
row template and title/toggles containers, and the save button's
current label or replacement persistence control. Update the selectors
in `buildFadeSection` / `ensureFadeSection` and the save-button
selector, and widen the guard so a vanished anchor class produces the
warn instead of a silent no-op.

**Requires:** none.