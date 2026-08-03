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

### Injected RT chip duplicates dead native tiles instead of replacing them

On summary pages where the native ratings row renders dead Rotten
Tomatoes tiles (the critic tomato and audience popcorn icons showing
"-" with no link), initExternalLinks in trakt_improved.user.js still
injects its icon-only RT chip, so the row shows duplicate RT icons
(observed 2026-08-02 on Hadestown: The Musical). Hypothesis: the
`hasNativeRt` guard in `scan` keys on an `a[href*="rottentomatoes."]`
being present, and dead tiles render without an RT href, so the guard
reads the row as having no native RT and adds a chip alongside the
dead pair. Desired shape: when dead native RT tiles exist, take them
over (repoint at the resolved RT URL) instead of adding a chip; when
the row has no RT presence at all and a direct RT path is known,
inject both tiles the way native renders them (critic and audience);
fall back to a single icon-only chip only for the title-search
fallback. Also upsize the injected icon: the `ICONS` SVGs render at
18x18, visibly smaller than native tile icons. Open design question:
the request says both critic and audience "scores" like native, but
the script has no RT score source today (Wikidata bridges only the
path), so decide at design time between linked icon tiles without
numbers or adding a score source.

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
