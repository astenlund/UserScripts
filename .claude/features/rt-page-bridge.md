# RT page bridge: link verification and score hydration

Status: signed off 2026-08-05 18:05, content: 0c7c810e

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

TV pages were probed 2026-08-05 (rendered browser,
`tv/breaking_bad`): JSON-LD `@type` `TVSeries` with the same `name`
and `dateCreated` fields (`2008-01-20`, the premiere date, matching
Trakt's first-aired year), and the scorecard blob present with the
same `criticsScore`/`audienceScore` score fields.

## Mechanism

One shared fetch-and-parse helper feeds both slices:

- `fetchRtPage(rtPath)` GETs `https://www.rottentomatoes.com/<rtPath>`
  via `gmFetchJson`'s transport sibling (GM_xmlhttpRequest for the
  text body; the page CSP never sees the request). Requires adding
  `@connect www.rottentomatoes.com` to the userscript header, which
  Tampermonkey grants without prompting because it is declared.
- Parsing extracts `{ name, year, criticsScore, audienceScore }` from
  the JSON-LD block and the scorecard blob. Required-field contract:
  `name` and `year` are required for `ok` (`year` as a number parsed
  from the JSON-LD date field's leading four digits); the score
  fields are optional and null when the scorecard blob (or one
  score) is absent or unparsable, which is legitimate on unreleased
  or score-less titles. A page whose `name` or `year` cannot be
  parsed is `parse-failure`, never a silent pass into comparison:
  the year gate must only ever see two real numbers.
- **Failure mode (explicit):** the helper returns a four-state
  result, never throws to its caller: `{ status: 'ok', data }`,
  `{ status: 'not-found' }` (HTTP 404 or 410 after redirects: RT
  positively reports that no page exists at this path),
  `{ status: 'parse-failure' }` (page fetched but a required field
  is absent, i.e. RT changed markup or served an interstitial), or
  `{ status: 'error' }` (network, timeout, any other HTTP error).
  Callers must treat `parse-failure` and `error` as "unknown", not
  as "wrong link": a failed check is not a failed verification, and
  demoting a good link on a transient fetch error or a
  bot-challenge interstitial (which arrives as a 200 or 403 without
  the expected markup, indistinguishable from a markup change)
  would be a regression. `not-found` is different in kind: it is
  RT's definitive statement that the path is dead, the stale-P1258
  case Motivation names, so it demotes like a mismatch. This
  mirrors the script's existing definitive-miss vs
  transient-failure distinction (the list-item-counts feature's
  deleted-list tombstone, `{ gone: true, fetchedAt }` in
  `initListCounts`). 403/429/5xx stay in `error` deliberately: they are
  what a bot wall returns, and a bot wall must never demote links.

Verification runs inside `resolveIds`, after `fetchRtPath` returns a
path and before `cachePut`: one RT fetch per resolution, no separate
scan pass. Comparison inputs come from data already in hand: the
Trakt API response in `fetchTraktIds` includes `title` and `year`
(extend its return value; today it keeps only ids). The Trakt year
is consumed at resolution time only and is NOT cached:
re-verification happens inside a later `resolveIds` run, which
re-fetches the Trakt ids anyway, so a cached year would be a
write-only field.

Match rule: two independent signals, year and title; demotion
requires both to disagree.

- Year signal: agree when the RT year is within +-1 of Trakt's year
  (the tolerance absorbs festival-vs-wide-release boundary years);
  disagree otherwise. Hidden assumption, surfaced: RT's JSON-LD
  date is a US-release-flavored date while Trakt's `year` is the
  original release year, so restorations, re-releases, and delayed
  distribution can legitimately diverge by more than a year on a
  correctly bridged page. That is why year disagreement alone must
  not demote. For shows, Trakt's `year` is the first-aired year,
  and the design carried a contingency: under latest-season RT
  date semantics the year signal would have disagreed for every
  multi-season show (degrading title-agreeing shows to uncertain
  and wrongly demoting title-divergent ones, e.g. leading
  qualifiers like "Marvel's Daredevil" vs "Daredevil" that the
  prefix-anchored extension rule cannot absorb), requiring shows
  to be exempted from the year signal. The tv live-shape probe
  settled it 2026-08-05: RT's tv `dateCreated` is the premiere
  date (Breaking Bad: `2008-01-20`), so first-aired comparison
  holds and the contingency did not materialize.
- Title signal: normalize both titles: case-fold; strip diacritics
  (Unicode NFD, drop combining marks); delete apostrophes (U+0027,
  U+2019, U+02BC); replace every remaining character that is not a
  letter, digit, or whitespace with a space; collapse whitespace;
  drop one leading English article (the/a/an). Agree when the
  normalized titles are equal, or when the longer raw title extends
  the shorter at a subtitle separator immediately following the
  shorter title's text (a colon, an opening parenthesis, or a
  space-surrounded dash: U+002D, U+2010, U+2013, or U+2014); the
  part before that separator must normalize equal to the shorter
  title.
  This absorbs subtitle and edition variants without letting "Up"
  match "Up in the Air"; a bare character- or token-prefix rule was
  considered and rejected for exactly that false confirm. Disagree
  otherwise. If either normalized title is empty, or the Trakt
  title is null, the title signal is **unavailable**: neither agree
  nor disagree.
