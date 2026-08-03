# Bugs (history)

Fixed bugs, archived from `BUGS.md` so the active list stays scannable
on session start. **Archaeological**: read only when consulted, not at
session start. When a bug is fixed, append its entry here rather than
to the active file.

The bug breakout file at `bugs/<slug>.md` (when present) stays in place
as the historical diagnosis record; the entry here is a brief
description of the fix and the commit it landed in.

## Cross-reference resolution

`/nightshift:ready` does **not** scan this file. When a bug is fixed, every other
`**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced it is
edited at the same time to drop the now-satisfied reference (mirror of
the `FEATURES.md` convention). The active `Requires:` lines therefore
describe what is *currently* blocking; this file is purely
archaeological.

## Entries

### Scroll shield never armed for the summary actions menu

Reported and fixed 2026-08-03 (Trakt Improved 1.27). On the episode
side-panel surface, scrolling the main page behind the panel closed the
open summary actions menu; panel-internal scrolls left it open only
because element scroll events do not bubble to the app's boot scroll
listener. Root cause: the popup menu scroll shield keyed solely on
`.trakt-popup-menu-container`, and the summary actions menu
(`div.trakt-summary-actions`) is a different surface -- the shield's own
spec scoped it out with the since-falsified claim "does not close on
scroll". Fix: the shield now also arms when a summary actions menu is
rendered, keyed on the li-bearing menu element plus the
`.trakt-summary-actions-underlay` (both exist only while the menu is
open, verified live; the class alone also matches a permanently-rendered
wrapper whose nonzero rect would have armed the shield forever).
Verified live pre- and post-fix via trusted clicks and real scrolls in a
single browser_batch call, which menus survive.

### Anticipated/Uninterested quick toggles rarely take effect, and failures are silent

Closed as diagnosed 2026-08-03, no code change: the write path is
sound. Live e2e over the summary actions surface (installed Trakt
Improved 1.27): three consecutive real-click toggles (add, remove,
add) all landed server-side (verified by authenticated API reads),
the optimistic patch, icon flip, menu dismissal, and post-write sweep
all behaved, and no failure branch fired -- correctly silent, since
every coded failure path in `performToggle`/`postToggle` shows a
toast and none was taken. Root cause of the "rarely takes effect"
perception: userscript writes are invisible to the app's own UI. The
Manage lists panel renders from the app's client-side query cache and
fires no request on reopen; the app's
`trakt-marker:invalidate:*` localStorage markers are consumed only at
page load to mint the per-session `marker=` cache-busting token on
its `/v3` GETs, and the app registers no storage listener, so neither
bumping a marker key nor dispatching a synthetic StorageEvent
invalidates an open tab (all tested live). Verifying a quick toggle
through Manage lists therefore shows pre-write state until the app
self-converges (~30s observed; a reload converges immediately),
which reads as a failed toggle. Historically the same
perception was compounded by server-cache-stale sweep reads reverting
the optimistic state, closed same-tab by the 1.26 confirmed-write
ledger; the residual cross-tab fade lag was the then-open "Cross-tab
list adds miss the fade treatment" entry, fixed the next day by
fresh-membership-sweeps (see its archive entry below). The Manage-lists staleness itself is app-structural
(no invalidation channel a script can drive); the script's own
surfaces (entry icons, fades, failure toasts) remain the truthful
verification points.

### Cross-tab list adds miss the fade treatment until it eventually self-heals

Fixed 2026-08-04 by the fresh-membership-sweeps feature (Trakt
Improved 1.29, commits 13ea2f9, 899db77, 810d98f, 768ef3e plus fixups
pending autosquash; design record in
features/fresh-membership-sweeps.md). Diagnosed mechanism: the
non-writing tab noticed foreign marker movement only through
DOM-mutation-driven scans, so an idle tab waited out the 15-minute
cache TTL; server reads themselves were measured fresh within ~1.3-3s
that week, refuting the original server-cache-expiry hypothesis
(though intermittent stale windows beyond 35s also occur and are now
fenced by the same feature's marker-nonce busting). Fix shape: a
pageWindow storage listener filtered on the
trakt-marker:invalidate: prefix debounces foreign bumps through a 2s
settle timer into the shared forced-sweep trigger, so idle same-origin
tabs of one profile converge within seconds. Cross-device and
out-of-partition staleness stay TTL-driven, recorded as an explicit
anti-goal in the feature spec. E2e-verified live: a foreign bump of
the app's own listed:show marker drove exactly one sweep in an idle
tab within ~6s with zero DOM interaction.
