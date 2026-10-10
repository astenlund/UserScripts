# Quick-list adds lose their fade after about 30 seconds

## Symptom

Reported 2026-10-10 on `/discover/anticipated?mode=show`: shows added
to Uninterested with the quick toggle faded at once, then lost the fade
about 30 seconds later and stayed unfaded for minutes, until a later
write's sweep or the 15-minute membership TTL. Live instances (UTC):
three shows added at 15:37:32-37 were missing from the 15:38:11 cache
commit; Tyson, added at 15:52:45, dropped out at the 15:53:28 sweep and
returned at 15:57:31; an add at 15:57:26 dropped out at 15:58:08.

## Root cause (confirmed live 2026-10-10)

- Trakt caches every page of a paginated read server-side, and a write
  to the collection refreshes only page 1. Later pages keep serving the
  pre-write copy until it expires, about 330 seconds (stale windows of
  167-198 s and 225 s were measured after writes). Shown directly on a
  4-entry list read one entry per page: after a remove, page 1 at every
  page size reported the new count while pages 2 to 4 still listed the
  removed entry.
- No read shape escapes it past page 1. Marker nonces of several
  formats, an unknown param, `limit` 999 or 250 (the server clamps to
  250, so they share pages), `extended` min, metadata, noseasons,
  images and full, the type-filtered `/items/show` path and the public
  `/lists/{id}/items` path all stayed stale. `extended=full` and
  `images` looked fresh only while their cache was cold, and stayed
  stale for about two minutes after the next write once warm.
- Uninterested sorts by date added, oldest first, and holds about 546
  entries, so every add lands on page 3. The membership sweep walked
  each list in its own order and read every add as absent. The
  confirmed-write ledger re-patched the add for its 30-second trust
  window, the suspect resweeps (5, 10, 20 s) all landed inside the
  cache window, and the first sweep past 30 s committed the stale read
  as fresh.
- One-page lists are unaffected, which is why a native add to a
  3-entry list and script-style writes to it (slug remove, Trakt-id
  add, Trakt-id remove) all read fresh at once. The write path was
  never the cause: the app's add uses the same host, path, headers and
  API key (`users.lists.list.add` with `id: userId ?? 'me'`).
- Fresh within a second of native writes: the lists index
  (`item_count`, `updated_at`), `/sync/last_activities`, the watchlist
  (one page) and watched movies (newest play on page 1).

## Refuted along the way

- The Trakt Improved 1.29 premise
  ([fresh-membership-sweeps.md](../features/fresh-membership-sweeps.md))
  that a `marker=` nonce defeats the server cache: the page cache
  ignores the param.
- "The server lags writes by an unbounded amount": the long lags were
  the later-page cache alone; page 1 was fresh within a second of every
  measured write.

## Fix (Trakt Improved 1.50)

`fetchAddedOrder` in the membership engine's fetchers. List items and
the watchlist are walked oldest-added first (`sort_by=added`,
`sort_how=asc`), which keeps every existing entry on its cached page
when entries are added, and multi-page collections also read the
newest-added page 1, which is fresh and holds the adds. The reads merge
by list-entry id.

Two alternatives failed live and are recorded so they are not retried:

- Walking in the list's own order plus the newest page: a release-date
  sort (Anticipated) can insert an add mid-list and push an entry onto
  a stale page where neither read holds it.
- Reading both page-1 ends and keeping stale middle entries only
  between the ends' `listed_at` bounds: the server's added order
  matches neither `listed_at` nor the entry id on most lists, and the
  two directions are not mirror images (ties break differently), so
  the bounds dropped 87 of 342 Anticipated entries and 81 of 1000
  R-Rated Comedies entries.

Verified live: the merged read matched the lists index `item_count`
for all nine lists, with no duplicates, and the newest-added page 1
held a quick-toggle add on the first read after the write.

## Residuals

- Removing an entry that sits past page 1 of the oldest-added walk
  reads stale until the server copy expires, as before the fix: a
  quick-list remove of such an entry re-fades when the 30-second ledger
  window closes, and because that sweep stamps the cache fresh, the
  fade stays until the first sweep after the server copy expires
  (without another write or marker bump, the 15-minute membership
  TTL). Tracked in BUGS.md.
- Watched-history removals past page 1 of watched movies or shows are
  assumed to read stale the same way (unverified: only their page 1
  was observed, and it was fresh).
- Truncate walks Uninterested in the list's own order, so its
  completeness guard fails closed with an item count mismatch for about
  5.5 minutes after adds. Tracked in BUGS.md.
- Season list management reads `/items/season` pages; a list holding
  more than 250 season entries would read stale past page 1. Left as
  is by user ruling 2026-10-10.