- Verdicts from the two signals:
  - Year agrees AND title agrees: **match**.
  - Year agrees; title disagrees or unavailable: **uncertain**.
    Same-year wrong-title resolutions are field-observed
    (2026-08-05), so year alone cannot confirm; but titles also
    legitimately diverge across the two sites (alternate and
    localized titles), so title disagreement alone must not demote
    either. Log a `warn` with both raw titles and both years (a
    null side is logged as-is, so the warn content is defined even
    when the title signal was unavailable).
  - Year disagrees; title agrees or unavailable: **uncertain**, for
    the symmetric reason: observed wrong-entity bridges get BOTH
    signals wrong (a wrong entity almost never carries the same
    title), while a lone year disagreement is at least as likely
    the date-semantics divergence above on a correct page. Demoting
    here would be destructive, self-perpetuating (the rejected path
    would be re-derived every TTL cycle), and unappealable
    (mismatch entries carry no `rtTitle`/`rtYear` for the confirm
    slice). Log the same `warn` shape: both raw titles and both
    years.
  - Year disagrees AND title disagrees: **mismatch**. Both
    independent signals point at a different work; demote.

An uncertain entry keeps the direct link (status quo) and records
the verdict; the click-time confirm slice turns it into a one-time
user question.

Verdict handling in the cache entry. `rtVerified` is a small enum:
`'auto'` (machine-confirmed match), `'uncertain'` (the two signals
reached neither joint agreement nor joint disagreement: one
disagrees while the other agrees, or the title signal is
unavailable), `false` (unverified/unknown); `'user'` is reserved
for the click-time confirm slice.

- match: store `rtPath` with `rtVerified: 'auto'`, plus `rtScores`
  parsed from the page already in hand (the opportunistic storage
  the score-hydration slice renders). `critics` and `audience` are
  integers 0-100 parsed from the scorecard's `score` strings, or
  null when the scorecard (or that score) was absent on an
  otherwise parseable page. The numeric encoding is pinned here
  because the field persists under the version stamp and is read by
  a later slice; percent formatting is a render-time concern.
  `rtScores.fetchedAt` is stamped with the verification fetch's
  start time, the same stamp semantics the hydration slice's
  failure path uses.
