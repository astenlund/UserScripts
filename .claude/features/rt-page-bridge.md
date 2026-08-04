# RT page bridge: link verification and score hydration

Fetch the resolved Rotten Tomatoes page itself and use it two ways:
confirm that the RT link the script serves actually belongs to the
title being viewed (demoting mismatches to a title search), and fill
the "-" values on taken-over dead RT tiles with real critic and
audience scores.

## Motivation

Two observations drive this, both from 2026-08-04:

- RT links sometimes land on the wrong movie or show. The script
  already repoints every native RT anchor at the Wikidata-bridged path
  (or a title search when no path resolves), so a wrong direct link
  today means the bridge itself resolved wrongly: the P345 full-text
  search matched the wrong entity, or the entity's P1258 value is
  stale or wrong. Nothing checks the destination.
- The dead-RT-tile takeover (shipped in 1.31, see BUGS_HISTORY.md)
  produces linked tomato/popcorn tiles that still show "-" because the
  script has no score source. The same page fetch that verifies the
  link carries both scores.

## Feasibility (probed 2026-08-04)

A plain HTTPS GET of `https://www.rottentomatoes.com/m/inception` with
a browser User-Agent returns the full page (no bot wall on this
probe). The page contains:

- JSON-LD (`<script type="application/ld+json">`) with `@type`
  (`Movie`), `name`, and `dateCreated` (`2010-07-16`).
- A scorecard JSON blob with
  `"criticsScore":{...,"score":"86","scorePercent":"86%",...}` and
  `"audienceScore":{...,"score":"91",...}`.

TV pages (`tv/<slug>`) were not probed; their JSON-LD type and date
field names must be confirmed at implementation time.

## Mechanism

One shared fetch-and-parse helper feeds both slices:

- `fetchRtPage(rtPath)` GETs `https://www.rottentomatoes.com/<rtPath>`
  via `gmFetchJson`'s transport sibling (GM_xmlhttpRequest for the
  text body; the page CSP never sees the request). Requires adding
  `@connect www.rottentomatoes.com` to the userscript header, which
  Tampermonkey grants without prompting because it is declared.
- Parsing extracts `{ name, year, criticsScore, audienceScore }` from
  the JSON-LD block and the scorecard blob.
- **Failure mode (explicit):** the helper returns a tri-state result,
  never throws to its caller: `{ status: 'ok', data }`,
  `{ status: 'mismatch-shape' }` (page fetched but expected fields
  absent, i.e. RT changed markup), or `{ status: 'error' }` (network,
  timeout, HTTP error). Callers must treat `mismatch-shape` and
  `error` as "unknown", not as "wrong link": a failed check is not a
  failed verification, and demoting a good link to search on a
  transient fetch error would be a regression.

Verification runs inside `resolveIds`, after `fetchRtPath` returns a
path and before `cachePut`: one RT fetch per resolution, no separate
scan pass. Comparison inputs come from data already in hand: the
Trakt API response in `fetchTraktIds` includes `title` and `year`
(extend its return value; today it keeps only ids). The Trakt year
is consumed at resolution time only and is NOT cached:
re-verification happens inside a later `resolveIds` run, which
re-fetches the Trakt ids anyway, so a cached year would be a
write-only field.

Match rule (year is the primary signal, title secondary):

- Year differing by more than 1 from Trakt's year: **mismatch**.
  Wrong-entity bridges (the observed failure) essentially always get
  the year wrong; the +-1 tolerance absorbs festival-vs-wide-release
  boundary years.
- Year within tolerance: **match**, even when the titles differ.
  Titles legitimately diverge across the two sites (alternate and
  localized titles), so title-only mismatch must not demote; log a
  `warn` with both titles instead so field reports can firm the rule
  up later.

Verdict handling in the cache entry:

- match: store `rtPath` with `rtVerified: true`, plus `rtScores`
  parsed from the page already in hand (the opportunistic storage
  slice 2 renders).
- mismatch: store `rtPath: null` (the search fallback takes over
  everywhere downstream, which is the requested behavior) and
  `rtScores: null`: the page in hand belongs to the wrong title, so
  scores from a rejected page are never cached. The rejected path is
  not separately remembered: if Wikidata still returns it at the
  next TTL refetch, verification rejects it again at the cost of one
  fetch per cycle.
