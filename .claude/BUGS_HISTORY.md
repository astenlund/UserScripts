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
through Manage lists therefore shows pre-write state until the app's
own next mutation-driven refetch (any native list-affecting action)
or a reload, which reads as a failed toggle. (A ~30s
self-convergence recorded here initially was falsified 2026-08-04
under 1.29: the observed flip was a confounded one-off.) Historically the same
perception was compounded by server-cache-stale sweep reads reverting
the optimistic state, closed same-tab by the 1.26 confirmed-write
ledger; the residual cross-tab fade lag was the then-open "Cross-tab
list adds miss the fade treatment" entry, fixed the next day by
fresh-membership-sweeps (see its archive entry below). The Manage-lists staleness itself is app-structural
(no invalidation channel a script can drive); the script's own
surfaces (entry icons, fades, failure toasts) remain the truthful
verification points. (Superseded for the two quick-list rows by the
manage-lists row takeover, shipped 2026-08-07 in 1.35, which makes
the drawer rows themselves script-owned truth; the
no-drivable-invalidation-channel diagnosis stays accurate.)

### Cross-tab list adds miss the fade treatment until it eventually self-heals

Fixed 2026-08-04 by the fresh-membership-sweeps feature (Trakt
Improved 1.29, commits 5f0b0ab, 648fd97, 25837e9, 1558add with review
fixes autosquashed in; design record in
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

### Injected RT chip duplicates dead native tiles instead of replacing them

Fixed 2026-08-04 in commit e013a0c (Trakt Improved 1.31). Root cause
confirmed live on The Gentleman Thief (2026): dead RT tiles render as
grayscale "-" placeholders whose anchor is a trakt-no-link self-link
back to the title page, so both rewriteRtAnchors and the hasNativeRt
guard (keyed on `a[href*="rottentomatoes."]`) were blind to them and
scan injected the icon-only chip alongside the dead pair. Fix shape: a
takeover pass (takeOverDeadRtTiles) recognizes dead RT tiles by their
icon viewBoxes (critic tomato `0 0 145 140`, audience popcorn
`0 0 80 80`; their hrefs carry nothing RT-identifying) and converts
each to native-live-tile markup: trakt-no-link -> trakt-link (restores
pointer-events), resolved RT URL plus target=_blank/rel=noopener,
inline grayscale filter cleared, and has-valid-rating added -- the grey came from TWO
stacked sources (the inline filter plus an app rule keyed on the item
lacking has-valid-rating, hidden in a cross-origin stylesheet and thus
invisible to cssRules walks; toggling classes while the inline filter
still sat on the svg confounded the first diagnosis pass). Taken-over
tiles then satisfy the untouched hasNativeRt guard, so the chip path
self-heals any pre-existing duplicate. The chip remains only as a
legacy fallback for rows with no RT tiles at all (current app markup
always renders the pair, dead or alive, on movies and shows). Also
fixed the undersized injected icons: app CSS renders tile icons at
height 14 with width from the svg's attribute aspect ratio, and the
ICONS drawings filled only about half their 24x24 viewBoxes; cropping
the viewBoxes tight to the artwork (and matching the width/height
attrs) brings them to native scale. No score fabrication: taken-over
tiles keep "-" (RT score hydration is queued in FEATURES.md as part of
the RT page bridge feature). E2e-verified via a namespaced tel2 bundle
injected alongside the installed 1.30 copy: both dead tiles taken over
with direct RT links in full color, zero RT chips from either
instance, and live-RT pages (Inception, Breaking Bad) untouched.

### New-tab links and post-navigation reloads hit a bodiless HTTP 503

Reported and worked around 2026-08-22 (Trakt Improved 1.36). Opening
any not-yet-visited app.trakt.tv link in a new tab, or reloading right
after an SPA navigation changed the URL, deterministically produced
Chrome's own "HTTP ERROR 503" page; reloading the same URL once healed
that URL only. First suspected to be the script (the membership sweep
burst, the fetch hook, link rewriting), all ruled out live: one sweep is
about 23 requests per 15 minutes shared across tabs, the fetch hook is a
pass-through, and no listener touches card or actor links. The user's
A/B with the script disabled reproduced the 503, so the defect is the
app's: its Workbox service worker (`/service-worker.js`) serves
navigations through a StaleWhileRevalidate cache keyed on the URL plus
`__auth`/`__locale`, and the cache-miss path is what fails. DevTools'
"Bypass for network" confirmed the worker as the culprit but only holds
while DevTools is open. Fix shipped as a bypass inside the script: the
whole script now runs at `document-start` (the outer IIFE became async
and awaits `DOMContentLoaded` before the document-idle-era features
run), overrides `ServiceWorkerContainer.prototype.register` on the page
with a never-settling promise so the app cannot re-register, and
unregisters existing registrations. The app registers on window load,
so the override lands first deterministically. Verified live the same
day: after unregistering, both a new tab and a reload of the formerly
controlled tab navigated without the worker
(`PerformanceNavigationTiming.workerStart` 0), so the bypass takes
effect from the first 1.36 load; only the page that did the
unregistering stays controlled until it navigates. Accepted cost,
documented at the bypass: `navigator.serviceWorker.ready` never settles
for the app, so its install prompt and anything else gated on worker
readiness silently never runs.

### Quick-list toggles fail on IMDb-slugged detail pages

Reported and fixed 2026-08-27 (Trakt Improved 1.38). On Animal Trap
(tt43750031, unreleased, year null) the app addresses the detail page
by IMDb id instead of a Trakt slug, and the quick-lists feature treated
that URL segment as the slug on both sides of its contract: postToggle
sent it as `ids: { slug }`, which the list-items write endpoints match
literally (probe: an items/remove no-op with the IMDb id as slug landed
in not_found while the canonical slug resolved), and the membership
sweep keyed items by canonical `ids.slug` only, so the page key could
never match even after a successful native add. Fix dual-keys the sweep
at the single mapping choke point (itemSlug became itemKeys: each
show/movie contributes its canonical slug key plus an IMDb alias key;
quick-target exact sets, fadeSlugs, listed counts, and the watchlisted
record all inherit the alias via flatMap) with a CACHE_VERSION bump to
6 so alias-less cached records refetch, and ships IMDb-shaped write
segments as `ids: { imdb }` via writeIds in postToggle. The optimistic
toggle and the confirmed-write ledger needed no change: they key by
whatever segment the surface handed them, which the dual-keyed sweep
now answers. Verified by .tmp/imdb-alias-logic-test.mjs over the two
extraction blocks plus live no-op probes: items/remove with the fixed
payload shape resolved cleanly (not_found empty) where the slug form
had been rejected. Diagnosis record kept in
bugs/imdb-slug-quick-list-writes.md.

### Fade controls and season list-card identity

Fixed locally 2026-09-09 in Trakt Improved 1.42. The Fade section now
supports the redesigned native segmented controls and retains legacy
checkbox support. Season list cards whose links omit the season use
their subtitle for season-specific fading instead of show membership.
Six regression tests cover identity, controls, persistence, keyboard
navigation, remounts, and idempotence. Live markup was verified; the
updated installed userscript still needs live visual verification.
Diagnosis: [fade filter controls](bugs/fade-filters-pane-anchor-lost.md).
