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

### Truncate fails with an item count mismatch for minutes after adds

Truncate walks Uninterested in the list's own order, but Trakt refreshes
only page 1 of a cached paginated read on a write. When an earlier read
of the same shape (Truncate's plain walk, such as a previous run) cached
the list's later pages before an add, the walk misses the new entries
for up to about 5.5 minutes and the completeness guard fails closed with
"Item count mismatch" (nothing is removed); a page that was not cached
reads fresh, so reproducing this needs a walk of the later pages before
the add. Sketch: select from the added-order read the membership sweep
uses since Trakt Improved 1.50 (oldest-added walk plus the fresh
newest-added page 1), keeping the fail-closed guard. Diagnosis:
[quick-list adds lose fade](bugs/quick-list-adds-lose-fade.md).

**Requires:** none.

### Quick-list removes past page 1 re-fade for minutes after the write

A quick-list remove of an entry that sits past page 1 of the membership
sweep's oldest-added walk (for example undoing a recent add to
Uninterested, which holds about 546 entries) unfades at once, then
re-fades when the 30-second confirmed-write ledger expires, because
Trakt's later-page cache keeps listing the entry for about 5.5 minutes
after the write. The sweep that re-fades it stamps the membership
cache fresh, so the fade stays until the first sweep after the server
copy expires: without another write or invalidation-marker bump, that
is the 15-minute membership TTL. Native removes past page 1 read stale
the same way. Candidate
fix: keep the ledger's protection for a remove while the only
contradicting evidence comes from pages past page 1. Diagnosis:
[quick-list adds lose fade](bugs/quick-list-adds-lose-fade.md).

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