- unknown (helper returned `mismatch-shape` or `error`): store
  `rtPath` with `rtVerified: false` and `rtScores: null` (no trusted
  page in hand), and keep serving the direct link (status quo; no
  regression on transient failures). Entries with
  `rtVerified: false` are re-verified the next time `resolveIds` runs
  for that key, which in practice means the next TTL refetch (~30
  days), since scan only calls `resolveIds` on cache miss or expiry.
  That cadence is deliberate: a scan-side gate on
  `rtVerified === false` would re-run the whole Trakt + Wikidata + RT
  chain unthrottled (scan runs per animation frame and nothing in
  this path records into the failure backoff), so do not "improve"
  the wording into that.

A Trakt-side `year` that is null or absent also yields **unknown**
(store the path, `rtVerified: false`, `rtScores: null` like the
other unknown producers): with no year to compare, a mismatch cannot
be established, and a failed comparison input is not a failed
verification. Here the parsed page IS in hand, and discarding its
scores is deliberate: it keeps resolution-time score storage
match-only (one uniform rule across the non-match verdicts), at the
cost of one deduped hydration fetch of the same page on the first
tracked scan. Hydration-side storage is, by contrast, deliberately
verdict-agnostic: an unknown-verdict entry's direct link is already
being served, and its scores follow the served link's fate. Do not
"harden" the hydration gate with an `rtVerified === true` condition;
that would starve every unknown-verdict title of scores until the
~30-day TTL.

Entries whose `rtPath` is null (mismatch demotion above, or the
pre-existing Wikidata-has-no-path case) store `rtVerified: false`:
the flag is meaningful only alongside a non-null path (`rtUrl` keys
on `rtPath` alone), so any fixed value works, and false keeps the
"unverified by default" reading consistent.

## Cache entry changes and their consumers

The entry under `trakt-external-links-cache` grows from
`{ imdb, tmdb, rtPath, fetchedAt }` to
`{ imdb, tmdb, rtPath, rtVerified, rtScores, fetchedAt }` where
`rtScores` is `{ critics, audience, fetchedAt }` or null. Every
consumer of the entry shape, including the ones this change leaves
untouched:

- `loadCache` / `CACHE_VERSION`: bump the version to 2; old entries
  are discarded wholesale and refetched (the stamp exists for exactly
  this).
- The entry-shape comment above `loadCache` (documents the shape
  verbatim): update it to the widened shape or it rots silently.
