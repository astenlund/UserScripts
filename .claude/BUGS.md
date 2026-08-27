# Bugs

Known bugs awaiting attention. Short entries live here; bugs that need
more than a few lines of description graduate to a dedicated file under
`.claude/bugs/<slug>.md`.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `QUICK_WINS.md`, `FEATURES.md`, `PATTERNS.md`).
When a bug is fixed, append its entry to
[`BUGS_HISTORY.md`](BUGS_HISTORY.md); do not keep a `## Fixed` section
inline.

## Requires lines

**Every open bug entry carries a `**Requires:**` line** declaring what
must be in place before the fix can land. Comma-separated, same shape
as `FEATURES.md` (long lines may wrap; `/nightshift:ready` joins them before
parsing):

- A markdown link to a feature, quick win, or bug. The reference is a
  current blocker; under the walk-and-remove convention below, a
  satisfied dependency is edited out of the line at the moment it
  ships or is fixed.
- Bare text. An external primitive (driver release, vendor support,
  user decision) the user confirms case by case.
- The literal word `none.` if the fix is unblocked.

A missing `Requires:` line is a structural error. `/nightshift:ready` parses these
lines. History entries don't carry `Requires:` lines.

**When a bug is fixed**, move its entry to
[`BUGS_HISTORY.md`](BUGS_HISTORY.md) with a brief note on the fix and
the commit it landed in; drop its `Requires:` line in the move. If the
bug had its own file, keep the file in place as a historical record of
the diagnosis.

**Then walk every other `**Requires:**` line in `FEATURES.md` and
`BUGS.md`** and remove references to the just-fixed bug: if it was the
only item on the line, set the line to `Requires: none.`. Mirror of the
`FEATURES.md` walk-and-remove convention — `/nightshift:ready` never has to
consult `BUGS_HISTORY.md`.

## Open

### Summary-page quick-list rows stay greyed out until Manage lists opens

On a single movie or show details page, the script-owned
`data-qlt-entry` rows for Anticipated and Uninterested remain visually
greyed out until the Manage lists panel has been opened once. It is not
yet known whether this reproduces on every cold details-page load or
only under some timing conditions. Identify the disabled-state carrier
and determine whether opening the panel initializes membership or
rendering state that subsequently heals the summary-menu rows.

**Requires:** none.

### RT score hydration uses the fresh icon for rotten scores

Reported on Ice Cream Man (2026). Trakt Improved renders a tomato icon
beside the 27% Rotten Tomatoes critic score, while the Rotten Tomatoes
page classifies the score as Rotten and renders the green splat icon.
Render the Rotten icon when the hydrated critic score is classified as
Rotten; the observed mismatch is on the summary rating tile.

**Requires:** none.

### RT score hydration can break Trakt's Svelte page hydration

Reported on `https://app.trakt.tv/movies/super-troopers-3-2026` while
the Rotten Tomatoes rating tiles were being hydrated. Trakt logs
`Failed to hydrate: TypeError: e.removeAttribute is not a function`
from `+layout.svelte:96`. Investigate whether `trakt_improved.user.js`
mutates an app-owned rating node before Svelte finishes hydrating it;
the cause is not yet confirmed. Refreshing the page cleared the failure,
which makes an initialization-order timing issue highly likely and
strengthens the early DOM mutation hypothesis.

**Requires:** none.

### [Quick-list toggles fail on IMDb-slugged detail pages](bugs/imdb-slug-quick-list-writes.md)

Reported on Animal Trap (tt43750031, unreleased): the app addresses
some titles by IMDb id in the URL, and the quick-lists feature treats
that segment as the Trakt slug on both sides of its contract, so adds
land in `not_found` (writes send `ids: { slug }`) and membership
display never matches the sweep's canonical-slug keys. Root cause
confirmed by live API probe; full diagnosis and three candidate fix
paths in the bug file.

**Requires:** none.

### [Fade filters lost their filter-pane anchor](bugs/fade-filters-pane-anchor-lost.md)

trakt.tv redesigned the filters panel (2026-08-11), so the injected
Fade section no longer renders: `ensureFadeSection`'s clone source
`div.trakt-display-section` no longer matches and the function returns
early without warning. Card fading still runs from saved state, but the
pane's fade toggles (and the Started-row mode hiding) are gone. Full
anchor surface and fix path in the bug file.

**Requires:** none.

## History

Fixed bugs are archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md), loaded
on demand only (not at session start) so the active list above stays
scannable. When a bug is fixed, append its entry there rather than to
this file, AND walk every other `**Requires:**` line in `FEATURES.md`
/ `BUGS.md`: remove the now-satisfied reference (if it was the only
one, set the line to `Requires: none.`). The active `Requires:` lines
describe what is *currently* blocking, so `/nightshift:ready` never has to consult
the history file — the dependency graph settles as bugs are fixed.
