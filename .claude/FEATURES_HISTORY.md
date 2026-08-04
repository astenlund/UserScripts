# Features (history)

Implemented features, archived from `FEATURES.md` so the active backlog
stays scannable on session start. **Archaeological**: read only when
consulted, not at session start. When a feature (or a slice of a sliced
feature) ships, append its entry here rather than to the active file.

The feature breakout file at `features/<slug>.md` stays in place as the
historical design record; the entry here is a brief one-line note on
what shipped and in which feature scope or commit. If follow-up work on
the same feature changes the design meaningfully, prefer editing the
original breakout file (and adding a second entry here for the
follow-up) over creating a new file.

## Cross-reference resolution

`/nightshift:ready` does **not** scan this file. When a feature ships, every
other `**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced
it is edited at the same time to drop the now-satisfied reference (see
the convention in `FEATURES.md`'s `## Requires lines` and `## Slicing`
sections). The active `Requires:` lines therefore describe what is
*currently* blocking and the dependency graph settles as work ships.
This file is purely archaeological — read it when you want to know
what already shipped, not to resolve dependencies.

## Entries

- [Fade on list pages](features/fade-on-list-pages.md): fades extended
  from /discover to list detail pages, smart list views, and the
  /users/me/lists overview tabs, with a counts-threshold listed check
  (threshold = 1 + the containing list's contribution, resolved via
  owner/slug identity keys; cache v4). Shipped 2026-07-30 in Trakt
  Improved 1.21 (commits 4984012, a09aa96 plus fixups, 6e70829,
  6d88e73); live-verified against app.trakt.tv the same day.
- [Quick-list fade toggles](features/quick-list-fade-toggles.md): two
  new Fade-section toggles (Anticipated, Uninterested) carved out of
  the Listed counts, mirroring Watchlisted: set-based categories over
  each quick target's fadeSlugs, own-surface exclusion via target
  identity keys, an overview positive-identification gate, and a
  counts-free optimistic toggle patch (cache v5, FADE_CATEGORIES
  split keeping the record-driven staleness machinery on the four
  cache-backed categories). Absorbed the former "Lane-identity
  contribution on overview list lanes" entry; live verification found
  the overview markup changed (lists render as summary cards without
  media-card previews), so that machinery is dormant robustness on
  the current shape. Shipped 2026-08-01 in Trakt Improved 1.22
  (commits b183da5, 28c666a, 601b4f1, 8520fc8, e5d650e plus fixups);
  live-verified against app.trakt.tv the same day.
- [Popup menu scroll shield](features/popup-menu-scroll-shield.md):
  keeps card and list-page kebab popups open while the page scrolls
  (two window capture-phase passive listeners swallow wheel and
  scroll while a rendered menu ul is at least partially in the
  viewport; once the menu is fully offscreen events pass through and
  the app closes its own menu). E2e surfaced that the popup container
  is a zero-height positioning anchor on list surfaces, so the rect
  source is the inner ul. Shipped 2026-08-02 in Trakt Improved 1.24
  (commit 049853b); live-verified against app.trakt.tv
  the same day.
- [Fresh membership sweeps](features/fresh-membership-sweeps.md):
  membership sweep GETs now carry a per-collection cache-busting
  marker nonce (shared bustedGet wrapper, per-tab 400/422
  busting-disabled latch), and a pageWindow storage listener sweeps
  promptly on another tab's trakt-marker:invalidate:* bump (2s settle
  debounce into the shared triggerForcedSweep helper). Fixes the
  same-tab 30s fade revert and the cross-tab fade staleness for
  same-origin tabs of one profile. Shipped 2026-08-04 in Trakt
  Improved 1.29 (commits 5f0b0ab, 648fd97, 25837e9, 1558add with
  review fixes autosquashed in); e2e-verified live with a namespaced
  page-context build (all sweep URLs busted; a foreign marker bump
  drove exactly one sweep in an idle tab within ~6s).
