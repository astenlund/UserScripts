# Quick-list toggles fail on IMDb-slugged detail pages

## Symptom

Reported 2026-08-27 on https://app.trakt.tv/movies/tt43750031 ("Animal
Trap", unreleased, `year: null`): the film cannot be added to
Anticipated or Uninterested. The add appears to do nothing beyond the
failure toast; membership state on the page never reflects reality.

## Root cause (confirmed by live probe, 2026-08-27)

The app addresses some titles by IMDb id instead of a Trakt slug in the
detail-page path (observed for an unreleased movie whose `year` is
null): the URL segment is `tt43750031` while the canonical Trakt slug
is `animal-trap` (trakt id 1395109, confirmed via authenticated apiz
GET `/movies/tt43750031`, which resolves because Trakt's GET lookup
endpoints accept trakt id, slug, or IMDb id interchangeably).

The quick-lists feature treats the URL segment as the Trakt slug on
both sides of its contract:

- **Write path.** `postToggle` sends `{ movies: [{ ids: { slug } }] }`
  with the raw URL segment. The list-items endpoints match `ids.slug`
  strictly, so an IMDb-shaped value lands in `not_found` and the add is
  body-judged rejected. Probe evidence: POST `items/remove` on the
  Anticipated list with `ids: { slug: "tt43750031" }` returned the item
  under `not_found`, while `ids: { slug: "animal-trap" }` resolved
  (deleted 0, not_found empty).
- **Read path.** The membership sweep keys items by the canonical slug
  from list-item payloads (`itemSlug` uses `item.movie.ids.slug`),
  while entry state keys by `slugKeyOf(type, <URL segment>)`. For an
  IMDb-slugged page the two never match, so even a successful add
  (e.g. made natively) renders as non-member on that page.

## Blast radius

All three quick-list surfaces derive identity from the same raw
segment and share the failure:

- Summary actions menu (`summaryContext` reads `location.pathname`).
- Card popup menu (`cardContext` reads the card anchor's href, which
  the app also builds IMDb-shaped for such titles).
- Manage-lists drawer takeover (`drawerContext` inherits either of the
  above via `pendingContext` / `data-qlt-slug`).

Cosmetic secondary effect: fade filters match card hrefs against
canonical-slug membership sets, so such items never fade either.

Unaffected: the external-links feature's `fetchTraktIds` GET works with
the IMDb-shaped segment (lookup endpoints accept it), which is why
per-tile links render fine on the same page.

## Fix paths considered

1. **Write-side alias:** in `postToggle`, detect `/^tt\d+$/` and send
   `ids: { imdb: slug }` instead of `ids: { slug }`. Fixes writes only;
   membership display stays broken because sweep keys stay canonical.
2. **Dual-keyed sweep + write-side alias:** additionally have the
   membership engine index list items under an `movie:<imdb>` alias key
   beside `movie:<slug>` (payloads carry `ids.imdb`), so URL-segment
   keys match either name. Touches `itemSlug` / `uniqueItemSlugs` /
   counts dedup; the same item must not double-count within one list.
3. **Canonicalize at the boundary:** the external-links resolver
   already fetches `/movies/<segment>` and discards `body.ids.slug`;
   capture it and translate IMDb-shaped segments to canonical slugs
   before keying or writing. Cleanest single-identity model, but
   resolution is async, so entries need a pending state until the
   canonical slug lands.

Fix path 2 shipped 2026-08-27 in Trakt Improved 1.38; see
BUGS_HISTORY.md for the fix summary and verification.
