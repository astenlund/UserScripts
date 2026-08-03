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