- uncertain: store `rtPath` with `rtVerified: 'uncertain'`,
  `rtScores: null` (the page in hand may belong to a different
  work, so resolution-time score storage stays match-only), and
  `rtTitle`/`rtYear` from the parsed page: the click-time confirm
  slice needs the RT-side identity at click time, and storing it
  now gives that slice's open ruling everything it needs with no
  further entry widening. (Where the slice persists a not-it ruling
  across TTL refetches is that slice's own open design question;
  additive options exist that need no wipe.) The direct link keeps being
  served; the score hydration slice's verdict-agnostic gate treats
  the entry like an unknown one (its scores follow the served
  link's fate). The verdict is re-derived at the next TTL refetch
  like any other; carry-forward of user rulings across refetches
  belongs to the click-time confirm slice.
- mismatch: store `rtPath: null` (the search fallback takes over
  everywhere downstream, which is the requested behavior) and
  `rtScores: null`: the page in hand belongs to the wrong title, so
  scores from a rejected page are never cached. The rejected path is
  not separately remembered: if Wikidata still returns it at the
  next TTL refetch, verification rejects it again at the cost of one
  fetch per cycle. Log a `warn` carrying the discarded path, both
  raw titles, both years, and a reason token (`both-disagree`):
  demotion is the MVP's only destructive action, and
  without the log nothing distinguishes "verification discarded a
  working link" from "no path ever resolved". Accepted residual
  risk, named: a FALSE both-signals demotion (a foreign or
  re-released title whose year diverges and whose RT title shares
  no separator-anchored overlap) is permanent across all planned
  slices: the entry stores no `rtTitle`/`rtYear` and the confirm
  slice intercepts only uncertain anchors, so the recovery surface
  is the search link itself.
- not-found (helper returned `not-found`): store `rtPath: null`,
  `rtScores: null`, `rtVerified: false`, exactly like a mismatch:
  RT positively reported the path dead, and a dead direct link is
  strictly worse than the search fallback. No comparison runs;
  there is no page identity to compare. Log the same demotion
  `warn` shape with reason token `not-found`; the title and year
  slots carry the Trakt-side values and null for the RT side.
- unknown (helper returned `parse-failure` or `error`): store
  `rtPath` with `rtVerified: false` and `rtScores: null` (no trusted
  page in hand), and keep serving the direct link (status quo; no
  regression on transient failures). Entries with
  `rtVerified: false` are re-verified the next time `resolveIds` runs
  for that key, which in practice means the next TTL refetch (~30
  days), since scan only calls `resolveIds` on cache miss or expiry.
  That cadence is deliberate: a scan-side gate on unverified entries
  would re-run the whole Trakt + Wikidata + RT chain unthrottled
  (scan runs per animation frame and nothing in this path records
  into the failure backoff), so do not "improve" the wording into
  that.

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
"harden" the hydration gate with an `rtVerified === 'auto'`
condition; that would starve every unknown- and uncertain-verdict
title of scores until the ~30-day TTL.

Entries whose `rtPath` is null (mismatch or not-found demotion
above, or the pre-existing Wikidata-has-no-path case) store
`rtVerified: false`:
the flag is meaningful only alongside a non-null path (`rtUrl` keys
on `rtPath` alone), so any fixed value works, and false keeps the
"unverified by default" reading consistent.

## Cache entry changes and their consumers

The entry under `trakt-external-links-cache` grows from
`{ imdb, tmdb, rtPath, fetchedAt }` to
`{ imdb, tmdb, rtPath, rtVerified, rtTitle, rtYear, rtScores,
fetchedAt }` where `rtScores` is `{ critics, audience, fetchedAt }`
or null, and `rtTitle`/`rtYear` are non-null only on uncertain
verdicts (the confirm slice's click-time inputs; every other verdict
stores null for both). Every
consumer of the entry shape, including the ones this change leaves
untouched:

- `loadCache` / `CACHE_VERSION`: bump the version to 2; old entries
  are discarded wholesale and refetched (the stamp exists for exactly
  this). The file has three same-named `CACHE_VERSION` constants in
  separate IIFEs; the one to bump is the `initExternalLinks` copy.
  Two reasons the bump beats lazy widening (leaving v1 entries in
  place and treating the new fields as absent): it forces immediate
  re-verification of every cached path instead of a ~30-day rollout
  of the feature's whole point, and it spares every later consumer
  the undefined-vs-null distinction on legacy entries (the
  score-hydration gate keys on `rtScores` being null; a legacy
  entry would carry undefined). Known, accepted cost during the
  upgrade window: a still-open tab running the pre-bump script and
  a freshly loaded tab ping-pong the cache (each instance rewrites
  the whole blob under its own version stamp), the e2e trap below
  but between real versions. It is bounded and self-heals once old
  tabs reload; supporting cross-version tab coexistence is an
  anti-goal.
- The entry-shape comment above `loadCache` (documents the shape
  verbatim): update it to the widened shape or it rots silently.
- `cacheGet`: unchanged (shape-agnostic beyond `fetchedAt`).
- `cachePut`: unchanged mechanics; callers write the wider shape.
- `resolveIds` (the entry's sole writer today): writes the widened
  shape including the verification verdict and, on a match verdict
  only, `rtScores` from the same verification fetch. Future writers,
  by slice name: the click-time confirm slice writes `rtVerified`
  (and `rtPath`, on a not-it ruling) from user rulings; the
  score-hydration slice's staleness refetch writes `rtScores`.
- `rtUrl`: unchanged (`rtPath` null still falls back to search).
- `lbUrl`: unchanged (`imdb` / `tmdb` untouched).
- `scan`: gains the hydration call (score-hydration slice);
  TTL-refresh logic unchanged.
- The e2e bundle build (a `.tmp/` build script, regenerated per e2e
  session since `.tmp/` is ephemeral scratch): per the CLAUDE.md
  e2e guidance, an injected build renames the cache key (and every
  other version-stamped key), which is the remedy that makes
  version ping-pong impossible; the `## Verification plan (MVP)`
  setup below follows it. The ping-pong trap therefore applies only
  to a NON-renamed rebuilt bundle sharing the installed copy's key,
  where two different CACHE_VERSION values re-normalize each
  other's cache on every load; if such a shared-key run is ever
  unavoidable, rebuild the bundle from the same source revision as
  the installed copy.

## Slices

- **MVP: link verification.** The fix requested for wrong RT links:
  verify at resolution time under the two-signal match rule, demote
  to search only when year and title both disagree or RT reports
  the path dead, record every intermediate outcome (a lone
  disagreement or an unavailable title signal) as `uncertain` for
  the click-time confirm slice. Full footprint: the
  `fetchRtPage` helper plus `@connect www.rottentomatoes.com`,
  `fetchTraktIds` widened to return title and year, the cache entry
  widening with the CACHE_VERSION 1 -> 2 bump (full cache wipe),
  the match-verdict `rtScores` write, and the uncertain-verdict
  `rtTitle`/`rtYear` write. Ships without touching
  tile rendering; uncertain links stay direct and just log. Pass
  conditions in `## Verification plan (MVP)`.
- **Continuation: click-time confirm.** Turns the MVP's `uncertain`
  verdict into a one-time question asked only when the wrongness
  could bite: a plain left-click on an uncertain RT anchor is
  intercepted (modified clicks -- ctrl, middle -- pass through with
  the direct link; hijacking new-tab intents is hostile and the
  next plain click still asks) and a small popup, reusing the
  script's existing popup machinery, shows the RT page's title and
  year against the viewed title and year with two choices: open
  (writes `rtVerified: 'user'`; this and future clicks go direct)
  or not-it (demotes: `rtPath: null`, search fallback everywhere,
  and opens the search now). The popup reads the RT-side identity
  from the `rtTitle`/`rtYear` fields the MVP already stores on
  uncertain verdicts, so no fetch happens at click time. A TTL
  refetch that resolves the same `rtPath` the user already
  ruled on carries the user verdict forward instead of re-deriving
  `uncertain`; a changed path is new information and re-enters the
  normal verdict flow. Open questions, deliberately undesigned,
  decided when this slice is designed in earnest: dismissal
  behavior (Esc / click-away -- no navigation and re-ask next
  click, vs fall through to the direct link), and where a not-it
  ruling persists across TTL refetches (an additive field or a new
  `rtVerified` value with `rtPath` kept; either way no further
  cache wipe is required).
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
  render branch below would preserve it. For the same reason, this
  slice extends the takeover pass to normalize a taken tile's value text
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
  contribute, and unknown- and uncertain-verdict entries hydrate through
  the gate below instead) and the fresh-resolution path hydrates without a
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

## Verification plan (MVP)

Live e2e per the repo CLAUDE.md constraints: injected namespaced
build (renamed cache key, style/class constants, marker attributes),
installed copy disabled where possible; cache state inspected via
localStorage reads, link state via anchor hrefs. The injected build
stubs `fetchRtPage`'s transport where a scenario needs a controlled
page, and stubs `fetchTraktIds`' response where a band needs a
controlled Trakt-side input (the Trakt-year-null and
Trakt-title-null bands); the live-shape probes use the real
transports. The injected build excludes the script's scan
bootstrap: an injection-time scan would fire before the stubs are
assigned and send real RT/Wikidata traffic. Scans are instead
driven explicitly through the window handle, which exposes
`queueScan` alongside the eviction and backoff surfaces
(post-resolution scans still fire naturally via `resolveIds`' own
`queueScan()` call).

- Verdict matrix, stub-driven: drive `resolveIds` for one title per
  band (both-agree; year-only disagree; title-only disagree;
  both-disagree; not-found; parse-failure; error; Trakt-year-null;
  Trakt-title-null and empty-normalized-title, the two
  title-signal-unavailable triggers; and the pre-existing
  Wikidata-has-no-path resolution, whose band asserts the widened
  fields are written with `rtPath: null` and that NO RT fetch
  fires) and verify the cache entry after each: the `rtVerified`
  value, `rtPath` kept vs null, `rtScores` integers vs null with a
  numeric `rtScores.fetchedAt` on match, `rtTitle`/`rtYear` present
  exactly on uncertain verdicts, and the anchor href flipping
  between direct and search accordingly. The uncertain bands must
  emit the `warn` carrying both raw titles and both years; the
  demoting bands (both-disagree, not-found) must emit the demotion
  `warn` carrying the discarded path, both raw titles, both years,
  and the reason token.
- Failure independence: a stubbed `error` result keeps the direct
  link intact with `rtVerified: false` (no demotion). To prove the
  successful cache write did not arm the failure backoff, the
  check must reach the backoff test inside `resolveIds`, and the
  eviction must hit the live in-memory `cacheEntries` map in the
  same page session: a localStorage edit is invisible to the
  one-time init snapshot, and a reload would wipe the in-memory
  backoff closure, so neither discriminates. Per the repo's e2e
  convention the injected build publishes its surface on a window
  handle; expose cache eviction (delete from `cacheEntries` and
  localStorage) and `backoff.isBackedOff` on it. The check: after
  the error write, assert `isBackedOff(key)` is false directly,
  then evict via the handle and drive another scan within 60s
  (RETRY_BACKOFF_MS): `resolveIds` must run and fetch again, where
  an armed backoff would early-return. Assert the cache guard's
  own no-duplicate-fetch property separately by scanning twice
  without eviction.
- Cache-version migration: seed a v1-stamped cache with entries,
  load the new build, verify the whole blob is discarded and
  refetched under version 2.
- Live shape, movie page: a real GM_xmlhttpRequest fetch of a known
  movie path from the userscript context returns a page whose
  JSON-LD name/year and scorecard scores parse. The page-shape half
  was re-confirmed 2026-08-05 in a rendered browser (`m/inception`:
  Movie / `dateCreated: 2010-07-16` / scores 86/91); the remaining
  question is only whether the extension transport survives a
  Cloudflare-fronted fetch, settled at e2e
  (live-claim: provisional)
- Live shape, tv page: a real fetch of a known `tv/<slug>` path
  yields a parseable name and year under the same parser; the
  scorecard's presence and shape are recorded (the hydration
  slice's tv behavior depends on it), and the parsed year's
  semantics are recorded against the show's first-aired year.
  Probed 2026-08-05 (rendered browser, `tv/breaking_bad`, a
  multi-season show): `TVSeries`, same `name`/`dateCreated`
  fields, `dateCreated: 2008-01-20` = premiere (first-aired
  semantics), scorecard present with the same score fields
  (live-claim: probed 2026-08-05)
- Live dead path: a real fetch of a known-dead `m/` path and a
  known-dead `tv/` path returns HTTP 404 or 410 after redirects,
  the premise of the `not-found` demotion trigger; a soft-404
  observation (a 200 or a redirect to home/search) would have
  contradicted the not-found design and routed to correction.
  Probed 2026-08-05 (same-origin fetch from an RT page context):
  synthetic dead slugs under both `m/` and `tv/` returned a hard
  404 with no redirect; the control (`m/inception`) returned 200
  (live-claim: probed 2026-08-05)
- Wrong-link field case: at least one title known to link wrongly
  resolves to a mismatch (both-disagree) or an uncertain
  (intermediate) verdict, never `'auto'`. No concrete
  `<type>:<slug>` from the 2026-08-04/05 field observations is
  recorded in the repo, so the executable form is: use an observed
  wrong-linking title if one is supplied at run time; otherwise
  construct the case by pointing a real title's resolution at a
  deliberately wrong live RT page (real transport, wrong path) and
  assert the comparison rejects it (live-claim: provisional)

## Open questions

- GM_xmlhttpRequest against RT in the wild: the probe used curl from
  a residential IP; Cloudflare-style bot checks may still challenge
  extension-background requests at volume. Mitigation if hit: verify
  lazily (only for titles actually viewed) and cache hard. Note what
  actually throttles each path: for the MVP it is the cache TTL (an
  unknown verdict still caches successfully, so the failure backoff
  never records); for score hydration it is the stamped-on-failure
  `rtScores.fetchedAt` described in the slice.
- ~~`tv/` page shape~~ Resolved 2026-08-05: probed, first-aired
  `dateCreated` semantics confirmed; record in `## Feasibility` and
  the tv probe bullet in `## Verification plan (MVP)`.
- Whether the audience "-" tile should show the popcorn score type
  RT displays by default (`ALL`) or the verified-audience variant;
  cosmetic, decide at implementation.

## Hardening

- revise-spec graduated 2026-08-05 19:17 at f57af45, scope: sections Mechanism, Cache entry changes and their consumers, Verification plan (MVP), Slices/MVP bullet, content: f21c682d
- revise-spec refreshed 2026-08-05 19:48 at c497391, scope: sections Mechanism, Cache entry changes and their consumers, Verification plan (MVP), Slices/MVP bullet, content: 18b1d145 (spec reconciliation)
