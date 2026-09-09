# Userscript checks

Use Node.js satisfying `^22.22.2 || ^24.15.0 || >=26.0.0`, as required by jsdom.

Run these commands from the repository root in PowerShell 7:

```powershell
npm ci --prefix tests --ignore-scripts
npm test --prefix tests
node --check trakt_improved.user.js
```

The test-only jsdom dependency is locked in `package-lock.json`. The
userscripts themselves have no runtime dependencies or build step.

The season-list tests cover URL identity, response validation, pagination,
menu insertion, add/remove payloads, pending writes across picker reopen,
and read-before-retry after an uncertain write. They also cover cached catalog
rendering, minimal row reconciliation, account isolation, and bounded fresh
membership reads. The DOM fixture models the
observed Trakt menu markup and stubs API calls. It does not write to Trakt.
Browser layout and native app integration still require live verification.

The fade-filter tests cover season subtitles on list cards whose links omit
the season, conservative handling of unreadable season identities, the
redesigned On/Off controls, legacy checkboxes, keyboard selection, explicit
save behavior, drawer remounts, movie-mode hiding, and idempotent scans.
Run this scope with `node --test tests/trakt-fade-filters.test.cjs`.

Season-link tests cover adding the subtitle's season to show links,
preserving query parameters and fragments, respecting explicit destinations,
recycled cards, and idempotent scans. Run them with
`node --test tests/trakt-season-links.test.cjs`.

Season progress uses `/shows/{id}/progress/watched` with hidden seasons
and specials included. A season is Watched when its completed count
reaches its positive aired count, Started when completion is positive
but below that count, and neither when nothing has been watched.
Missing or invalid progress stays unknown and does not inherit show
membership. Show cards retain their whole-show calculation; movies
retain their watched membership and episode cards remain excluded.

The in-memory progress cache is account-scoped, invalidates after a
successful watched-data sweep, and expires after 15 minutes. Requests
are limited to four at a time and 100 cached shows; a full cache retains
fresh entries and leaves additional shows unknown until space expires.
Failed requests retry after one minute on a subsequent scan.
`tests/trakt-season-progress.test.cjs` covers these boundaries and the
per-season categories. The endpoint is documented in the
[Trakt API](https://trakt.docs.apiary.io/#reference/shows/watched-progress/get-show-watched-progress);
the updated fetch path still needs verification in signed-in Chrome.
