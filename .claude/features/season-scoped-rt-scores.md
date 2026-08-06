---
status: exploring
---

# Season-scoped RT scores

Captured 2026-08-06 during the score-hydration morning report, from
the user's observation on the dead-tile specimen probe: a show
summary page always has a season selected (the `season` query param;
with no param the UI defaults to season 1), so the RT tiles could
reflect the SELECTED season's scores rather than the series-level
scorecard the shipped hydration renders.

## Raw sketch

Rotten Tomatoes serves per-season pages (`tv/<slug>/s01`-style paths)
with their own scorecard blobs. The shipped bridge resolves one
series-level `rtPath` per show and hydrates from that page's
scorecard; season selection never enters the pipeline.

Questions to settle before this firms up:

- Product call: should the tomato/popcorn tiles track the selected
  season at all, or is series-level the right display (the app's own
  tiles are series-level)? A season-scoped score that silently
  replaces the series score may confuse more than it informs.
- RT season-page shape: does `tv/<slug>/s<n>` parse under the shipped
  `parseRtPage` (JSON-LD type, scorecard presence), and what happens
  for seasons RT has no page for?
- Cache shape: season-keyed `rtScores` widens the entry (per-season
  sub-map or per-season cache keys) and interacts with the
  CACHE_VERSION stamp and the 24h staleness gate.
- Page-key interplay: the shipped `pageContext` deliberately ignores
  the season query param ("shows keep their links across seasons"),
  and the hydration tracker's page key inherits that; season-scoped
  display would need a season-aware page key or a render-time season
  read, each with its own node-reuse consequences.
- Link behavior: should the tile link also point at the season page
  when a season is selected?

## Relation to shipped work

Builds on the RT page bridge (fetch transport, parse, cache,
hydration tracker). If it firms up, it is a continuation slice of
[rt-page-bridge](rt-page-bridge.md) or a sibling feature reusing its
plumbing; decide at graduation time.