- `cacheGet`: unchanged (shape-agnostic beyond `fetchedAt`).
- `cachePut`: unchanged mechanics; callers write the wider shape.
- `resolveIds` (the entry's sole writer today): writes the widened
  shape including the verification verdict and, on a match verdict
  only, `rtScores` from the same verification fetch; slice 2's
  staleness refetch becomes the second writer, for `rtScores` only.
- `rtUrl`: unchanged (`rtPath` null still falls back to search).
- `lbUrl`: unchanged (`imdb` / `tmdb` untouched).
- `scan`: gains the hydration call (slice 2); TTL-refresh logic
  unchanged.
- The e2e bundle build (`.tmp/build-tel2-e2e.mjs`) shares the cache
  key with the installed copy on the assumption of identical
  CACHE_VERSION; after the bump, a stale rebuilt bundle running
  beside a newer installed copy would ping-pong the cache. Rebuild
  the bundle from the same source revision before any e2e run (the
  existing e2e guidance in CLAUDE.md already covers this trap).

## Slices

- **MVP: link verification.** The fix requested for wrong RT links:
  verify at resolution time, demote mismatches to search. Ships
  without touching tile rendering.
- **Continuation: score hydration.** Fill the "-" on taken-over dead
  RT tiles from `rtScores` (critic score into the tomato tile,
  audience into the popcorn tile). **Discriminator:** after takeover,
  a taken-over tile is markup-identical to a live native tile, and
  marker attributes do not survive on app-managed nodes (Svelte
  strips them; see the buildChip comment), so "which tiles may I
  write" cannot be answered by inspecting the row. Instead the
  feature tracks taken-over tiles in closure state:
  `takeOverDeadRtTiles` returns the tiles it processed this pass,
  and a tracker accumulates them in a plain array deduped by node
  identity (a WeakSet cannot be iterated, so it cannot serve here).
  On every scan pass the tracker is re-filtered to `isConnected`
  nodes (disconnected ones drop out, releasing them) and **cleared
  whenever the page key changes**: Svelte reuses row nodes across
  SPA navigations, so without the page-key clear a tile tracked on
  a dead-tile title could survive as another title's live native
  tile and be overwritten. The page-key clear first resets each
  still-connected tracked tile's value text to "-", guarded by a
  per-tile record of the last text the script wrote (only
  script-written text is reset; text Svelte has already repatched is
  left alone): node reuse means a score written on title A can
  otherwise survive into title B's tiles, where the leave-alone
  render branch below would preserve it. For the same reason, slice
  2 extends the takeover pass to normalize a taken tile's value text
  to "-" when it reads anything else -- the one childList write in
  the pass, compare-guarded so it fires at most once per anomaly and
  cannot loop the body observer. (The class/href dimension of node
  reuse was e2e-probed 2026-08-04 with a dead-to-dead SPA
  navigation under the shipped takeover: the end state self-heals,
  since a surviving RT href is re-synced by rewriteRtAnchors and a
  restored dead form is re-taken. Text survival cannot be probed
  until scores exist to write, hence the two guards.) Hydration runs
  on every scan pass over the tracked set, after the takeover call
  in the same pass: takeover writes are attribute-level and never
  queue a follow-up scan, so a render placed before the takeover
  would leave freshly re-taken tiles unhydrated until the next
  app-driven mutation. Live native tiles are structurally excluded:
  they never enter the takeover loop, so they never enter the
  tracker, even when their native score disagrees with RT's. A
  same-title Svelte re-render that restores the dead "-" form is
  re-taken and re-tracked on the next scan. The value write targets
  the `.rating-value p` text and compares before writing
  (idempotence); text writes are childList mutations, so an
  unconditional write would re-trigger the shared body observer
  every frame, exactly the loop the idempotence rule at the top of
  CLAUDE.md exists to prevent. **Score source, refetch, and
  throttle:** the MVP's verification fetch already has the RT page
  in hand, so `resolveIds` stores `rtScores` at resolution time on
  match verdicts (see verdict handling; a rejected page's scores are
  never cached, failed or misparsed fetches have nothing to
  contribute, and unknown-verdict entries hydrate through the gate
  below instead) and the fresh-resolution path hydrates without a
  second fetch. The hydration-side refetch fires when all three
  hold: the tracked set is nonempty; the entry's `rtPath` is
  non-null (a null path means demoted-to-search or
  Wikidata-has-no-path, so there is nothing to fetch and the render
  rule below resets the tiles to "-"); and `rtScores` is null
  (treated as infinitely stale; the state of every unknown-verdict
  entry) or its `fetchedAt` is older than 24h (independent of the
  month-long id TTL). The fetch is deduped through an in-flight set
  mirroring `resolveIds`' (hydration runs per scan pass, so passes
  during the in-flight window would otherwise launch duplicates),
  and its completion writes the cache and calls `queueScan()`
  (mirroring `resolveIds`) so the scores reach the DOM without
  waiting for an app-driven mutation. A failed or shape-mismatched
  fetch still writes
  `rtScores: { critics: null, audience: null, fetchedAt }` with the
  fetch-start time: the stamp is what arms the 24h gate. Because
  hydration runs on every scan pass, the stamp and the in-flight
  dedup are both load-bearing, not defense-in-depth. The render
  rule splits by cause: when the entry is absent or its `rtPath` is
  null (mid-session demotion or cache eviction), the write target
  is "-" -- the compare-before-write keeps the reset idempotent,
  and it clears previously rendered scores that a demotion has just
  disowned, which "leave unchanged" would wrongly keep on display;
  when `rtPath` is non-null and only the score fields are null
  (unknown verdict, failure stamp), leave the current text alone,
  so a transient refresh failure does not blank last-known-good
  scores for up to 24h. The resulting display/cache asymmetry
  (in-memory tiles keep last-known-good text after a failure stamp;
  a reload shows "-" until the 24h gate refetches) is accepted --
  do not "fix" the stamp to avoid it.

## Open questions

- GM_xmlhttpRequest against RT in the wild: the probe used curl from
  a residential IP; Cloudflare-style bot checks may still challenge
  extension-background requests at volume. Mitigation if hit: verify
  lazily (only for titles actually viewed) and cache hard. Note what
  actually throttles each path: for the MVP it is the cache TTL (an
  unknown verdict still caches successfully, so the failure backoff
  never records); for score hydration it is the stamped-on-failure
  `rtScores.fetchedAt` described in the slice.
- `tv/` page shape (JSON-LD type, date field, scorecard presence)
  unprobed; confirm before relying on year checks for shows.
- Whether the audience "-" tile should show the popcorn score type
  RT displays by default (`ALL`) or the verified-audience variant;
  cosmetic, decide at implementation.
