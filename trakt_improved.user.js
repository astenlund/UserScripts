// ==UserScript==
// @name         Trakt Improved
// @namespace    fork-scripts
// @version      1.32
// @description  All-in-one enhancements for the new Trakt Web: fade filters for tracked items, one-click Anticipated/Uninterested list toggles, deterministic Rotten Tomatoes and Letterboxd links, restored list item counts, classic rating labels, and swimlane scrollbar fixes.
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_improved.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/trakt_improved.user.js
// @match        https://app.trakt.tv/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      www.wikidata.org
// @connect      www.rottentomatoes.com
// ==/UserScript==

(function () {
  'use strict';

  // With GM grants the script runs in the manager's sandbox, where `window`
  // is a wrapper: page-global patching (the fetch hook below) must go through
  // unsafeWindow to reach the real page. Falls back to window when injected
  // without a sandbox.
  const pageWindow = typeof unsafeWindow === 'object' ? unsafeWindow : window;

  // ---------------------------------------------------------------------
  // Shared plumbing
  // ---------------------------------------------------------------------

  const API_BASE = 'https://apiz.trakt.tv';
  const OIDC_KEY_PREFIX = 'oidc.user:https://auth.trakt.tv:';
  const FETCH_TIMEOUT_MS = 30 * 1000;
  const RETRY_BACKOFF_MS = 60 * 1000;

  function warn(...args) {
    console.warn('[trakt-improved]', ...args);
  }

  // Maps a URL path segment to the canonical media type used in cache keys
  // and API paths: 'movies' -> 'movie', 'shows' -> 'show', anything else null.
  function mediaType(segment) {
    if (segment === 'movies') return 'movie';
    if (segment === 'shows') return 'show';
    return null;
  }

  // Inverse of mediaType, colocated so the mapping stays single-sourced.
  function mediaPathSegment(type) {
    return type === 'movie' ? 'movies' : 'shows';
  }

  // One shape test for /users/<owner>/lists/<slug> list-detail URLs:
  // exactly 4 path segments, slug never 'view' (the overview tab prefix),
  // query string ignored. Returns { owner, slug }, or null for anything
  // else (lists index, smart list views, non-list pages).
  function listPathParts(pathname) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 4 && segments[0] === 'users' && segments[2] === 'lists' && segments[3] !== 'view') {
      return { owner: segments[1], slug: segments[3] };
    }
    return null;
  }

  // All localStorage JSON goes through these guards: corrupt or unwritable
  // storage degrades to a console warning, never a thrown scan/refresh.
  function readJson(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      warn(`Corrupt JSON in localStorage "${key}"; treating as absent`);
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      warn(`Could not persist "${key}"; continuing with in-memory state`, e);
    }
  }

  // OAuth ride-along: the app's own token and client id from localStorage.
  function readAuth() {
    const key = Object.keys(localStorage).find(k => k.startsWith(OIDC_KEY_PREFIX));
    if (!key) return null;
    const entry = readJson(key);
    const token = entry && typeof entry === 'object' ? entry.access_token : null;
    if (!token) return null;
    return { token, clientId: key.slice(key.lastIndexOf(':') + 1) };
  }

  function apiUrl(path) {
    return new URL(API_BASE + path);
  }

  // A fetch succeeds only on HTTP 2xx; anything else (network error, timeout,
  // 401/429/5xx) throws and feeds the caller's fallback path. fetch() resolves
  // on HTTP errors, so response.ok is checked explicitly; a 401 is how an
  // expired token shows up.
  function authHeaders(auth) {
    return {
      'Authorization': `Bearer ${auth.token}`,
      'trakt-api-version': '2',
      'trakt-api-key': auth.clientId,
    };
  }

  async function apiGet(auth, url) {
    const response = await fetch(url, {
      headers: authHeaders(auth),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.pathname}`);
    return response;
  }

  // POST sibling of apiGet with one deliberate contract difference: the
  // response comes back unjudged even on HTTP errors, because the write
  // endpoints report per-item results in the body and each caller owns
  // its own verdict (body-judged success, partial-failure reporting).
  function apiPost(auth, url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(auth)),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }

  // Per-key transient-failure gate shared by features that retry fetches
  // after RETRY_BACKOFF_MS. Prune-on-write keeps the map bounded: an entry
  // older than the backoff window no longer gates anything, so only
  // failures within the last window survive.
  function createFailureBackoff() {
    const failedAt = {};
    return {
      isBackedOff(key) {
        return failedAt[key] !== undefined && Date.now() - failedAt[key] < RETRY_BACKOFF_MS;
      },
      record(key) {
        const now = Date.now();
        for (const k of Object.keys(failedAt)) {
          if (now - failedAt[k] >= RETRY_BACKOFF_MS) {
            delete failedAt[k];
          }
        }
        failedAt[key] = now;
      },
    };
  }

  // One scan queue drives every feature: rAF batches scans to one per frame,
  // but rAF never fires in a hidden tab; fall back to a macrotask there so
  // fixes are in place before the tab is ever shown.
  const scanCallbacks = [];
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => {
      scanQueued = false;
      // Isolate feature scans from each other: pre-merge each script had its
      // own observer, so one feature's bug could never stall the others.
      for (const callback of scanCallbacks) {
        try {
          callback();
        } catch (e) {
          warn('Feature scan failed; other feature scans continue', e);
        }
      }
    };
    if (document.visibilityState === 'hidden') {
      setTimeout(run, 0);
    } else {
      requestAnimationFrame(run);
    }
  }

  // Every state change in the app (mark watched, watchlist/list membership,
  // ratings, ...) is a non-GET call to the API host by the app's own code.
  // Hooking page fetch notifies features the moment one succeeds, so their
  // caches reflect the new reality without a page refresh. The short settle
  // delay gives the server time to reflect the write before features
  // refetch. Checking response.ok does not consume the body, and feature
  // refreshes are GETs, so the hook cannot loop on them.
  const MUTATION_SETTLE_MS = 1000;
  const mutationCallbacks = [];

  // Notify features that an API mutation happened: after the settle delay,
  // run every mutation callback (isolated, mirroring the scan queue) and
  // queue a scan. Called by the fetch hook below for the app's own writes,
  // and directly by features whose own mutating requests use the sandbox
  // fetch, which the hook never sees.
  function notifyMutation() {
    setTimeout(() => {
      for (const callback of mutationCallbacks) {
        try {
          callback();
        } catch (e) {
          warn('Mutation callback failed; other callbacks continue', e);
        }
      }
      queueScan();
    }, MUTATION_SETTLE_MS);
  }

  const nativeFetch = pageWindow.fetch;
  pageWindow.fetch = function (...args) {
    const result = nativeFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : input && input.url;
      const method = ((args[1] && args[1].method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      if (typeof url === 'string' && url.startsWith(API_BASE) && method !== 'GET') {
        result.then(response => {
          if (response.ok) {
            notifyMutation();
            // A successful native write is the one same-tab signal the
            // membership engine's confirmed-write ledger must yield to;
            // script writes ride the sandbox fetch and never pass here.
            // The response arrives in real time, so it is always later
            // than any ledgered write.
            quickLists.dropConfirmedWrites();
          }
        }, () => {
          // The app's own error handling owns failed mutations.
        });
      }
    } catch {
      // Hook bookkeeping must never break the app's fetch.
    }
    return result;
  };

  // Shared surface between the list-membership engine below (which owns
  // the sweep and populates it) and the quick list toggles feature (which
  // renders and writes against it). The list names are resolved by display
  // name, not slug:
  // the Uninterested list's slug is UUID-suffixed. Names are user config,
  // edited in-source; the ICONS table in the toggles feature is keyed by
  // these same names, so a rename must touch both.
  const QUICK_LIST_NAMES = ['Anticipated', 'Uninterested'];
  const quickLists = {};

  // Fade-category vocabulary shared by the membership engine and the fade
  // feature. CATEGORIES is the cache-record iteration list (normalizeCache,
  // categoryStale/cacheStale, buildSets' record loop). The quick-list fade
  // categories own no cache record (their sets derive from the listed
  // record's targets), so they must stay out of it: a record-less key
  // would make cacheStale() permanently true and turn the scan/refresh
  // pair into an unbounded sweep loop. QUICK_CATS keys them by lowercased
  // list name, so a rename stays a one-place edit; a derived key colliding
  // with a built-in category key is out of contract for this source-edited
  // config (same class of coupling as the ICONS table note above).
  const CATEGORIES = ['started', 'watched', 'watchlisted', 'listed'];
  const QUICK_CATS = Object.fromEntries(QUICK_LIST_NAMES.map(name => [name.toLowerCase(), name]));

  // ---------------------------------------------------------------------
  // List-membership engine
  // Owns the membership cache (watched/started/watchlisted/listed data
  // swept from the API), the single-flight refresh that maintains it
  // (sweep reads cache-busted via a marker nonce, latched back to
  // marker-less if the server ever rejects the param), and the cross-tab
  // invalidation markers, including the storage-event trigger that
  // sweeps promptly on another tab's bump. Serves two consumers: it
  // populates the quickLists surface for the toggles feature and returns
  // the read surface the fade feature renders from.
  // ---------------------------------------------------------------------

  const membership = (function initListMembership() {
    // ---- Cache-and-sets store -----------------------------------------

    // Persisted category records plus the derived slug sets. Sweep
    // commits replace whole records via commit(); the optimistic toggle
    // mutates the shared listed record in place and calls rebuildSets().
    const store = (function initStore() {
      const CACHE_KEY = 'trakt-fade-cache';
      const CACHE_VERSION = 5;
      const CACHE_TTL_MS = 15 * 60 * 1000;

      // Cache record per category: { slugs: [...], fetchedAt: <epoch ms> },
      // except listed, which carries { counts, targets, keys, fetchedAt }
      // (see fetchListedData): counts is consulted directly by the listed
      // fade check, and keys holds the owner/slug identities that classify
      // a viewed list as mine/saved for the containing-list exclusion; each
      // non-null target carries fadeSlugs (the full itemSlug-mapped fade
      // membership for quick-list fade categories) and key (the lowercased
      // owner-slug/list-slug identity for own-surface exclusion). All under
      // a top-level version stamp so a format change forces a refetch instead
      // of serving entries the new matching logic misreads.
      function normalizeCache(raw) {
        const versionOk = raw && typeof raw === 'object' && raw.v === CACHE_VERSION;
        const cache = {};
        for (const cat of CATEGORIES) {
          const rec = versionOk ? raw[cat] : null;
          if (cat === 'listed') {
            const shapeOk = rec && typeof rec.fetchedAt === 'number'
              && rec.counts && typeof rec.counts === 'object'
              && rec.targets && typeof rec.targets === 'object'
              && Array.isArray(rec.keys)
              && Object.values(rec.targets).every(t => t === null || (t && typeof t.id === 'number' && Array.isArray(t.slugs)
                && Array.isArray(t.fadeSlugs) && (t.key === null || typeof t.key === 'string')));
            cache[cat] = shapeOk ? rec : null;
          } else {
            cache[cat] = rec && Array.isArray(rec.slugs) && typeof rec.fetchedAt === 'number' ? rec : null;
          }
        }
        return cache;
      }

      // No listed set: the listed fade check consults cache.listed.counts
      // directly against a per-card threshold (see applyFades), so a set
      // would be a second derivation to keep in sync. The quick-list sets
      // derive from the listed record's targets (fadeSlugs, the
      // counts-mirroring membership), not from own cache records.
      function buildSets(cache) {
        const sets = {};
        for (const cat of CATEGORIES) {
          if (cat === 'listed') continue;
          sets[cat] = new Set(cache[cat] ? cache[cat].slugs : []);
        }
        for (const [cat, name] of Object.entries(QUICK_CATS)) {
          const target = cache.listed && cache.listed.targets[name];
          sets[cat] = new Set(target ? target.fadeSlugs : []);
        }
        return sets;
      }

      const cache = normalizeCache(readJson(CACHE_KEY));
      let sets = buildSets(cache);

      function categoryStale(cat) {
        return !cache[cat] || Date.now() - cache[cat].fetchedAt > CACHE_TTL_MS;
      }

      return {
        sets: () => sets,
        listed: () => cache.listed,
        commit: (cat, record) => {
          cache[cat] = record;
        },
        rebuildSets: () => {
          sets = buildSets(cache);
        },
        persist: () => writeJson(CACHE_KEY, Object.assign({ v: CACHE_VERSION }, cache)),
        categoryStale,
        cacheStale: () => CATEGORIES.some(cat => categoryStale(cat)),
      };
    })();

    // ---- Cross-tab invalidation markers -------------------------------

    // Marker snapshot machinery: a live prefix scan of the app's
    // trakt-marker:invalidate:* keys plus the script's own bump key,
    // diffed against a baseline snapshot to detect foreign writes.
    const markers = (function initMarkers() {
      const MARKER_SNAPSHOT_KEY = 'trakt-fade-markers';
      const MARKER_PREFIX = 'trakt-marker:invalidate:';
      const SELF_MARKER_KEY = MARKER_PREFIX + 'fork-scripts-quick-lists';
      // This tab's own last marker bump. The sweep re-merges it at commit
      // (the snapshot captured at sweep start would otherwise erase a bump
      // recorded mid-sweep), and it must merge only this OWN value, never
      // the key's live localStorage value: both tabs write the same key, so
      // the live value may carry another tab's bump, which must stay foreign
      // for its invalidation to trip this tab.
      let selfMarkerValue = null;

      // Marker snapshot: captured at refresh start, committed when the refresh
      // commits, so an app action landing mid-refresh still triggers a follow-up.
      function currentMarkers() {
        const live = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(MARKER_PREFIX)) live[key] = localStorage.getItem(key);
        }
        return live;
      }

      let committedMarkers = readJson(MARKER_SNAPSHOT_KEY);

      // Shared marker diff: true when any key's value in the live scan
      // differs from the baseline snapshot, minus exempted differences.
      // Serves both the committed-snapshot staleness check below and the
      // ledger's per-entry foreign-write check, whose baselines carry
      // different merge histories (committed gets the own-bump merge at
      // commit time; note-time snapshots need a live exemption instead).
      function markersMovedSince(baseline, current, exempt) {
        const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
        return [...keys].some(key => current[key] !== baseline[key] && !(exempt && exempt(key, current[key])));
      }

      function markersChanged() {
        if (!committedMarkers || typeof committedMarkers !== 'object') return true;
        return markersMovedSince(committedMarkers, currentMarkers());
      }

      // The snapshot was captured at sweep start (so an app action landing
      // mid-refresh still triggers a follow-up), but this tab's own
      // quick-toggle marker bump must never look foreign to this tab: merge
      // it into whatever gets committed, or a bump recorded mid-sweep would
      // be erased and re-trigger a pre-settle sweep here. Merge the tracked
      // own value, not the key's live localStorage value (which may carry
      // another tab's bump that must stay foreign), and never over a NEWER
      // captured value: committing an older value over a foreign newer one
      // would leave committed permanently behind localStorage and loop the
      // sweep. Values are Date.now() strings, so compare numerically.
      function commitMarkerSnapshot(captured) {
        if (selfMarkerValue !== null && Number(captured[SELF_MARKER_KEY] || 0) <= Number(selfMarkerValue)) {
          captured[SELF_MARKER_KEY] = selfMarkerValue;
        }
        committedMarkers = captured;
        writeJson(MARKER_SNAPSHOT_KEY, captured);
      }

      // Cross-tab propagation for the toggles feature's sandbox-fetch writes,
      // which other tabs' page-fetch hooks never see: bump the script-owned
      // key under the app's invalidation-marker prefix (markersChanged()
      // prefix-scans it in every tab). Recording the value into this tab's
      // committed snapshot at bump time keeps the bump invisible here, so it
      // cannot launch a pre-settle sweep in the tab that just wrote. Returns
      // whether the live key held a value that is not this tab's own:
      // overwriting it is the one act that can erase the evidence of a
      // foreign bump before the ledger's per-entry snapshot comparison sees
      // it, so the caller must surrender the ledger on true (surrender
      // also fires when the overwrite itself failed and the evidence
      // survives; conservative); the only residual blind spot is a
      // foreign bump landing inside this read-then-write instant.
      function bumpSelf() {
        const value = String(Date.now());
        let foreignObserved = false;
        try {
          foreignObserved = localStorage.getItem(SELF_MARKER_KEY) !== selfMarkerValue;
          localStorage.setItem(SELF_MARKER_KEY, value);
        } catch {
          // Bump is best-effort; other tabs heal on TTL without it.
          return foreignObserved;
        }
        selfMarkerValue = value;
        if (committedMarkers && typeof committedMarkers === 'object') {
          committedMarkers[SELF_MARKER_KEY] = value;
          writeJson(MARKER_SNAPSHOT_KEY, committedMarkers);
        }
        return foreignObserved;
      }

      return {
        current: currentMarkers,
        changed: markersChanged,
        commitSnapshot: commitMarkerSnapshot,
        // Foreign-movement flavor for the ledger: exempts this tab's own
        // tracked bump (a later own write must not read as foreign to a
        // note-time snapshot); every other difference is another writer.
        // Compared per entry against note-time baselines, never against
        // the engine's committed snapshot: an unabsorbed bump that
        // predates the write must not read as foreign to it.
        foreignMovedSince: (baseline, current) => markersMovedSince(baseline, current,
          (key, value) => key === SELF_MARKER_KEY && value === selfMarkerValue),
        isMarkerKey: key => key.startsWith(MARKER_PREFIX),
        bumpSelf,
      };
    })();

    // ---- API sweep fetchers -------------------------------------------

    // The sweep's API reads and their result shaping, including the
    // cache-busting nonce and the per-tab latch that degrades to
    // marker-less GETs if the server ever rejects the param.
    const fetchers = (function initFetchers() {
      const PAGE_LIMIT = 1000;

      // Cache-busting nonce for sweep GETs, mirroring the app's own
      // marker= mechanism against the same server-side cache (the app
      // mints a per-page-load token; per-sweep uniqueness is all the
      // busting needs). bustingDisabled is the per-tab latch for the
      // server ever rejecting the param: 400/422 on a busted GET flips
      // it and every later sweep this session runs marker-less,
      // degrading to pre-1.29 behavior instead of a permanent sweep
      // outage. In-memory on purpose: a server-side fix heals on the
      // next page load. 401/403/404/429/5xx/network failures are NOT
      // param rejections and keep their existing stale-keep + backoff
      // routing untouched.
      let bustingDisabled = false;

      function mintNonce() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      }

      function noteBustingRejected(e) {
        const message = String(e && e.message);
        if (!bustingDisabled && (message.startsWith('HTTP 400 ') || message.startsWith('HTTP 422 '))) {
          bustingDisabled = true;
          warn('Server rejected the sweep cache-busting param; running marker-less until next page load', e);
        }
      }

      // Shared busted-GET wrapper for the two nonce-carrying fetchers:
      // applies the nonce and routes a param-rejection-shaped failure
      // through the latch before re-raising the original error. The
      // response comes back unconsumed.
      async function bustedGet(auth, url, nonce) {
        if (nonce) {
          url.searchParams.set('marker', nonce);
        }
        try {
          return await apiGet(auth, url);
        } catch (e) {
          if (nonce) {
            noteBustingRejected(e);
          }
          throw e;
        }
      }

      async function fetchPage(auth, path, page, nonce) {
        const url = apiUrl(path);
        url.searchParams.set('page', page);
        url.searchParams.set('limit', PAGE_LIMIT);
        const response = await bustedGet(auth, url, nonce);
        const body = await response.json();
        if (!Array.isArray(body)) throw new Error(`Unexpected response shape for ${path}`);
        const pageCount = parseInt(response.headers.get('X-Pagination-Page-Count'), 10);
        return { batch: body, pageCount: Number.isFinite(pageCount) ? pageCount : null };
      }

      // These endpoints paginate silently (a bare GET returns just page 1 as a
      // plain 200), and the server may clamp the requested limit (observed:
      // watched/shows clamps 1000 to 250), so a page shorter than the requested
      // limit does NOT mean it was the last one. The X-Pagination-Page-Count
      // header is authoritative; the short-page check is only a fallback for a
      // missing header, and an empty batch is a hard stop either way.
      async function fetchAll(auth, path) {
        // One nonce per collection: a single mint site per call, not a
        // cross-page consistency mechanism (each page URL is its own
        // cache key either way; torn reads across pages match today's
        // marker-less behavior and the next sweep owns healing them).
        const nonce = bustingDisabled ? null : mintNonce();
        const items = [];
        for (let page = 1; ; page++) {
          const { batch, pageCount } = await fetchPage(auth, path, page, nonce);
          items.push(...batch);
          if (batch.length === 0) return items;
          if (pageCount !== null ? page >= pageCount : batch.length < PAGE_LIMIT) return items;
        }
      }

      // extended=full suppresses the per-episode seasons breakdown entirely, so
      // watched-vs-started needs this second variant: one un-paginated object
      // mapping show trakt id -> "seasonId|seasonNumber" -> episode id -> watch
      // dates. Per show this yields the unique watched-episode count and the
      // numbers of seasons with at least one play, specials (season 0) excluded.
      async function fetchWatchedProgress(auth) {
        const url = apiUrl('/users/me/watched/shows');
        url.searchParams.set('extended', 'min');
        url.searchParams.set('season_numbers', 'true');
        url.searchParams.set('specials', 'true');
        const nonce = bustingDisabled ? null : mintNonce();
        const response = await bustedGet(auth, url, nonce);
        const body = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('Unexpected response shape for season_numbers');
        }
        const progress = {};
        for (const [showId, seasons] of Object.entries(body)) {
          const seasonNumbers = [];
          let seen = 0;
          for (const [seasonKey, episodes] of Object.entries(seasons)) {
            const seasonNumber = seasonKey.split('|')[1];
            if (seasonNumber === '0') continue;
            const episodeCount = Object.keys(episodes).length;
            if (episodeCount === 0) continue;
            seen += episodeCount;
            seasonNumbers.push(seasonNumber);
          }
          progress[showId] = { seen, seasons: seasonNumbers };
        }
        return progress;
      }

      // Per-list results instead of a flat merge: the per-slug list counts
      // feed the listed fade check directly and make removal unfade
      // correctly (an item on two lists stays faded when it leaves one);
      // the exact membership of the quick-toggle target lists drives
      // the menu entries. Exact membership counts only items whose own type
      // is show/movie: a season sitting in a list does not make its show a
      // member, because the toggle operates on the show itself. A name that
      // resolves to zero or multiple lists yields a null target (fail closed:
      // writing to an arbitrarily-picked list is worse than a missing entry).
      async function fetchListedData(auth) {
        const lists = await fetchAll(auth, '/users/me/lists');
        const withIds = lists.filter(list => list.ids && list.ids.trakt !== undefined);
        const perList = await Promise.all(
          withIds.map(list => fetchAll(auth, `/users/me/lists/${list.ids.trakt}/items`)),
        );
        const targets = {};
        const quickIndices = new Set();
        for (const name of QUICK_LIST_NAMES) {
          const indices = withIds.map((list, i) => (list.name === name ? i : -1)).filter(i => i >= 0);
          if (indices.length !== 1) {
            targets[name] = null;
            continue;
          }
          const index = indices[0];
          quickIndices.add(index);
          const list = withIds[index];
          const exact = perList[index]
            .filter(item => item.type === 'show' || item.type === 'movie')
            .map(itemSlug)
            .filter(Boolean);
          // fadeSlugs mirrors the counts/watchlisted mapping (a season or
          // episode entry contributes its parent show) because it replaces
          // the list's carved-out counts contribution as the fade source;
          // slugs stays the exact show/movie membership the toggle menus
          // need. key is the same owner/slug identity format `keys` uses,
          // so the containing-list machinery can recognize the list's own
          // surfaces.
          const fadeSlugs = [...uniqueItemSlugs(perList[index])];
          targets[name] = { id: list.ids.trakt, slugs: exact, fadeSlugs, key: listIdentityKey(list) };
        }
        // Quick lists are carved out of counts: their membership fades via
        // the dedicated toggles instead, mirroring how the watchlist never
        // counted toward Listed. A name that resolved to zero or multiple
        // lists (null target) keeps counting, so a broken target degrades
        // to the old fade-via-Listed behavior instead of un-fading items.
        const counts = {};
        perList.forEach((items, i) => {
          if (quickIndices.has(i)) {
            return;
          }
          for (const slug of uniqueItemSlugs(items)) {
            counts[slug] = (counts[slug] || 0) + 1;
          }
        });
        // Owner/slug identity keys let the fade threshold classify a viewed
        // list as mine/saved. Lowercased here once; URL segments are
        // lowercased at comparison time. A list missing either slug
        // contributes no key (its detail page then reads as foreign).
        const keys = withIds.map(listIdentityKey).filter(Boolean);
        return { counts, targets, keys };
      }

      // Owner/slug identity ("<user slug>/<list slug>", lowercased) shared
      // by the keys corpus and each quick target's own key; null when
      // either slug is missing.
      function listIdentityKey(list) {
        return list.ids.slug && list.user && list.user.ids && list.user.ids.slug
          ? (list.user.ids.slug + '/' + list.ids.slug).toLowerCase()
          : null;
      }

      // Deduped membership slugs of a list's items under the itemSlug
      // mapping (seasons and episodes contribute the parent show).
      function uniqueItemSlugs(items) {
        return new Set(items.map(itemSlug).filter(Boolean));
      }

      // Watchlist/list items are heterogeneous: shows and movies contribute their
      // own slug, seasons/episodes map to the parent show, persons are ignored.
      function itemSlug(item) {
        switch (item.type) {
          case 'show':
            return item.show && item.show.ids && item.show.ids.slug ? 'show:' + item.show.ids.slug : null;
          case 'movie':
            return item.movie && item.movie.ids && item.movie.ids.slug ? 'movie:' + item.movie.ids.slug : null;
          case 'season':
          case 'episode':
            return item.show && item.show.ids && item.show.ids.slug ? 'show:' + item.show.ids.slug : null;
          default:
            return null;
        }
      }

      // Fully watched vs started: unique watched episode count (specials excluded)
      // vs the show's aired_episodes (which also excludes specials), joined by the
      // show's numeric trakt id. Each show contributes its own slug plus one
      // show:<slug>:s<N> key per season with plays, so season cards fade by the
      // season's own progress; the season keys follow the show's bucket since
      // per-season aired counts are not available.
      function splitWatchedShows(items, progress) {
        const watched = [];
        const started = [];
        for (const item of items) {
          const show = item.show;
          if (!show || !show.ids || !show.ids.slug) continue;
          const aired = show.aired_episodes || 0;
          const p = progress[String(show.ids.trakt)] || { seen: 0, seasons: [] };
          const slug = 'show:' + show.ids.slug;
          const bucket = aired > 0 && p.seen >= aired ? watched : started;
          bucket.push(slug, ...p.seasons.map(n => `${slug}:s${n}`));
        }
        return { watched, started };
      }

      function movieSlugs(items) {
        return items
          .map(item => (item.movie && item.movie.ids && item.movie.ids.slug ? 'movie:' + item.movie.ids.slug : null))
          .filter(Boolean);
      }

      return { fetchAll, fetchWatchedProgress, fetchListedData, itemSlug, splitWatchedShows, movieSlugs };
    })();

    // Shared membership patch for the optimistic toggle and the ledger's
    // commit-time reconciliation. The exact-membership guard lives INSIDE
    // and short-circuits BEFORE either set is touched: fadeSlugs is a
    // strict superset of slugs (a season entry contributes its parent
    // show), so patching fadeSlugs on a no-op would strip a legitimately
    // season-backed fade from otherwise-agreeing data. Deliberately
    // approximate in the removal direction: fadeSlugs has set semantics
    // and cannot record whether a surviving season/episode entry of the
    // same show still justifies membership, so that rare removal
    // transiently un-fades until a later sweep restores authoritative
    // data. Returns whether exact membership changed.
    function patchTargetMembership(target, slugKey, add) {
      const exact = new Set(target.slugs);
      if (add === exact.has(slugKey)) return false;
      const fadeSet = new Set(target.fadeSlugs);
      if (add) {
        exact.add(slugKey);
        fadeSet.add(slugKey);
      } else {
        exact.delete(slugKey);
        fadeSet.delete(slugKey);
      }
      target.slugs = [...exact];
      target.fadeSlugs = [...fadeSet];
      return true;
    }

    // ---- Confirmed-write ledger ---------------------------------------

    // The script's own body-judged-successful quick-toggle writes,
    // defended against server-cache-stale corrector reads until the trust
    // window closes. Tab-local and non-persisted on purpose: cross-tab
    // staleness is another tab's problem to heal, and a reload inside the
    // window is left to self-healing. Entries leave by agreement, expiry,
    // or a foreign-write drop; past the window server truth wins
    // unconditionally.
    const ledger = (function initLedger() {
      const WRITE_TRUST_WINDOW_MS = 30 * 1000;
      const SUSPECT_RETRY_BASE_MS = 5 * 1000;
      const confirmedWrites = new Map();
      let nextRetryDelay = SUSPECT_RETRY_BASE_MS;
      let retryTimer = 0;

      function cancelRetryTimer() {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = 0;
        }
      }

      // Commit-time reconciliation: runs against the fetched listed record
      // BEFORE it becomes cache, so every post-confirmation fetch/write
      // interleaving is covered at the single commit point. Expiry first
      // (with diagnostics: a still-contradicted expiry means the server
      // never caught up and the stale-read bug recurred for that item; a
      // missing target means the entry expired unverifiable), then the
      // foreign-marker drop (judged per entry against its note-time
      // snapshot and one live scan shared across all entries), then
      // patch-or-agree via the shared helper, whose true return IS the
      // contradiction signal. Suspect commits are not failures: no
      // lastFailureAt, no backoff, no rearm.
      function reconcile(targets, now) {
        let suspect = false;
        // Empty ledger: nothing to defend, and no timer can be pending
        // (every path that empties the ledger cancels it), so skip the
        // marker scan entirely.
        if (confirmedWrites.size === 0) return suspect;
        const liveMarkers = markers.current();
        for (const [key, entry] of confirmedWrites) {
          const target = targets[entry.name];
          if (now - entry.confirmedAt > WRITE_TRUST_WINDOW_MS) {
            if (!target) {
              warn(`Confirmed ${entry.add ? 'add' : 'remove'} of ${entry.slugKey} expired unverifiable; list "${entry.name}" never re-resolved`);
            } else if (target.slugs.includes(entry.slugKey) !== entry.add) {
              warn(`Confirmed ${entry.add ? 'add' : 'remove'} of ${entry.slugKey} expired still contradicted; the server never caught up`);
            }
            confirmedWrites.delete(key);
            continue;
          }
          if (markers.foreignMovedSince(entry.snapshot, liveMarkers)) {
            confirmedWrites.delete(key);
            continue;
          }
          if (!target) continue;
          if (patchTargetMembership(target, entry.slugKey, entry.add)) {
            suspect = true;
          } else {
            confirmedWrites.delete(key);
          }
        }
        if (confirmedWrites.size === 0) cancelRetryTimer();
        return suspect;
      }

      // One pending retry at a time; the ladder (5s, 10s, 20s) advances
      // only when a retry is actually scheduled, so the two early sweeps
      // one write can produce advance it at most once. The trust window
      // terminates the loop: a retry firing past it prunes the entry and
      // commits server truth. sweep is a later sibling sub-closure; the
      // timer body only runs long after every sibling is initialized.
      function scheduleSuspectResweep() {
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = 0;
          sweep.triggerForcedSweep();
        }, nextRetryDelay);
        nextRetryDelay *= 2;
      }

      return {
        reconcile,
        scheduleSuspectResweep,
        // Called only on body-judged success, AFTER the marker bump (the
        // captured snapshot must include this write's own bump, or the
        // entry would read itself as foreign). Latest write to the same
        // item wins. A new write resets the retry ladder but leaves a
        // pending retry timer alone: the write's own write-triggered
        // sweep already covers promptness.
        note: (name, slugKey, add) => {
          confirmedWrites.set(`${name}:${slugKey}`, { name, slugKey, add, confirmedAt: Date.now(), snapshot: markers.current() });
          nextRetryDelay = SUSPECT_RETRY_BASE_MS;
        },
        // Foreign-write surrender: neither drop signal says what changed,
        // so the whole ledger yields. Deliberately coarse: it may abandon
        // protection for an unrelated pending write, trading a rare
        // transient revert for never knowingly fighting another writer.
        drop: () => {
          confirmedWrites.clear();
          cancelRetryTimer();
        },
      };
    })();

    // ---- Sweep controller ---------------------------------------------

    // The single-flight refresh, its trigger flags, and every sweep
    // trigger: the DOM-mutation hook, the cross-tab storage listener,
    // and the shared forced-sweep entry point.
    const sweep = (function initSweep() {
      // Settle window for the write-triggered corrector: longer than
      // notifyMutation's MUTATION_SETTLE_MS because the observed server
      // staleness already reached ~2s post-write. No settle value is
      // sufficient alone (the lag is unbounded); the confirmed-write
      // ledger is the actual defense, this just cheapens the case where
      // the forced sweep is the first post-write sweep.
      const WRITE_SETTLE_MS = 2000;

      let refreshInFlight = false;
      let lastFailureAt = 0;
      let forceRefresh = false;
      // A failed forced sweep must not consume its trigger: refresh() clears
      // forceRefresh before fetching and commits the marker snapshot even on
      // total failure, so without this re-arm a failed post-write corrector
      // would leave nothing but TTL age to retry on. Unlike forceRefresh,
      // the re-armed flag respects the failure backoff.
      let rearmedRefresh = false;
      // Post-write refresh queueing: a sweep whose fetches predate a write
      // would clobber the optimistic state when it commits, so a write that
      // settles mid-sweep queues a fresh forced sweep instead of being
      // silently dropped by the single-flight guard.
      let pendingForcedRefresh = false;
      let sweepStartedAt = 0;

      // A mutation-triggered refresh bypasses the failure backoff (see
      // refresh()): user actions are rare and deserve promptness. The shared
      // hook queues the scan that notices the flag; the marker mechanism stays
      // as backup and for actions performed in other tabs.
      mutationCallbacks.push(() => {
        forceRefresh = true;
      });

      // Forced-sweep trigger respecting the single-flight guard: a
      // sweep already in flight cannot be trusted to have seen the
      // demand, so the follow-up is queued instead and drained when
      // that sweep commits (the tail of refresh()). Shared by the
      // storage listener below and the ledger's suspect resweep; the
      // write-settle trigger keeps its own guarded variant, which
      // additionally checks sweep coverage via sweepStartedAt.
      function triggerForcedSweep() {
        if (refreshInFlight) {
          pendingForcedRefresh = true;
        } else {
          forceRefresh = true;
          queueRefresh();
        }
      }

      // Cross-tab prompt trigger: another tab's marker bump (script
      // quick-toggle via the script's own marker key, or the app's own
      // trakt-marker:invalidate:* bumps on native actions; the exact
      // app key names are unverified, observed live e.g. listed:show)
      // sweeps this tab without waiting for a DOM-mutation scan, which
      // an idle tab may never run. Storage events fire only in tabs
      // that did not perform the write, so every matching event is
      // foreign by construction (a null key, as from localStorage
      // .clear(), fails the prefix test). The single debounced timer
      // waits WRITE_SETTLE_MS before sweeping: the writer bumps the
      // instant its POST resolves, and a zero-delay read could commit
      // pre-write server state as fresh with no ledger entry here to
      // correct it. The settle timer hands off to triggerForcedSweep
      // (shared with the suspect resweep); the scan-driven
      // markers.changed() check stays as catch-up for bumps that landed
      // while no listener was alive.
      // Registered on pageWindow (the real page window, the same
      // surface the fetch hook patches): storage events dispatch on
      // the page window, sandbox-wrapper forwarding is
      // manager-dependent, and attaching there makes the page-context
      // e2e build's listener path identical to the released sandboxed
      // build.
      let foreignBumpTimer = 0;
      pageWindow.addEventListener('storage', e => {
        if (!e.key || !markers.isMarkerKey(e.key)) return;
        clearTimeout(foreignBumpTimer);
        foreignBumpTimer = setTimeout(() => {
          foreignBumpTimer = 0;
          triggerForcedSweep();
        }, WRITE_SETTLE_MS);
      });

      // Single-flight, atomic per category: a category's record is replaced only
      // when every fetch it depends on succeeded; otherwise it keeps its stale
      // record wholesale and the backoff gates the next attempt.
      async function refresh() {
        if (refreshInFlight) return;
        // A mutation-triggered refresh bypasses the failure backoff: user actions
        // are rare and deserve promptness. Ordinary staleness and the re-armed
        // retry after a failed forced sweep still respect it.
        if (!forceRefresh && Date.now() - lastFailureAt < RETRY_BACKOFF_MS) return;
        const auth = readAuth();
        if (!auth) {
          warn('No Trakt access token in localStorage; fading stays on cached/empty data until login');
          lastFailureAt = Date.now();
          return;
        }
        const wasForced = forceRefresh || rearmedRefresh;
        forceRefresh = false;
        rearmedRefresh = false;
        refreshInFlight = true;
        sweepStartedAt = Date.now();
        try {
          const captured = markers.current();
          const [shows, progress, movies, watchlist, listed] = await Promise.allSettled([
            fetchers.fetchAll(auth, '/users/me/watched/shows?extended=full'),
            fetchers.fetchWatchedProgress(auth),
            fetchers.fetchAll(auth, '/users/me/watched/movies'),
            fetchers.fetchAll(auth, '/users/me/watchlist'),
            fetchers.fetchListedData(auth),
          ]);
          const now = Date.now();
          let anyFailed = false;
          let changed = false;

          if (shows.status === 'fulfilled' && progress.status === 'fulfilled' && movies.status === 'fulfilled') {
            const split = fetchers.splitWatchedShows(shows.value, progress.value);
            store.commit('watched', { slugs: [...split.watched, ...fetchers.movieSlugs(movies.value)], fetchedAt: now });
            store.commit('started', { slugs: split.started, fetchedAt: now });
            changed = true;
          } else {
            anyFailed = true;
            warn('Watched/started refresh failed; keeping stale data', shows.reason || progress.reason || movies.reason);
          }

          if (watchlist.status === 'fulfilled') {
            store.commit('watchlisted', { slugs: watchlist.value.map(fetchers.itemSlug).filter(Boolean), fetchedAt: now });
            changed = true;
          } else {
            anyFailed = true;
            warn('Watchlist refresh failed; keeping stale data', watchlist.reason);
          }

          if (listed.status === 'fulfilled') {
            const suspect = ledger.reconcile(listed.value.targets, now);
            store.commit('listed', Object.assign({}, listed.value, { fetchedAt: now }));
            changed = true;
            if (suspect) ledger.scheduleSuspectResweep();
          } else {
            anyFailed = true;
            warn('List-membership refresh failed; keeping stale data', listed.reason);
          }

          if (changed) {
            store.persist();
            store.rebuildSets();
          }
          markers.commitSnapshot(captured);
          if (anyFailed) {
            lastFailureAt = now;
            if (wasForced) {
              rearmedRefresh = true;
            }
          }
          if (changed) queueScan();
        } finally {
          refreshInFlight = false;
        }
        if (pendingForcedRefresh) {
          pendingForcedRefresh = false;
          forceRefresh = true;
          await refresh();
        }
      }

      function queueRefresh() {
        refresh().catch(e => {
          warn('Refresh failed unexpectedly', e);
          lastFailureAt = Date.now();
        });
      }

      // Write-triggered sweep: waits a longer settle window than
      // notifyMutation's (the server needs time to reflect the write before
      // a refetch, or the sweep reads pre-write state and stamps it fresh),
      // rides the pending flag when the in-flight sweep cannot be trusted to
      // have seen the write, and bypasses the backoff via forceRefresh. A
      // sweep counts as covering the write only when it started AFTER the
      // settle window closed: one that started inside the window may still
      // have fetched pre-write state (one click, one sweep otherwise), which
      // with the widened window guarantees a post-settle sweep exists.
      function queueWriteSettledSweep() {
        const settledAt = Date.now();
        setTimeout(() => {
          if (refreshInFlight) {
            if (sweepStartedAt < settledAt + WRITE_SETTLE_MS) pendingForcedRefresh = true;
          } else {
            forceRefresh = true;
            queueRefresh();
          }
        }, WRITE_SETTLE_MS);
      }

      return {
        queueRefresh,
        triggerForcedSweep,
        queueWriteSettledSweep,
        forcedPending: () => forceRefresh || rearmedRefresh,
      };
    })();

    // ---- Consumer surfaces --------------------------------------------

    // The full staleness condition for membership data mirrors the fade
    // scan's own refresh trigger: TTL age alone would miss app-driven
    // changes (a native Manage-lists tick sets the mutation-forced flag;
    // another tab's change lands via the invalidation markers), leaving
    // toggle icons wrong for the full TTL on pages where the fade scan
    // (and with it the scan-triggered refresh) is inactive.
    function membershipStale() {
      return sweep.forcedPending() || markers.changed() || store.categoryStale('listed');
    }

    quickLists.membershipState = () => {
      if (!store.listed()) return 'absent';
      return membershipStale() ? 'stale' : 'fresh';
    };

    // null strictly means "data exists but the name resolved to zero or
    // multiple lists"; callers must gate on membershipState() !== 'absent'
    // before consulting targets, so the two no-entry states stay distinct.
    quickLists.getListTarget = name => {
      const listed = store.listed();
      const target = listed && listed.targets[name];
      if (!target) return null;
      return { id: target.id, has: slugKey => target.slugs.includes(slugKey) };
    };

    // A foreign value observed at bump time means another tab wrote since
    // this tab's last bump, and the overwrite just erased the evidence:
    // surrender the ledger (see bumpSelf for the full contract).
    quickLists.bumpInvalidationMarker = () => {
      if (markers.bumpSelf()) ledger.drop();
    };

    // Ledger writer and surrender for the toggles feature; see ledger.note
    // for the ordering contract with bumpInvalidationMarker.
    quickLists.noteConfirmedWrite = ledger.note;
    quickLists.dropConfirmedWrites = ledger.drop;

    // Write-triggered flavor defers to the sweep controller's settle
    // machinery; menu-open flavor is staleness-gated and respects the
    // backoff.
    quickLists.refreshMembership = ({ writeTriggered = false } = {}) => {
      if (writeTriggered) {
        sweep.queueWriteSettledSweep();
      } else if (membershipStale()) {
        sweep.queueRefresh();
      }
    };

    // Optimistic patch, not a sweep: mutates the target in place,
    // rebuilds the derived sets so the quick-category fade flips in the
    // same frame as the toggle icon, persists WITHOUT touching fetchedAt
    // (stamping a patch fresh would park an unreconciled write behind
    // the full TTL; the untouched timestamp is what lets an interrupted
    // session heal), and queues a rescan. counts is no longer touched:
    // quick lists are carved out of it.
    quickLists.applyListToggle = (name, slugKey, add) => {
      const listed = store.listed();
      const target = listed && listed.targets[name];
      if (!target) return;
      if (!patchTargetMembership(target, slugKey, add)) return;
      store.rebuildSets();
      store.persist();
      queueScan();
    };

    // Read surface for the fade feature. sets is reassigned on rebuild,
    // so it is exposed as an accessor, never as a captured reference.
    // needsRefresh is the fade scan's sweep trigger: any category stale,
    // a forced or re-armed sweep pending, or foreign marker movement.
    return {
      sets: store.sets,
      listedCounts: () => {
        const listed = store.listed();
        return listed ? listed.counts : {};
      },
      listedKeys: () => {
        const listed = store.listed();
        return listed ? listed.keys : [];
      },
      quickTargetKey: name => {
        const listed = store.listed();
        const target = listed && listed.targets[name];
        return target ? target.key : null;
      },
      needsRefresh: () => sweep.forcedPending() || store.cacheStale() || markers.changed(),
      queueRefresh: sweep.queueRefresh,
    };
  })();

  // ---------------------------------------------------------------------
  // Feature: fade filters
  // Restores fade/dim filtering: adds a Fade section to the filter pane and
  // fades watched/started/watchlisted/listed posters, with hover-to-reveal.
  // Supersedes the app's own watched-item fade (is-deemphasized), which is
  // neutralized so the two treatments never stack. Renders from the
  // list-membership engine's read surface above.
  // ---------------------------------------------------------------------

  (function initFadeFilters() {
    const STATE_KEY = 'trakt-fade-filters';
    const MODE_KEY = 'trakt_toggler_discover';
    const FADE_CLASS = 'tff-fade';
    const LIGHT_CLASS = 'tff-light';
    const STYLE_ID = 'tff-style';
    const SECTION_ATTR = 'data-tff-section';
    const ROW_ATTR = 'data-tff-row';
    // FADE_CATEGORIES adds the quick-list categories to the shared
    // cache-record categories for the fade-facing consumers: state, the
    // pane rows, and applyFades. The pane renders rows in FADE_CATEGORIES
    // order, with the catch-all listed row last, below the quick-list rows.
    const FADE_CATEGORIES = [...CATEGORIES.filter(cat => cat !== 'listed'), ...Object.keys(QUICK_CATS), 'listed'];
    const LABELS = Object.assign({ started: 'Started', watched: 'Watched', watchlisted: 'Watchlisted', listed: 'Listed' }, QUICK_CATS);
    const SAVE_BUTTON_SELECTOR = 'button[aria-label="Set filters as default"]';

    const state = Object.fromEntries(FADE_CATEGORIES.map(cat => [cat, true]));
    const storedState = readJson(STATE_KEY);
    if (storedState && typeof storedState === 'object') {
      for (const key of Object.keys(state)) {
        if (typeof storedState[key] === 'boolean') state[key] = storedState[key];
      }
    }

    // ---- Fade styles --------------------------------------------------

    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // !important throughout: the app's Svelte-scoped selectors (e.g.
      // .trakt-card-cover.svelte-x) beat plain class rules on specificity.
      style.textContent = `
        /* The app fades watched posters itself (is-deemphasized drops
           .trakt-card-cover-image to var(--de-emphasized-opacity), twice:
           the class sits on both the wrapper div and the img). Neutralize
           it so the fade filters below are the only fade in play and
           watched items don't fade twice. Deliberately broader than the
           app's own trakt-default-media-item scope so new card containers
           gaining the class stay covered; overriding the variable instead
           would bleed into unrelated deemphasis (non-current seasons,
           drag placeholders). */
        .is-deemphasized .trakt-card-cover-image,
        .is-deemphasized.trakt-card-cover-image {
          opacity: 1 !important;
        }
        /* Transitions live on the elements unconditionally, NOT scoped to
           the fade class: a scoped transition vanishes in the same style
           recalc that removes the class, so unfading would snap while
           fading eased. The cover keeps the app's native outline-color
           transition alongside ours since a transition override replaces
           the whole list. */
        .trakt-card-cover {
          transition: opacity 250ms ease, filter 250ms ease, outline-color 0.15s ease-in-out !important;
        }
        .trakt-card-footer,
        .trakt-summary-card-details,
        .trakt-summary-card-bottom-bar,
        .trakt-card-action-bar,
        .trakt-indicator-tags-container,
        .trakt-summary-card-background img {
          transition: opacity 250ms ease, filter 250ms ease !important;
        }
        /* The backdrop layer div natively carries opacity .35 and a gradient
           mask; styling the img INSIDE it composes with those (multiplies)
           instead of overriding them, so hover restores exactly the native
           look rather than a brighter-than-normal one. */
        /* Theme-split fade: the fade must not depend on what's behind the
           art. On a dark surface darken the art itself at full alpha (an
           alpha cut would read as gray fog); on a light surface keep full
           brightness and wash the art out by alpha instead. The light
           class is set by syncThemeClass below; anything not positively
           light gets the dark treatment, the safer default for any
           future dark theme variant. */
        .${FADE_CLASS} .trakt-card-cover,
        .${FADE_CLASS} .trakt-summary-card-background img {
          opacity: 1 !important;
          filter: brightness(0.25) saturate(0.25) !important;
        }
        /* :where() keeps the theme scope at zero specificity so this
           override still wins over the dark base above purely by source
           order, while the hover reveal below (one extra pseudo-class)
           outranks both; a bare :root.${LIGHT_CLASS} prefix would outrank
           the hover rules and make faded cards unhoverable on light. */
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-card-cover,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-summary-card-background img {
          opacity: 0.25 !important;
          filter: saturate(0.5) !important;
        }
        /* The saturate term mutes the rating star's purple, which
           brightness alone leaves colored against the grayed text. */
        .${FADE_CLASS} .trakt-card-footer,
        .${FADE_CLASS} .trakt-summary-card-details,
        .${FADE_CLASS} .trakt-summary-card-bottom-bar,
        .${FADE_CLASS} .trakt-card-action-bar,
        .${FADE_CLASS} .trakt-indicator-tags-container {
          filter: brightness(0.25) saturate(0.25) !important;
        }
        /* Same theme split for the text/rating layer: brightness pushes
           toward black, which on a light card RAISES contrast (the rating
           star stayed vivid purple), so light washes by alpha instead,
           in lockstep with the art above. */
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-card-footer,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-summary-card-details,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-summary-card-bottom-bar,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-card-action-bar,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-indicator-tags-container {
          opacity: 0.25 !important;
          filter: saturate(0.5) !important;
        }
        /* Hover-to-reveal only on fine pointers (same gate the app uses):
           on touch screens :hover sticks after a tap, leaving items
           permanently unfaded. */
        @media (hover: hover) and (pointer: fine) {
          .${FADE_CLASS}:hover .trakt-card-cover,
          .${FADE_CLASS}:hover .trakt-summary-card-background img {
            opacity: 1 !important;
            filter: none !important;
          }
          .${FADE_CLASS}:hover .trakt-card-footer,
          .${FADE_CLASS}:hover .trakt-summary-card-details,
          .${FADE_CLASS}:hover .trakt-summary-card-bottom-bar,
          .${FADE_CLASS}:hover .trakt-card-action-bar,
          .${FADE_CLASS}:hover .trakt-indicator-tags-container {
            opacity: 1 !important;
            filter: none !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    // ---- Filter pane --------------------------------------------------

    function activeMode() {
      const urlMode = new URLSearchParams(location.search).get('mode');
      if (urlMode) return urlMode;
      const stored = readJson(MODE_KEY);
      return typeof stored === 'string' && stored ? stored : 'media';
    }

    // The Fade section is a clone of the app's own Display section, so native
    // styling applies; cloned nodes carry no Svelte listeners, and the cloned
    // checkboxes still toggle natively.
    function buildFadeSection(displaySection) {
      const templateRow = displaySection.querySelector('div.trakt-filter');
      const section = displaySection.cloneNode(true);
      const title = section.querySelector('.display-title');
      const toggles = section.querySelector('.display-toggles');
      if (!templateRow || !title || !toggles) return null;
      section.setAttribute(SECTION_ATTR, '1');
      title.textContent = 'Fade';
      toggles.textContent = '';
      for (const cat of FADE_CATEGORIES) {
        const row = templateRow.cloneNode(true);
        const label = row.querySelector('span.secondary');
        const input = row.querySelector('input[type=checkbox]');
        if (!label || !input) return null;
        row.setAttribute(ROW_ATTR, cat);
        label.textContent = LABELS[cat];
        input.setAttribute('aria-label', 'Fade ' + LABELS[cat].toLowerCase());
        input.checked = state[cat];
        input.addEventListener('change', () => {
          state[cat] = input.checked;
          queueScan();
        });
        toggles.appendChild(row);
      }
      return section;
    }

    // The warn fires once per page load: widened activation makes the
    // unbuildable-pane branch reachable on per-frame scans of list pages,
    // where an unguarded warn would flood the console.
    let warnedPaneMarkup = false;

    function ensureFadeSection() {
      const displaySection = document.querySelector(`div.trakt-display-section:not([${SECTION_ATTR}])`);
      if (!displaySection) return;
      let section = displaySection.parentElement.querySelector(`[${SECTION_ATTR}]`);
      if (!section) {
        section = buildFadeSection(displaySection);
        if (!section) {
          if (!warnedPaneMarkup) {
            warnedPaneMarkup = true;
            warn('Filter pane markup changed; cannot inject Fade section');
          }
          return;
        }
        displaySection.after(section);
      }
      const startedRow = section.querySelector(`[${ROW_ATTR}="started"]`);
      if (startedRow) startedRow.style.display = activeMode() === 'movie' ? 'none' : '';
    }

    // Fade toggles apply in-memory immediately but persist only when the user
    // clicks the pane's save button ("Set filters as default", matched by
    // aria-label since the surrounding bits-* ids are regenerated per render);
    // a reload reverts unsaved toggles to the last saved state. Delegated from
    // document so it survives pane re-renders.
    document.addEventListener('click', e => {
      if (e.target instanceof Element && e.target.closest(SAVE_BUTTON_SELECTOR)) {
        writeJson(STATE_KEY, state);
      }
    });

    // ---- URL classification and containing-list resolution ------------

    // A card's anchor reveals its granularity via query params: an `episode`
    // param marks an episode-specific card (Continue Watching, Calendar), a
    // `season` param without `episode` marks a season card, neither marks a
    // plain show/movie card.
    function cardTarget(card) {
      for (const anchor of card.querySelectorAll('a[href]')) {
        const url = new URL(anchor.href, location.origin);
        const segments = url.pathname.split('/').filter(Boolean);
        const type = mediaType(segments[0]);
        if (segments.length >= 2 && type) {
          return {
            slug: `${type}:${segments[1]}`,
            season: url.searchParams.get('season'),
            episode: url.searchParams.get('episode'),
          };
        }
      }
      return null;
    }

    // Page-context classifier for the fade scope. 'discover' and 'smart'
    // carry no containing list; 'detail' is a list URL per listPathParts;
    // 'overview' is exactly /users/me/lists or /users/me/lists/view and
    // deeper. Foreign or username-form overview routes are unverified to
    // exist and deliberately do not activate.
    function pageContext() {
      const path = location.pathname;
      if (path === '/discover' || path.startsWith('/discover/')) return 'discover';
      if (path.startsWith('/lists/smart/view/')) return 'smart';
      const segments = path.split('/').filter(Boolean);
      if (segments[0] === 'users' && segments[1] === 'me' && segments[2] === 'lists'
          && (segments.length === 3 || segments[3] === 'view')) {
        return 'overview';
      }
      return listPathParts(path) ? 'detail' : null;
    }

    function listKeyKnown(owner, slug) {
      if (owner === 'me') return true;
      const key = (owner + '/' + slug).toLowerCase();
      return membership.listedKeys().includes(key);
    }

    // A target with key null (list missing its own or its owner's slug)
    // cannot be recognized here, so its own surfaces fade under their
    // toggle; accepted degradation per the spec's Failure modes.
    function quickCatFor(owner, slug) {
      for (const [cat, name] of Object.entries(QUICK_CATS)) {
        const key = membership.quickTargetKey(name);
        if (!key) continue;
        const listSlug = key.split('/')[1];
        if (owner === 'me' ? slug === listSlug : owner + '/' + slug === key) return cat;
      }
      return null;
    }

    // Classification of a positively resolved containing list, shared by
    // every surface. A quick list's own surface excludes that category
    // and contributes 0 (its items were never counted); anything else
    // takes the mine/saved test for the Listed threshold. quickAllowed
    // is always true here: positive resolution is exactly what the
    // overview gate requires.
    function classifyParts(parts) {
      const owner = parts.owner.toLowerCase();
      const slug = parts.slug.toLowerCase();
      const excludedCat = quickCatFor(owner, slug);
      if (excludedCat !== null) {
        return { contribution: 0, excludedCat, quickAllowed: true };
      }
      return { contribution: listKeyKnown(owner, slug) ? 1 : 0, excludedCat: null, quickAllowed: true };
    }

    // First defined result of test(ancestor), walking from the card's
    // parent up to (excluding) document.body; undefined when no ancestor
    // decides.
    function walkAncestors(card, test) {
      for (let node = card.parentElement; node && node !== document.body; node = node.parentElement) {
        const result = test(node);
        if (result !== undefined) return result;
      }
      return undefined;
    }

    // Positive smart-list identification: the nearest ancestor containing
    // any list-card landmark decides; only a container holding a
    // smart-list header and no summary card counts as a smart wrapper.
    // Ambiguity (a lane holding both kinds) resolves to false, which
    // routes the card to the conservative contribution-1 fallback.
    function insideSmartListCard(card) {
      const verdict = walkAncestors(card, node => {
        const hasSmart = node.querySelector('.trakt-smart-list-header') !== null;
        const hasSummary = node.querySelector('.trakt-list-summary-card') !== null;
        return hasSmart || hasSummary ? hasSmart && !hasSummary : undefined;
      });
      return verdict === undefined ? false : verdict;
    }

    // The first anchor inside the container whose href parses as a list
    // URL names the containing list; null when none does. Serves both
    // summary cards (whose landmark match is terminal: an anchorless
    // summary card reads as unidentified, never falling through to lane
    // resolution) and lane headings.
    function listPartsIn(container) {
      for (const anchor of container.querySelectorAll('a[href]')) {
        const parts = listPathParts(new URL(anchor.href, location.origin).pathname);
        if (parts) return parts;
      }
      return null;
    }

    // Lane resolution: nearest ancestor containing exactly one lane
    // heading (.trakt-list-inset-title). A card inside a lane resolves
    // to its own lane's container or to nothing (a walk that first
    // reaches a container with multiple headings, e.g. the whole page,
    // or none yields no identification); a card outside every lane may
    // bind to a lone heading on its ancestor chain, which is safe in
    // the under-fade direction only.
    function laneContainer(card) {
      const lane = walkAncestors(card, node => {
        const insets = node.querySelectorAll('.trakt-list-inset-title');
        if (insets.length === 1) return node;
        return insets.length > 1 ? null : undefined;
      });
      return lane === undefined ? null : lane;
    }

    // threshold = 1 + contribution: subtracting the containing list's own
    // contribution turns "on >= threshold lists" into "on at least one
    // list other than this one" (see the feature spec for the derivation).
    // The resolver now yields a full verdict {contribution, excludedCat,
    // quickAllowed} per card: excludedCat suppresses that quick category
    // on its own list's surface, and quickAllowed is the overview gate
    // (quick fades only on positive rule-1/rule-2 identification; a
    // spuriously true smart verdict must not permit fades, since
    // insideSmartListCard tests subtree containment, not the card's own
    // lane). Resolution is scan-scoped: the detail-page verdict is
    // page-invariant and overview verdicts are cached per summary card,
    // per lane, and per parent, so each is computed at most once per scan.
    function contributionResolver(context) {
      const OPEN = { contribution: 0, excludedCat: null, quickAllowed: true };
      if (context === 'detail') {
        const parts = listPathParts(location.pathname);
        const verdict = parts ? classifyParts(parts) : OPEN;
        return () => verdict;
      }
      if (context === 'overview') {
        const UNIDENTIFIED = { contribution: 1, excludedCat: null, quickAllowed: false };
        const SMART = { contribution: 0, excludedCat: null, quickAllowed: false };
        const bySummary = new Map();
        const laneByParent = new Map();
        const byLane = new Map();
        const smartByParent = new Map();
        return card => {
          // Rule 1: summary-card landmark, terminal even when anchorless.
          const summary = card.closest('.trakt-list-summary-card');
          if (summary) {
            if (!bySummary.has(summary)) {
              const parts = listPartsIn(summary);
              bySummary.set(summary, parts ? classifyParts(parts) : UNIDENTIFIED);
            }
            return bySummary.get(summary);
          }
          // Rule 2: lane-heading resolution; a failed walk or an
          // unparsable heading falls through to the smart check.
          const parent = card.parentElement;
          if (!laneByParent.has(parent)) laneByParent.set(parent, laneContainer(card));
          const lane = laneByParent.get(parent);
          if (lane) {
            if (!byLane.has(lane)) {
              const parts = listPartsIn(lane.querySelector('.trakt-list-inset-title'));
              byLane.set(lane, parts ? classifyParts(parts) : null);
            }
            const verdict = byLane.get(lane);
            if (verdict) return verdict;
          }
          // Rule 3: positive smart identification, contribution-only.
          if (!smartByParent.has(parent)) smartByParent.set(parent, insideSmartListCard(card));
          return smartByParent.get(parent) ? SMART : UNIDENTIFIED;
        };
      }
      return () => OPEN;
    }

    // ---- Fade rendering -----------------------------------------------

    // Episode cards never fade by show membership: lanes like Continue Watching
    // and Calendar surface unwatched episodes of started shows on purpose, so
    // dimming them would defeat those lanes. Season cards fade by the season's
    // own progress; show/movie cards by their slug. Quick categories are
    // additionally gated by the resolver's verdict: excluded on their own
    // list's surface, withheld on the overview without positive
    // identification (see contributionResolver).
    function applyFades(context) {
      const fadeCats = FADE_CATEGORIES.filter(cat => state[cat]);
      const setCats = fadeCats.filter(cat => cat !== 'listed');
      const listedOn = fadeCats.includes('listed');
      const sets = membership.sets();
      const counts = membership.listedCounts();
      const verdictFor = contributionResolver(context);
      for (const card of document.querySelectorAll('div.trakt-card')) {
        const target = cardTarget(card);
        let fade = false;
        if (target !== null && target.episode === null) {
          const key = target.season === null ? target.slug : `${target.slug}:s${target.season}`;
          const verdict = verdictFor(card);
          fade = setCats.some(cat => {
            if (cat in QUICK_CATS && (!verdict.quickAllowed || cat === verdict.excludedCat)) {
              return false;
            }
            return sets[cat].has(key);
          });
          if (!fade && listedOn) {
            fade = (counts[key] || 0) >= 1 + verdict.contribution;
          }
        }
        card.classList.toggle(FADE_CLASS, fade);
      }
    }

    // Fading is scoped to /discover plus list surfaces (detail pages, smart
    // list views, the /users/me/lists overview); the listed check excludes
    // the containing list there via the counts threshold, so a list's own
    // page is not dimmed wholesale. Other personal surfaces (home lanes,
    // the watchlist page) consist of tracked items by definition and stay
    // out of scope. The @match stays site-wide because the SPA navigates
    // without reloading; on inactive pages the scan only clears stale fade
    // classes on reused nodes and skips the Fade section and API refreshes
    // entirely.
    function scan() {
      const context = pageContext();
      if (context === null) {
        document.querySelectorAll(`.${FADE_CLASS}`).forEach(el => el.classList.remove(FADE_CLASS));
        return;
      }
      injectStyles();
      ensureFadeSection();
      applyFades(context);
      if (membership.needsRefresh()) {
        membership.queueRefresh();
      }
    }

    // ---- Theme detection ----------------------------------------------

    // Theme detection: the app stamps data-theme on <html>, but the value
    // stays "system" when following the OS, so attribute matching cannot
    // resolve the effective theme. Measure the rendered body background
    // instead: canvas fillStyle parses any color the browser can render
    // (oklch, color(srgb ...)), and a parse failure leaves the fill black,
    // which resolves to dark, the fail-safe default.
    const luminanceCanvas = document.createElement('canvas');
    luminanceCanvas.width = luminanceCanvas.height = 1;

    function syncThemeClass() {
      const ctx = luminanceCanvas.getContext('2d');
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 127;
      document.documentElement.classList.toggle(LIGHT_CLASS, light);
    }

    new MutationObserver(syncThemeClass).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeClass);
    syncThemeClass();

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: external links
  // Replaces unreliable native Rotten Tomatoes links with deterministic
  // direct links (Wikidata bridges IMDb id to RT path), takes over the dead
  // grayscale RT placeholder tiles as live links, and adds a Letterboxd
  // chip on movie pages, with title-search fallback throughout.
  // ---------------------------------------------------------------------

  (function initExternalLinks() {
    const CHIP_CLASS = 'tel-chip';
    const KIND_ATTR = 'data-tel-kind';
    const ROW_SELECTOR = '.trakt-summary-ratings';
    // Native Rotten Tomatoes links appear in the visible ratings row and in the
    // Ratings drawer (view=ratings); both get rewritten. Letterboxd links in the
    // drawer are direct and correct when present, so they are left alone.
    const REWRITE_SCOPES = `${ROW_SELECTOR}, .trakt-ratings-drawer-content`;
    const RT_HREF_MATCH = 'a[href*="rottentomatoes."]';
    const CACHE_KEY = 'trakt-external-links-cache';
    const CACHE_VERSION = 2;
    // The TTL also schedules retries for titles Wikidata has no RT path for
    // yet; id mappings drift rarely, so a month keeps lookups near zero.
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 500;
    const RT_PATH_PATTERN = /^(m|tv)\/[\w-]+$/;

    // The app's row CSS renders every tile icon at height 14 with width from
    // the svg's attribute aspect ratio, so the viewBoxes are cropped tight to
    // the artwork: padding inside the viewBox would shrink the drawing
    // relative to the native icons, which fill theirs edge to edge.
    const ICONS = {
      rt: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="19.6" viewBox="3.5 2.4 17 19.6">'
        + '<circle cx="12" cy="13.5" r="8.5" fill="#fa320a"/>'
        + '<path d="M12 6c-.4-1.8-1.8-3.2-3.7-3.6 1 .8 1.6 1.8 1.8 3-1.4-1-3.2-1.3-4.8-.7 1.3.4 2.4 1.2 3.1 2.3 1.2-.7 2.4-1 3.6-1z" fill="#00912d"/>'
        + '</svg>',
      lb: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="11" viewBox="1 6.5 22 11">'
        + '<circle cx="6.5" cy="12" r="5.5" fill="#ff8000"/>'
        + '<circle cx="17.5" cy="12" r="5.5" fill="#40bcf4"/>'
        + '<circle cx="12" cy="12" r="5.5" fill="#00e054"/>'
        + '</svg>',
    };

    // Cache entry per "<type>:<slug>": { imdb, tmdb, rtPath, rtVerified,
    // rtTitle, rtYear, rtScores, fetchedAt }, under a version stamp so a
    // format change forces a refetch. rtVerified is 'auto' | 'uncertain' |
    // false ('user' reserved for click-time confirm); rtTitle/rtYear are
    // non-null exactly on uncertain verdicts; rtScores is
    // { critics, audience, fetchedAt } (integers 0-100 or null) exactly on
    // match verdicts.
    function loadCache() {
      const raw = readJson(CACHE_KEY);
      const versionOk = raw && typeof raw === 'object' && raw.v === CACHE_VERSION;
      return versionOk && raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    }

    const cacheEntries = loadCache();

    function cacheGet(key) {
      const entry = cacheEntries[key];
      return entry && typeof entry === 'object' && typeof entry.fetchedAt === 'number' ? entry : null;
    }

    function cachePut(key, entry) {
      cacheEntries[key] = entry;
      const keys = Object.keys(cacheEntries);
      if (keys.length > CACHE_MAX_ENTRIES) {
        keys.sort((a, b) => cacheEntries[a].fetchedAt - cacheEntries[b].fetchedAt)
          .slice(0, keys.length - CACHE_MAX_ENTRIES)
          .forEach(k => delete cacheEntries[k]);
      }
      writeJson(CACHE_KEY, { v: CACHE_VERSION, entries: cacheEntries });
    }

    async function jsonFetch(url) {
      const hostname = new URL(url).hostname;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${hostname}`);
      return response.json();
    }

    // Shared GM_xmlhttpRequest transport: handleLoad maps the response to
    // the resolved value (throw to reject).
    function gmXhr(url, handleLoad) {
      const hostname = new URL(url).hostname;
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: FETCH_TIMEOUT_MS,
          onload: r => {
            try {
              resolve(handleLoad(r, hostname));
            } catch (e) {
              reject(e);
            }
          },
          ontimeout: () => reject(new Error(`Timeout from ${hostname}`)),
          onerror: () => reject(new Error(`Network error from ${hostname}`)),
        });
      });
    }

    // Wikidata is not on the app's connect-src CSP whitelist, so those calls
    // go through GM_xmlhttpRequest (extension background, exempt from page
    // CSP). The jsonFetch fallback covers managers without the API; under
    // this app's CSP it will fail and degrade to title-search links.
    function gmFetchJson(url) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return jsonFetch(url);
      }
      return gmXhr(url, (r, hostname) => {
        if (r.status < 200 || r.status >= 300) {
          throw new Error(`HTTP ${r.status} from ${hostname}`);
        }
        return JSON.parse(r.responseText);
      });
    }

    // Text-body sibling of gmFetchJson. Resolves on any HTTP status (the
    // caller classifies), rejects only on network failure or timeout.
    function gmFetchText(url) {
      return gmXhr(url, r => ({ status: r.status, text: r.responseText }));
    }

    function parseScore(html, field) {
      const m = html.match(new RegExp(`"${field}":\\{[^}]*"score":"(\\d{1,3})"`));
      if (!m) return null;
      const score = Number(m[1]);
      return score >= 0 && score <= 100 ? score : null;
    }

    // name and year are required for ok (the match rule must only ever
    // compare two real values); scores are optional, null on score-less or
    // unreleased titles.
    function parseRtPage(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let name = null;
      let year = null;
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try {
          data = JSON.parse(script.textContent);
        } catch {
          // Malformed ld+json block; keep looking.
          continue;
        }
        if (
          data &&
          (data['@type'] === 'Movie' || data['@type'] === 'TVSeries') &&
          typeof data.name === 'string' &&
          data.name &&
          typeof data.dateCreated === 'string'
        ) {
          const parsedYear = Number(data.dateCreated.slice(0, 4));
          if (Number.isInteger(parsedYear) && parsedYear > 0) {
            name = data.name;
            year = parsedYear;
            break;
          }
        }
      }
      if (name === null || year === null) return null;
      const scoreScript = [...doc.querySelectorAll('script')].find(s => s.textContent.includes('criticsScore'));
      const scoreText = scoreScript ? scoreScript.textContent : '';
      return { name, year, critics: parseScore(scoreText, 'criticsScore'), audience: parseScore(scoreText, 'audienceScore') };
    }

    // Four-state result, never throws. A hard 404/410 after redirects is
    // RT's definitive statement that the path is dead and demotes like a
    // mismatch (same definitive-miss-vs-transient split as initListCounts'
    // deleted-list tombstone). 403/429/5xx stay in error deliberately: they
    // are what a bot wall returns, and a bot wall must never demote links.
    async function fetchRtPage(rtPath) {
      if (typeof GM_xmlhttpRequest !== 'function') return { status: 'error' };
      try {
        const r = await gmFetchText(`https://www.rottentomatoes.com/${rtPath}`);
        if (r.status === 404 || r.status === 410) return { status: 'not-found' };
        if (r.status < 200 || r.status >= 300) return { status: 'error' };
        const data = parseRtPage(r.text);
        return data ? { status: 'ok', data } : { status: 'parse-failure' };
      } catch {
        // Network failure or timeout; transient, must not demote.
        return { status: 'error' };
      }
    }

    // Case-fold; strip diacritics (NFD, drop combining marks); delete
    // apostrophes (ASCII, right single quote, modifier letter); every other
    // non-alphanumeric becomes a space; collapse; drop one leading English
    // article. Deleting apostrophes (rather than spacing them) keeps
    // "Ocean's" equal to "Oceans" across the two sites' encodings.
    function normalizeTitle(title) {
      return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/['\u2019\u02BC]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:the|a|an) /, '');
    }

    // Titles agree on normalized equality, or when the longer raw title
    // extends the shorter at a subtitle separator (colon, opening
    // parenthesis, or space-surrounded dash) whose prefix normalizes equal
    // to the shorter title: "Blade Runner: The Final Cut" agrees with
    // "Blade Runner" while "Up in the Air" does not agree with "Up". An
    // empty normalized side or a null Trakt title makes the signal
    // unavailable rather than a disagreement.
    function titleSignal(traktTitle, rtName) {
      if (typeof traktTitle !== 'string' || !traktTitle) return 'unavailable';
      const normTrakt = normalizeTitle(traktTitle);
      const normRt = normalizeTitle(rtName);
      if (!normTrakt || !normRt) return 'unavailable';
      if (normTrakt === normRt) return 'agree';
      const [shortRaw, longRaw] = traktTitle.length <= rtName.length
        ? [traktTitle, rtName]
        : [rtName, traktTitle];
      const shortNorm = shortRaw === traktTitle ? normTrakt : normRt;
      for (const sep of longRaw.matchAll(/:|\(| [-\u2010\u2013\u2014] /g)) {
        if (normalizeTitle(longRaw.slice(0, sep.index)) === shortNorm) return 'agree';
      }
      return 'disagree';
    }

    // The +-1 tolerance absorbs festival-vs-wide-release boundary years.
    function yearSignal(traktYear, rtYear) {
      return Math.abs(traktYear - rtYear) <= 1 ? 'agree' : 'disagree';
    }

    // Demotion requires both independent signals to point at a different
    // work; any intermediate combination is uncertain, never destructive.
    function matchVerdict(years, titles) {
      if (years === 'agree' && titles === 'agree') return 'match';
      if (years === 'disagree' && titles === 'disagree') return 'mismatch';
      return 'uncertain';
    }

    // Maps the two-signal rule onto cache fields. Demotion (rtPath: null)
    // happens only on not-found or when both signals disagree; parse-failure,
    // error, and a missing Trakt year yield unknown (rtVerified: false, link
    // kept: a failed check is not a failed verification). rtTitle/rtYear are
    // stored exactly on uncertain verdicts (the click-time confirm slice's
    // inputs); rtScores exactly on match (resolution-time score storage is
    // match-only). Never throws: fetchRtPage is four-state, so the caller's
    // catch (and its failure backoff) stays reserved for Trakt and Wikidata
    // failures.
    async function verifyRtPath(rtPath, traktTitle, traktYear) {
      const blank = { rtVerified: false, rtTitle: null, rtYear: null, rtScores: null };
      if (!rtPath) {
        return { rtPath: null, ...blank };
      }
      const fetchStartedAt = Date.now();
      const result = await fetchRtPage(rtPath);
      if (result.status === 'not-found') {
        warn(`RT link demoted (not-found): ${rtPath}; trakt "${traktTitle}" (${traktYear}) vs RT null (null)`);
        return { rtPath: null, ...blank };
      }
      if (result.status !== 'ok' || typeof traktYear !== 'number') {
        return { rtPath, ...blank };
      }
      const years = yearSignal(traktYear, result.data.year);
      const titles = titleSignal(traktTitle, result.data.name);
      const verdict = matchVerdict(years, titles);
      if (verdict === 'match') {
        return {
          rtPath,
          rtVerified: 'auto',
          rtTitle: null,
          rtYear: null,
          rtScores: { critics: result.data.critics, audience: result.data.audience, fetchedAt: fetchStartedAt },
        };
      }
      if (verdict === 'mismatch') {
        warn(`RT link demoted (both-disagree): ${rtPath}; trakt "${traktTitle}" (${traktYear}) vs RT "${result.data.name}" (${result.data.year})`);
        return { rtPath: null, ...blank };
      }
      warn(`RT link uncertain: trakt "${traktTitle}" (${traktYear}) vs RT "${result.data.name}" (${result.data.year})`);
      return { rtPath, rtVerified: 'uncertain', rtTitle: result.data.name, rtYear: result.data.year, rtScores: null };
    }

    // The app's canonical ids for the title, riding along on its own OAuth
    // token; these beat scraping the page's IMDb tile, which shares provenance
    // with the unreliable native RT links.
    async function fetchTraktIds(auth, type, slug) {
      const response = await apiGet(auth, apiUrl(`/${mediaPathSegment(type)}/${slug}`));
      const body = await response.json();
      const ids = body && typeof body === 'object' ? body.ids : null;
      if (!ids || typeof ids !== 'object') {
        throw new Error(`Unexpected response shape for ${type} ${slug}`);
      }
      return {
        imdb: typeof ids.imdb === 'string' && ids.imdb ? ids.imdb : null,
        tmdb: typeof ids.tmdb === 'number' ? ids.tmdb : null,
        title: typeof body.title === 'string' && body.title ? body.title : null,
        year: typeof body.year === 'number' ? body.year : null,
      };
    }

    // Rotten Tomatoes has no id-lookup URL, but Wikidata bridges it: P345
    // (IMDb id) finds the entity via anonymous-CORS full-text search, P1258
    // (Rotten Tomatoes id) holds a path like "m/inception" or
    // "tv/breaking-bad". RT redirects stale slug variants server-side, so a
    // slightly outdated Wikidata value still lands on the right page.
    async function fetchRtPath(imdbId) {
      const searchUrl = new URL('https://www.wikidata.org/w/api.php?action=query&format=json&origin=*&list=search&srnamespace=0');
      searchUrl.searchParams.set('srsearch', 'haswbstatement:P345=' + imdbId);
      const qid = (await gmFetchJson(searchUrl.toString())).query?.search?.[0]?.title;
      if (!qid) return null;
      const claimsUrl = new URL('https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*&property=P1258');
      claimsUrl.searchParams.set('entity', qid);
      const value = (await gmFetchJson(claimsUrl.toString())).claims?.P1258?.[0]?.mainsnak?.datavalue?.value;
      return typeof value === 'string' && RT_PATH_PATTERN.test(value) ? value : null;
    }

    const inFlight = new Set();
    const backoff = createFailureBackoff();
    let authWarned = false;

    // Fire-and-forget resolution: scan renders search links immediately and a
    // completed resolution queues a rescan that upgrades them to direct links.
    // A missing Wikidata RT path is cached as null (the search fallback covers
    // it; the TTL retries eventually); transient failures are not cached and
    // retry after a short backoff.
    function resolveIds(type, slug) {
      const key = `${type}:${slug}`;
      if (inFlight.has(key) || backoff.isBackedOff(key)) {
        return;
      }
      const auth = readAuth();
      if (!auth) {
        backoff.record(key);
        if (!authWarned) {
          authWarned = true;
          warn('No Trakt access token in localStorage; keeping title-search links until login');
        }
        return;
      }
      inFlight.add(key);
      (async () => {
        const ids = await fetchTraktIds(auth, type, slug);
        const rtPath = ids.imdb ? await fetchRtPath(ids.imdb) : null;
        const verification = await verifyRtPath(rtPath, ids.title, ids.year);
        cachePut(key, { imdb: ids.imdb, tmdb: ids.tmdb, ...verification, fetchedAt: Date.now() });
        queueScan();
      })().catch(e => {
        backoff.record(key);
        warn(`Id resolution failed for ${key}; keeping title-search links`, e);
      }).finally(() => inFlight.delete(key));
    }

    // Detail pages only: /movies/<slug> and /shows/<slug>. Season selection is
    // a query param on the show URL, so shows keep their links across seasons.
    function pageContext() {
      const segments = location.pathname.split('/').filter(Boolean);
      if (segments.length !== 2) return null;
      const type = mediaType(segments[0]);
      return type ? { type, slug: segments[1] } : null;
    }

    function pageTitle() {
      const h1 = document.querySelector('.trakt-summary-title h1');
      const title = h1 ? h1.textContent.trim() : '';
      return title || null;
    }

    function rtSearchUrl(title) {
      return 'https://www.rottentomatoes.com/search?search=' + encodeURIComponent(title);
    }

    function lbSearchUrl(title) {
      return 'https://letterboxd.com/search/' + encodeURIComponent(title);
    }

    function rtUrl(entry, title) {
      return entry?.rtPath ? 'https://www.rottentomatoes.com/' + entry.rtPath : rtSearchUrl(title);
    }

    // Letterboxd's official id-redirect routes: /imdb/<id> and /tmdb/<id>
    // land directly on the film page.
    function lbUrl(entry, title) {
      if (entry?.imdb) return 'https://letterboxd.com/imdb/' + entry.imdb;
      if (entry?.tmdb) return 'https://letterboxd.com/tmdb/' + entry.tmdb;
      return lbSearchUrl(title);
    }

    // The href IDL getter re-serializes the URL (an apostrophe in a search
    // query reads back as %27), so comparing anchor.href against the target
    // string stays permanently unequal for some titles and the write would
    // repeat every scan. The content attribute round-trips verbatim, so it
    // is the comparable that actually settles.
    function syncHref(anchor, url) {
      if (anchor.getAttribute('href') !== url) {
        anchor.href = url;
      }
    }

    // Native RT links are unreliable (sometimes missing, sometimes the wrong
    // title), so every one of them is repointed. Svelte re-renders restore the
    // original hrefs; the observer rescan puts ours back, and the equality
    // check in syncHref keeps the pass idempotent.
    function rewriteRtAnchors(url) {
      for (const scope of document.querySelectorAll(REWRITE_SCOPES)) {
        for (const anchor of scope.querySelectorAll(RT_HREF_MATCH)) {
          if (!anchor.closest('.' + CHIP_CLASS)) {
            syncHref(anchor, url);
          }
        }
      }
    }

    // Dead native RT tiles are placeholders the app renders when it has no
    // score: a "-" value, a trakt-no-link anchor pointing back at the title
    // page, and a grayscaled icon. Their hrefs never mention rottentomatoes,
    // so rewriteRtAnchors and the native-RT guard in scan are blind to them;
    // the icon viewBoxes (critic tomato and audience popcorn) identify them
    // instead. Takeover turns each into a live link with native-live-tile
    // markup: repointed at the RT URL, unlocked, recolored. The grey comes
    // from two stacked sources, both of which must go: an inline grayscale
    // filter on the svg, and an app rule keyed on the item NOT having
    // has-valid-rating (it lives in a cross-origin sheet, so it is invisible
    // to cssRules walks). All writes are class/attribute/style-level, so the
    // body observer does not refire, and Svelte re-renders that restore the
    // dead form are simply re-taken on the next scan. Scope is the summary
    // row only, deliberately: whether the ratings drawer ever renders dead
    // tiles is unverified, so the drawer keeps rewrite-only treatment.
    const RT_TILE_VIEWBOXES = new Set(['0 0 145 140', '0 0 80 80']);

    function takeOverDeadRtTiles(row, url) {
      for (const item of row.querySelectorAll(`rating:not(.${CHIP_CLASS}) .rating-item:not(.has-valid-rating)`)) {
        const svg = item.querySelector('svg');
        const anchor = item.closest('a');
        if (!svg || !anchor || !RT_TILE_VIEWBOXES.has(svg.getAttribute('viewBox'))) continue;
        anchor.classList.remove('trakt-no-link');
        anchor.classList.add('trakt-link');
        if (anchor.getAttribute('target') !== '_blank') anchor.target = '_blank';
        if (anchor.getAttribute('rel') !== 'noopener') anchor.rel = 'noopener';
        syncHref(anchor, url);
        if (svg.style.filter) svg.style.filter = '';
        item.classList.add('has-valid-rating');
      }
    }

    // Chips clone a native tile so the app's Svelte-scoped styles keep applying;
    // the score block is dropped (a search link has no rating to show) and the
    // icon swapped. Injected nodes are not in Svelte's virtual DOM, so marker
    // attributes survive on them (unlike on app-managed nodes).
    function buildChip(templateTile, iconSvg, label) {
      const chip = templateTile.cloneNode(true);
      const anchor = chip.querySelector('a');
      const item = chip.querySelector('.rating-item');
      if (!anchor || !item) return null;
      chip.classList.add(CHIP_CLASS);
      anchor.classList.remove('trakt-no-link');
      anchor.classList.add('trakt-link');
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.title = label;
      anchor.setAttribute('aria-label', label);
      item.classList.add('has-valid-rating');
      item.replaceChildren();
      item.insertAdjacentHTML('afterbegin', iconSvg);
      return chip;
    }

    function ensureChip(row, templateTile, kind, label, url) {
      let chip = row.querySelector(`.${CHIP_CLASS}[${KIND_ATTR}="${kind}"]`);
      if (!chip) {
        chip = buildChip(templateTile, ICONS[kind], label);
        if (!chip) {
          warn(`Ratings tile markup changed; cannot inject ${kind} chip`);
          return;
        }
        chip.setAttribute(KIND_ATTR, kind);
        // The row ends with a tooltip-wrapped drilldown chevron; chips
        // belong with the tiles, so insert after the last rating element
        // (native or chip) instead of appending past the chevron.
        const tiles = [...row.children].filter(el => el.tagName === 'RATING');
        if (tiles.length === 0) {
          warn(`Ratings row shape changed; cannot place ${kind} chip`);
          return;
        }
        tiles[tiles.length - 1].after(chip);
      }
      const anchor = chip.querySelector('a');
      if (anchor) {
        syncHref(anchor, url);
      }
    }

    function removeChip(row, kind) {
      const chip = row.querySelector(`.${CHIP_CLASS}[${KIND_ATTR}="${kind}"]`);
      if (chip) chip.remove();
    }

    function scan() {
      const page = pageContext();
      if (!page) return;
      const row = document.querySelector(ROW_SELECTOR);
      if (!row) return;
      const title = pageTitle();
      if (!title) return;
      const key = `${page.type}:${page.slug}`;
      const entry = cacheGet(key);
      if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
        resolveIds(page.type, page.slug);
      }
      // An expired entry still styles the links while the refresh runs:
      // stale direct links beat search links.
      const rt = rtUrl(entry, title);
      rewriteRtAnchors(rt);
      const templateTile = row.querySelector(`rating:not(.${CHIP_CLASS})`);
      if (!templateTile) return;
      takeOverDeadRtTiles(row, rt);
      // A rewritten or taken-over native RT tile already links right, so the
      // icon-only chip is a legacy fallback for rows with no RT tiles at all
      // (current app markup always renders the pair, dead or alive).
      const hasNativeRt = !!templateTile.parentElement.querySelector(`rating:not(.${CHIP_CLASS}) ${RT_HREF_MATCH}`);
      if (hasNativeRt) {
        removeChip(row, 'rt');
      } else {
        ensureChip(row, templateTile, 'rt', 'Rotten Tomatoes', rt);
      }
      // Letterboxd covers films only; drop the chip when SPA navigation
      // reuses the row for a show.
      if (page.type === 'movie') {
        ensureChip(row, templateTile, 'lb', 'Letterboxd', lbUrl(entry, title));
      } else {
        removeChip(row, 'lb');
      }
    }

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: list item counts
  // Restores the pre-redesign list item counts: an items chip cloned from
  // the like-count button on user-list cards and on the list detail page
  // header, and a text suffix on card-less surfaces (lane headings that
  // link to a single list, the watchlist page header). Smart lists are
  // skipped by construction (their cards and headings carry no
  // /users/.../lists/... anchor); the API stores no count for them.
  // ---------------------------------------------------------------------

  (function initListCounts() {
    const CACHE_KEY = 'trakt-list-counts-cache';
    const CACHE_VERSION = 1;
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 500;
    const CHIP_CLASS = 'tlc-chip';
    const COUNT_TEXT_CLASS = 'tlc-count-text';
    const KEY_ATTR = 'data-tlc-key';
    const BULK_GATE = '*bulk*';
    const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">'
      + '<line x1="4" y1="6" x2="20" y2="6"/>'
      + '<line x1="4" y1="12" x2="20" y2="12"/>'
      + '<line x1="4" y1="18" x2="14" y2="18"/>'
      + '</svg>';

    // Cache root: { v, invalidatedAt, bulkFetchedAt, me, entries } where
    // entries map "<owner>/<slug>" to { count, fetchedAt } or a
    // { gone: true, fetchedAt } tombstone for a deleted list. Entries are
    // stamped with the FETCH START time so a fetch overlapping an
    // invalidation stores a displayable but already-stale entry instead of
    // pinning pre-mutation data for a full TTL.
    function loadCache() {
      const raw = readJson(CACHE_KEY);
      const versionOk = raw && typeof raw === 'object' && raw.v === CACHE_VERSION;
      const entries = {};
      if (versionOk && raw.entries && typeof raw.entries === 'object') {
        for (const [key, entry] of Object.entries(raw.entries)) {
          const shapeOk = entry && typeof entry === 'object' && typeof entry.fetchedAt === 'number'
            && (typeof entry.count === 'number' || entry.gone === true);
          if (shapeOk) {
            entries[key] = entry;
          }
        }
      }
      return {
        invalidatedAt: versionOk && typeof raw.invalidatedAt === 'number' ? raw.invalidatedAt : 0,
        bulkFetchedAt: versionOk && typeof raw.bulkFetchedAt === 'number' ? raw.bulkFetchedAt : 0,
        me: versionOk && typeof raw.me === 'string' ? raw.me : null,
        entries,
      };
    }

    const cache = loadCache();

    function persistCache() {
      const keys = Object.keys(cache.entries);
      if (keys.length > CACHE_MAX_ENTRIES) {
        keys.sort((a, b) => cache.entries[a].fetchedAt - cache.entries[b].fetchedAt)
          .slice(0, keys.length - CACHE_MAX_ENTRIES)
          .forEach(k => delete cache.entries[k]);
      }
      writeJson(CACHE_KEY, Object.assign({ v: CACHE_VERSION }, cache));
    }

    function entryStale(entry) {
      return entry.fetchedAt < cache.invalidatedAt || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
    }

    function bulkStale() {
      return cache.bulkFetchedAt < cache.invalidatedAt || Date.now() - cache.bulkFetchedAt > CACHE_TTL_MS;
    }

    // Entries are keyed by the canonical owner username, never by "me", so
    // the same list reached via a username URL and a /users/me/ URL shares
    // one entry. Before the username is learned the "me" prefix passes
    // through; those lookups miss and resolve via the API, whose response
    // supplies the canonical owner.
    function canonicalKey(ownerSegment, slug) {
      const owner = ownerSegment === 'me' && cache.me ? cache.me : ownerSegment;
      return owner + '/' + slug;
    }

    // The shared listPathParts shape test, extended with this feature's
    // canonical cache key.
    function parseListPath(pathname) {
      const parts = listPathParts(pathname);
      if (!parts) {
        return null;
      }
      return { kind: 'list', ownerSegment: parts.owner, slug: parts.slug, key: canonicalKey(parts.owner, parts.slug) };
    }

    // Watchlists have no slug; their cache keys live under the
    // collision-free "watchlist:" prefix (list keys always contain a slash).
    function watchlistKey(ownerSegment) {
      const owner = ownerSegment === 'me' && cache.me ? cache.me : ownerSegment;
      return 'watchlist:' + owner;
    }

    // A watchlist path is exactly /users/<owner>/watchlist.
    function parseWatchlistPath(pathname) {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length !== 3 || segments[0] !== 'users' || segments[2] !== 'watchlist') {
        return null;
      }
      return { kind: 'watchlist', ownerSegment: segments[1], key: watchlistKey(segments[1]) };
    }

    // Primes the entry for one API list object under its canonical key.
    // Returns the key, or null when the response shape has drifted.
    function primeEntry(list, startedAt) {
      const owner = list && list.user && list.user.ids ? list.user.ids.slug : null;
      const slug = list && list.ids ? list.ids.slug : null;
      if (typeof owner !== 'string' || typeof slug !== 'string' || typeof list.item_count !== 'number') {
        return null;
      }
      cache.entries[owner + '/' + slug] = { count: list.item_count, fetchedAt: startedAt };
      return owner + '/' + slug;
    }

    const backoff = createFailureBackoff();
    const inFlight = new Set();
    let authWarned = false;

    function noteAuthMissing() {
      if (!authWarned) {
        authWarned = true;
        warn('No Trakt access token in localStorage; list counts stay hidden until login');
      }
    }

    function noteFailure(gateKey, e) {
      if (String(e && e.message).startsWith('HTTP 401 ')) {
        noteAuthMissing();
      }
      backoff.record(gateKey);
    }

    // One bulk call primes every list of the logged-in user (own and saved)
    // and teaches the canonical username; foreign lists resolve one by one.
    function resolveBulk() {
      if (inFlight.has(BULK_GATE) || backoff.isBackedOff(BULK_GATE)) {
        return;
      }
      const auth = readAuth();
      if (!auth) {
        backoff.record(BULK_GATE);
        noteAuthMissing();
        return;
      }
      inFlight.add(BULK_GATE);
      const startedAt = Date.now();
      (async () => {
        // The endpoint paginates silently (one page without params); the
        // raised limit keeps a single call sufficient for realistic list
        // counts, and any list beyond it resolves via the per-list path.
        const url = apiUrl('/users/me/lists');
        url.searchParams.set('limit', 250);
        const response = await apiGet(auth, url);
        const body = await response.json();
        if (!Array.isArray(body)) {
          throw new Error('Unexpected response shape for /users/me/lists');
        }
        for (const list of body) {
          primeEntry(list, startedAt);
        }
        const first = body[0];
        if (first && first.user && first.user.ids && typeof first.user.ids.slug === 'string') {
          cache.me = first.user.ids.slug;
        }
        cache.bulkFetchedAt = startedAt;
        persistCache();
        queueScan();
      })().catch(e => {
        noteFailure(BULK_GATE, e);
        warn('List counts bulk refresh failed; keeping cached counts', e);
      }).finally(() => inFlight.delete(BULK_GATE));
    }

    function resolveSingle(ownerSegment, slug) {
      const gateKey = ownerSegment + '/' + slug;
      if (inFlight.has(gateKey) || backoff.isBackedOff(gateKey)) {
        return;
      }
      const auth = readAuth();
      if (!auth) {
        backoff.record(gateKey);
        noteAuthMissing();
        return;
      }
      inFlight.add(gateKey);
      const startedAt = Date.now();
      (async () => {
        let response;
        try {
          response = await apiGet(auth, apiUrl('/users/' + ownerSegment + '/lists/' + slug));
        } catch (e) {
          // A deleted list is a definitive miss, not a transient failure:
          // tombstone it so the chip disappears and the backoff cannot spin
          // on refetching it. The tombstone ages out with the normal TTL.
          if (String(e && e.message).startsWith('HTTP 404 ')) {
            cache.entries[canonicalKey(ownerSegment, slug)] = { gone: true, fetchedAt: startedAt };
            persistCache();
            queueScan();
            return;
          }
          throw e;
        }
        const body = await response.json();
        if (!primeEntry(body, startedAt)) {
          throw new Error('Unexpected response shape for ' + gateKey);
        }
        if (ownerSegment === 'me' && body.user && body.user.ids && typeof body.user.ids.slug === 'string') {
          cache.me = body.user.ids.slug;
        }
        persistCache();
        queueScan();
      })().catch(e => {
        noteFailure(gateKey, e);
        warn('List count fetch failed for ' + gateKey + '; keeping cached value', e);
      }).finally(() => inFlight.delete(gateKey));
    }

    // Watchlist counts have no list object to read; the total rides on the
    // CORS-exposed pagination headers, and one item is the cheapest page
    // that carries them. The bulk fetch never covers watchlist keys.
    function resolveWatchlist(ownerSegment) {
      const gateKey = 'watchlist:' + ownerSegment;
      if (inFlight.has(gateKey) || backoff.isBackedOff(gateKey)) {
        return;
      }
      const auth = readAuth();
      if (!auth) {
        backoff.record(gateKey);
        noteAuthMissing();
        return;
      }
      inFlight.add(gateKey);
      const startedAt = Date.now();
      (async () => {
        const url = apiUrl('/users/' + ownerSegment + '/watchlist');
        url.searchParams.set('limit', 1);
        let response;
        try {
          response = await apiGet(auth, url);
        } catch (e) {
          // Same definitive-miss rule as lists: a 404 (unknown or private
          // user) is tombstoned so the backoff cannot spin on it.
          if (String(e && e.message).startsWith('HTTP 404 ')) {
            cache.entries[watchlistKey(ownerSegment)] = { gone: true, fetchedAt: startedAt };
            persistCache();
            queueScan();
            return;
          }
          throw e;
        }
        const count = parseInt(response.headers.get('X-Pagination-Item-Count'), 10);
        if (!Number.isFinite(count)) {
          throw new Error('Missing pagination item count for ' + gateKey);
        }
        cache.entries[watchlistKey(ownerSegment)] = { count, fetchedAt: startedAt };
        persistCache();
        queueScan();
      })().catch(e => {
        noteFailure(gateKey, e);
        warn('Watchlist count fetch failed for ' + gateKey + '; keeping cached value', e);
      }).finally(() => inFlight.delete(gateKey));
    }

    function formatItems(count) {
      return count.toLocaleString('en-US') + (count === 1 ? ' item' : ' items');
    }

    // The chip clones the adjacent like-count element so the app's
    // Svelte-scoped styles keep applying; injected nodes are outside
    // Svelte's virtual DOM, so the marker class and key attribute survive
    // re-renders (unlike attributes on app-managed nodes).
    function buildChip(likeAction) {
      const chip = likeAction.cloneNode(true);
      const button = chip.querySelector('button');
      const label = chip.querySelector('.button-label p');
      const icon = chip.querySelector('.button-icon');
      if (!button || !label || !icon) {
        return null;
      }
      chip.classList.add(CHIP_CLASS);
      button.style.pointerEvents = 'none';
      icon.innerHTML = ICON;
      return chip;
    }

    // Places or refreshes the chip before a like action; removes it when
    // there is nothing trustworthy to show (no entry yet, or a tombstone):
    // a missing count shows nothing, never a wrong or placeholder number.
    function ensureChip(likeAction, key, entry) {
      let chip = likeAction.parentElement.querySelector('.' + CHIP_CLASS);
      if (!entry || entry.gone === true) {
        if (chip) {
          chip.remove();
        }
        return null;
      }
      if (!chip) {
        chip = buildChip(likeAction);
        if (!chip) {
          warn('Like action markup changed; cannot inject list count chip');
          return null;
        }
        likeAction.before(chip);
      }
      chip.setAttribute(KEY_ATTR, key);
      chip.querySelector('.button-label p').textContent = entry.count.toLocaleString('en-US');
      const button = chip.querySelector('button');
      button.title = formatItems(entry.count);
      button.setAttribute('aria-label', formatItems(entry.count));
      return chip;
    }

    // Text-suffix variant for surfaces without a like action to clone: a
    // span cloned from a nearby styled element keeps the app's scoped
    // styling, with small inline tweaks for its secondary role.
    function ensureCountText({ template, parent, styles }, key, entry) {
      let span = parent.querySelector('.' + COUNT_TEXT_CLASS);
      if (!entry || entry.gone === true) {
        if (span) {
          span.remove();
        }
        return null;
      }
      if (!span) {
        span = template.cloneNode(false);
        span.classList.add(COUNT_TEXT_CLASS);
        span.classList.remove('ellipsis');
        for (const [prop, value] of Object.entries(styles)) {
          span.style.setProperty(prop, value);
        }
        parent.appendChild(span);
      }
      span.setAttribute(KEY_ATTR, key);
      span.textContent = '· ' + entry.count.toLocaleString('en-US');
      span.title = formatItems(entry.count);
      return span;
    }

    function cardTarget(card) {
      for (const anchor of card.querySelectorAll('a[href]')) {
        const target = parseListPath(new URL(anchor.href, location.origin).pathname);
        if (target) {
          return target;
        }
      }
      return null;
    }

    // Placements: chips on the list detail header and user-list cards,
    // text suffixes on card-less surfaces (the watchlist page header and
    // lane headings whose anchor resolves to a single list or watchlist;
    // section groupings and smart lists fall out via the path parsers).
    // Stray nodes (the SPA reused or repurposed a container) are removed
    // at the end of each scan.
    function scan() {
      const placements = [];
      const pageList = parseListPath(location.pathname);
      if (pageList) {
        const headerLike = document.querySelector('.trakt-navbar-header-actions trakt-list-like-action');
        if (headerLike) {
          placements.push({ chip: { likeAction: headerLike }, target: pageList });
        }
      }
      // The watchlist page header has no like action to clone (verified),
      // so its count rides inline in the title, styled like the mode span.
      const pageWatchlist = parseWatchlistPath(location.pathname);
      const headerTitle = document.querySelector('.trakt-navbar-header-title');
      if (pageWatchlist && headerTitle) {
        const h1 = headerTitle.querySelector('h1');
        const template = headerTitle.querySelector('span.meta-info:not(.' + COUNT_TEXT_CLASS + ')');
        if (h1 && template) {
          placements.push({
            text: { template, parent: h1, styles: { display: 'inline-block', 'margin-left': '8px' } },
            target: pageWatchlist,
          });
        }
      }
      for (const card of document.querySelectorAll('.trakt-list-summary-card')) {
        const likeAction = card.querySelector('trakt-list-like-action');
        const target = likeAction ? cardTarget(card) : null;
        if (target) {
          placements.push({ chip: { likeAction }, target });
        }
      }
      for (const inset of document.querySelectorAll('.trakt-list-inset-title')) {
        const anchor = inset.querySelector('.trakt-list-title a[href]');
        const wrapper = inset.querySelector('.trakt-list-title-wrapper');
        const template = wrapper ? wrapper.querySelector('span.title') : null;
        if (!anchor || !template) {
          continue;
        }
        const pathname = new URL(anchor.href, location.origin).pathname;
        const target = parseListPath(pathname) || parseWatchlistPath(pathname);
        if (!target) {
          continue;
        }
        // A heading with its own like action (a list rendered as a lane)
        // takes the chip, matching the detail header; like-less headings
        // (the watchlist lane) keep the text suffix.
        const likeAction = inset.querySelector('trakt-list-like-action');
        if (likeAction) {
          placements.push({ chip: { likeAction }, target });
        } else {
          placements.push({
            text: { template, parent: wrapper, styles: { opacity: '0.6', 'font-weight': 'normal' } },
            target,
          });
        }
      }
      const placed = new Set();
      let needsBulk = false;
      for (const { chip, text, target } of placements) {
        const entry = cache.entries[target.key] || null;
        if (!entry || entryStale(entry)) {
          if (target.kind === 'watchlist') {
            resolveWatchlist(target.ownerSegment);
          } else if (bulkStale()) {
            // The bulk fetch goes first: it may prime this key (and the
            // canonical username) in one call; the rescan it queues sends
            // still-unresolved keys down the per-list path.
            needsBulk = true;
          } else {
            resolveSingle(target.ownerSegment, target.slug);
          }
        }
        const el = chip ? ensureChip(chip.likeAction, target.key, entry) : ensureCountText(text, target.key, entry);
        if (el) {
          placed.add(el);
        }
      }
      if (needsBulk) {
        resolveBulk();
      }
      for (const el of document.querySelectorAll('.' + CHIP_CLASS + ', .' + COUNT_TEXT_CLASS)) {
        if (!placed.has(el)) {
          el.remove();
        }
      }
    }

    // Any successful app mutation may have changed a list (coarse by
    // design; refreshing costs one bulk call plus per-list calls for
    // visible foreign lists only). One root-stamp write keeps per-entry
    // fetchedAt, and with it LRU ordering, intact.
    mutationCallbacks.push(() => {
      cache.invalidatedAt = Date.now();
      persistCache();
    });

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: Uninterested list truncate
  // One-click "Truncate" entry in the kebab popup menu of the owner's
  // Uninterested list, trimming it to its newest TRUNCATE_LIMIT items by
  // removing the oldest by listed_at. Personal by design: the target list
  // is hardcoded; for any other user of the script the entry can appear
  // only on the owner's public list surfaces, and a click fails harmlessly
  // against their own account, where the slug does not exist.
  // ---------------------------------------------------------------------

  (function initListTruncate() {
    const TRUNCATE_OWNER = 'thefork';
    const TRUNCATE_SLUG = 'uninterested-61febd75-9914-44d8-9460-894a29968281';
    const TRUNCATE_LIMIT = 1000;
    const PAGE_LIMIT = 1000;
    const CLICK_FRESH_MS = 3000;
    const LABEL_RESET_MS = 5000;
    const ROW_CLASS = 'tlt-row';
    const TYPE_KEYS = { movie: 'movies', show: 'shows', season: 'seasons', episode: 'episodes', person: 'people' };
    const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
      + '<circle cx="6" cy="6" r="3"/>'
      + '<circle cx="6" cy="18" r="3"/>'
      + '<line x1="20" y1="4" x2="8.12" y2="15.88"/>'
      + '<line x1="14.47" y1="14.48" x2="20" y2="20"/>'
      + '<line x1="8.12" y1="8.12" x2="12" y2="12"/>'
      + '</svg>';

    // Kebab-click record: the popup carries no back-reference to its list,
    // so identity is captured at click time from the button's surroundings.
    // Only the click time needs recording; only one list can ever be armed.
    let armedAt = 0;

    // Run state machine; rows are pure renderers of this state.
    // 'idle' | 'running' | a terminal label string.
    let state = 'idle';
    let running = false;
    let postAttempted = false;
    let row = null;
    let resetTimer = 0;
    let authWarned = false;
    let shapeWarned = false;

    function isTargetListPath(pathname) {
      const parts = listPathParts(pathname);
      return parts !== null && (parts.owner === 'me' || parts.owner === TRUNCATE_OWNER) && parts.slug === TRUNCATE_SLUG;
    }

    // Card and lane kebabs resolve through their container's anchors; a
    // header kebab (inside .trakt-navbar-header-actions only) resolves
    // through the page path. The scoping matters: item cards on the list
    // detail page carry their own kebabs and must not arm the record.
    function kebabTargetsList(button) {
      const context = button.closest('.trakt-list-summary-card') || button.closest('.trakt-list-inset-title');
      if (context) {
        for (const anchor of context.querySelectorAll('a[href]')) {
          if (isTargetListPath(new URL(anchor.href, location.origin).pathname)) {
            return true;
          }
        }
        return false;
      }
      return !!button.closest('.trakt-navbar-header-actions') && isTargetListPath(location.pathname);
    }

    // Capture phase, so the record exists before the app's own handlers
    // run, regardless of how they handle propagation.
    document.addEventListener('click', e => {
      if (!(e.target instanceof Element)) return;
      const button = e.target.closest('button.trakt-popup-menu-button');
      if (!button) return;
      if (kebabTargetsList(button)) {
        armedAt = Date.now();
      } else {
        // Also removes an existing row: a new popup implies a kebab click,
        // so this covers the SPA reusing one popup container for another
        // list's menu, which the row cannot detect from the popup itself.
        armedAt = 0;
        removeRow();
      }
    }, true);

    function removeRow() {
      if (row !== null) {
        const menu = row.parentElement;
        row.remove();
        if (menu !== null) {
          menu.style.removeProperty('max-height');
        }
        row = null;
      }
    }

    // The app caps the menu at the height of its four native rows, so the
    // injected fifth row would otherwise force a scrollbar. Inline styles
    // survive Svelte re-renders; the popup node is destroyed on close, so
    // the override dies with it (and removeRow restores it early).
    function growMenu(menu) {
      if (menu.scrollHeight > menu.clientHeight) {
        menu.style.setProperty('max-height', menu.scrollHeight + 'px', 'important');
      }
    }

    function rowAttached() {
      return row !== null && row.isConnected;
    }

    function currentLabel() {
      if (state === 'running') return 'Truncating...';
      if (state === 'idle') return 'Truncate';
      return state;
    }

    function renderRow() {
      if (!rowAttached()) return;
      const labelEl = row.querySelector('[data-tlt-label]');
      if (labelEl) {
        labelEl.textContent = currentLabel();
      }
      row.style.pointerEvents = state === 'running' ? 'none' : '';
      row.style.opacity = state === 'running' ? '0.6' : '';
    }

    function setState(next) {
      state = next;
      if (resetTimer) {
        // A pending terminal reset must not flip the label mid-run.
        clearTimeout(resetTimer);
        resetTimer = 0;
      }
      const terminal = next !== 'idle' && next !== 'running';
      if (terminal) {
        resetTimer = setTimeout(() => {
          resetTimer = 0;
          state = 'idle';
          renderRow();
        }, LABEL_RESET_MS);
        if (!rowAttached()) {
          // The row label is the only UI surface; when it is gone the
          // outcome (success included) must not be lost.
          warn('Truncate outcome (no row visible): ' + next);
        }
      }
      renderRow();
    }

    // The popup markup has no stable identity; locate the Share row as a
    // childless visible element reading "Share" whose ancestor has a
    // sibling subtree containing another known row label.
    function locateShareRow() {
      const leaves = [...document.querySelectorAll('div, p, span, button, a, li')].filter(el =>
        el.children.length === 0 && el.textContent.trim() === 'Share' && el.offsetParent !== null);
      for (const leaf of leaves) {
        let node = leaf;
        while (node.parentElement && node.parentElement !== document.body) {
          const parent = node.parentElement;
          const siblings = [...parent.children].filter(c => c !== node);
          if (siblings.some(s => s.textContent.includes('Reorder') || s.textContent.includes('Delete'))) {
            return { shareRow: node, menu: parent };
          }
          node = parent;
        }
      }
      return null;
    }

    // Clone the Share row so the app's Svelte-scoped styles keep applying;
    // injected nodes are outside Svelte's virtual DOM, so the marker class
    // survives re-renders. Cloned rows carry no Svelte listeners.
    function buildRow(shareRow) {
      const clone = shareRow.cloneNode(true);
      const labelEl = [...clone.querySelectorAll('*')].find(el =>
        el.children.length === 0 && el.textContent.trim() === 'Share');
      const svg = clone.querySelector('svg');
      if (!labelEl || !svg) {
        return null;
      }
      clone.classList.add(ROW_CLASS);
      labelEl.setAttribute('data-tlt-label', '1');
      const iconHost = svg.parentElement;
      svg.remove();
      iconHost.insertAdjacentHTML('afterbegin', ICON);
      clone.addEventListener('click', e => {
        // Intended to keep the app from closing the popup on our click; an
        // assumption about the app's dismissal mechanism. The design does
        // not depend on it (run state covers a closed popup).
        e.stopPropagation();
        run();
      });
      return clone;
    }

    function scan() {
      if (row !== null && !row.isConnected) {
        row = null;
      }
      if (rowAttached()) {
        renderRow();
        return;
      }
      if (Date.now() - armedAt >= CLICK_FRESH_MS) {
        // The freshness window expires records whose popup never appeared.
        return;
      }
      const located = locateShareRow();
      if (!located) {
        // Popup not rendered yet; silent, record expiry covers never-appearing.
        return;
      }
      const existing = located.menu.querySelector('.' + ROW_CLASS);
      if (existing) {
        row = existing;
        growMenu(located.menu);
        renderRow();
        return;
      }
      const built = buildRow(located.shareRow);
      if (built === null) {
        if (!shapeWarned) {
          shapeWarned = true;
          warn('Popup row shape unrecognized; cannot inject Truncate');
        }
        return;
      }
      located.menu.appendChild(built);
      row = built;
      growMenu(located.menu);
      renderRow();
    }

    async function truncate(auth) {
      const items = [];
      let expectedTotal = null;
      for (let page = 1; ; page++) {
        const url = apiUrl('/users/me/lists/' + TRUNCATE_SLUG + '/items');
        url.searchParams.set('page', page);
        url.searchParams.set('limit', PAGE_LIMIT);
        const response = await apiGet(auth, url);
        const batch = await response.json();
        if (!Array.isArray(batch)) {
          throw new Error('Unexpected items response shape');
        }
        if (page === 1) {
          expectedTotal = parseInt(response.headers.get('X-Pagination-Item-Count'), 10);
        }
        items.push(...batch);
        const pageCount = parseInt(response.headers.get('X-Pagination-Page-Count'), 10);
        if (batch.length === 0) break;
        if (Number.isFinite(pageCount) ? page >= pageCount : batch.length < PAGE_LIMIT) break;
      }
      // Completeness guard, fail closed (missing or unparsable header
      // included): the selection math must never run on a silently
      // truncated walk, because the removal is irreversible.
      if (!Number.isFinite(expectedTotal) || expectedTotal !== items.length) {
        throw new Error('Item count mismatch: fetched ' + items.length + ', header says ' + expectedTotal);
      }
      // The sort key IS the trim policy, so it fails closed too. The sort
      // itself is lexicographic: fixed-width ISO 8601 UTC strings compare
      // lexicographically in chronological order.
      for (const item of items) {
        if (typeof item.listed_at !== 'string' || Number.isNaN(Date.parse(item.listed_at))) {
          throw new Error('Item with missing or unparsable listed_at');
        }
      }
      items.sort((a, b) => (a.listed_at < b.listed_at ? -1 : a.listed_at > b.listed_at ? 1 : 0));
      if (items.length <= TRUNCATE_LIMIT) {
        return 'Already at ' + TRUNCATE_LIMIT.toLocaleString('en-US') + ' or less';
      }
      // No dedupe of the selection, deliberately: trakt ids are per-type
      // namespaces (a movie and a show can share an id), so id-only dedupe
      // would wrongly collapse distinct entries, and concurrent list edits
      // during the walk are arithmetically self-compensating for the
      // removal count, with the completeness guard as the backstop.
      const excess = items.slice(0, items.length - TRUNCATE_LIMIT);
      const payload = { movies: [], shows: [], seasons: [], episodes: [], people: [] };
      let sent = 0;
      for (const item of excess) {
        const key = TYPE_KEYS[item.type];
        const id = item[item.type] && item[item.type].ids ? item[item.type].ids.trakt : undefined;
        if (!key || typeof id !== 'number') {
          // Better to under-trim than to send a malformed payload.
          warn('Truncate skipping item with unrecognized type or missing trakt id:', item.type);
          continue;
        }
        payload[key].push({ ids: { trakt: id } });
        sent++;
      }
      if (sent === 0) {
        throw new Error('Every selected item was skipped; nothing sendable');
      }
      postAttempted = true;
      const url = apiUrl('/users/me/lists/' + TRUNCATE_SLUG + '/items/remove');
      const response = await apiPost(auth, url, payload);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url.pathname}`);
      }
      const body = await response.json();
      const deleted = body && typeof body === 'object' ? body.deleted : null;
      if (!deleted || typeof deleted !== 'object') {
        throw new Error('Unexpected remove response shape');
      }
      // The label never reports the requested count as if it were the
      // server-confirmed count.
      const n = Object.values(TYPE_KEYS).reduce(
        (sum, key) => sum + (typeof deleted[key] === 'number' ? deleted[key] : 0), 0);
      if (n < sent) {
        warn('Truncate partial removal: ' + n + ' of ' + sent + ' deleted; not_found:', body.not_found);
        return 'Removed ' + n.toLocaleString('en-US') + ' of ' + sent.toLocaleString('en-US');
      }
      return 'Removed ' + n.toLocaleString('en-US');
    }

    async function run() {
      if (running) return;
      running = true;
      postAttempted = false;
      setState('running');
      try {
        const auth = readAuth();
        if (!auth) {
          if (!authWarned) {
            authWarned = true;
            warn('No Trakt access token in localStorage; cannot truncate until login');
          }
          setState('Failed, see console');
          return;
        }
        setState(await truncate(auth));
      } catch (e) {
        const status = /^HTTP (\d+) /.exec(String(e && e.message));
        if (postAttempted && (!status || status[1].startsWith('5'))) {
          // Indeterminate: the server may still have applied the removal.
          warn('Truncate failed; the removal may have been applied server-side. Clicking again is safe: every run recomputes from a fresh walk.', e);
        } else {
          warn('Truncate failed' + (postAttempted ? '' : ' before anything was removed'), e);
        }
        setState('Failed, see console');
      } finally {
        if (postAttempted) {
          // Exactly once per settled POST, on every outcome class: the
          // sandbox fetch bypasses the mutation hook, so the pipeline is
          // notified explicitly and the count chips refresh. A 4xx that
          // changed nothing merely costs one redundant refresh.
          notifyMutation();
        }
        running = false;
      }
    }

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: quick list toggles
  // One-click Anticipated/Uninterested membership toggles in the card
  // popup menu and the summary-page actions menu, with optimistic fade
  // sync. Membership data rides the list-membership engine's sweep via
  // quickLists.
  // ---------------------------------------------------------------------

  (function initQuickListToggles() {
    const ENTRY_ATTR = 'data-qlt-entry';
    const HEIGHT_ATTR = 'data-qlt-prev-max-height';
    const CONTEXT_FRESH_MS = 2000;
    const TOAST_ID = 'qlt-toast';
    const TOAST_DISMISS_MS = 4000;

    // Icon table keyed from QUICK_LIST_NAMES via computed properties, so a
    // rename in the shared constant cannot silently orphan an icon set;
    // the per-icon meaning stays positional (first list, second list).
    // Outline = not a member, filled = member. Paths are Material Symbols
    // 24x24: hourglass for Anticipated, block/cancel-x for Uninterested.
    const iconSvg = path => '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="' + path + '"/></svg>';
    const ICONS = {
      [QUICK_LIST_NAMES[0]]: {
        outline: iconSvg('M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z'),
        filled: iconSvg('M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6z'),
      },
      [QUICK_LIST_NAMES[1]]: {
        outline: iconSvg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z'),
        filled: iconSvg('M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z'),
      },
    };

    let pendingContext = null;
    let warnedNoData = false;
    const warnedTargets = new Set();
    const inFlight = new Set();
    let toastTimer = 0;

    // The membership key format shared with the membership engine's
    // cache (itemSlug's 'movie:<slug>' / 'show:<slug>'), built in one
    // place.
    const slugKeyOf = (type, slug) => `${type}:${slug}`;

    // Card identity: an eligible poster link has a bare two-segment
    // /movies/<slug> or /shows/<slug> pathname AND no season/episode query
    // param. The app encodes card granularity in query params on an
    // otherwise bare pathname (see the fade feature's cardTarget), so the
    // query check, not path depth, is what excludes season/episode cards;
    // person cards fail the pathname check. Context type is the module
    // mediaType() singular ('movie'|'show'), the same canonical form the
    // cache keys use.
    function cardContext(button) {
      const card = button.closest('.trakt-card');
      if (!card) return null;
      for (const anchor of card.querySelectorAll('a[href]')) {
        const url = new URL(anchor.href, location.origin);
        const segments = url.pathname.split('/').filter(Boolean);
        const type = segments.length === 2 ? mediaType(segments[0]) : null;
        if (!type) continue;
        if (url.searchParams.get('season') !== null || url.searchParams.get('episode') !== null) {
          return null;
        }
        const label = button.getAttribute('aria-label') || '';
        const match = label.match(/^Pop up menu for "(.*)"$/);
        return { type, slug: segments[1], title: match ? match[1] : segments[1], at: Date.now() };
      }
      return null;
    }

    // Per-open lifecycle: every three-dot click tears down previously
    // injected entries and this feature's height override before the new
    // menu renders; the SPA can reuse one popup container across opens for
    // different cards, so an inject-once marker would go stale. Capture
    // phase, same as the truncate feature's kebab listener, so the record
    // exists before the app's own handlers run.
    document.addEventListener('click', e => {
      if (!(e.target instanceof Element)) return;
      const button = e.target.closest('button.trakt-popup-menu-button');
      if (!button) return;
      teardownPopupEntries();
      pendingContext = cardContext(button);
    }, true);

    function teardownPopupEntries() {
      for (const entry of document.querySelectorAll(`.trakt-popup-menu-container [${ENTRY_ATTR}]`)) {
        entry.remove();
      }
      for (const menu of document.querySelectorAll(`.trakt-popup-menu-container [${HEIGHT_ATTR}]`)) {
        const prev = menu.getAttribute(HEIGHT_ATTR);
        menu.removeAttribute(HEIGHT_ATTR);
        if (prev) {
          menu.style.setProperty('max-height', prev);
        } else {
          menu.style.removeProperty('max-height');
        }
      }
    }

    // The popup container caps the menu height at its native rows, so the
    // injected entries would otherwise clip or scroll. The truncate
    // feature's growMenu is private to its IIFE and never arms on item
    // cards, so this feature owns its own override, recording the prior
    // inline value for the teardown restore.
    function growPopupMenu(menu) {
      if (menu.scrollHeight > menu.clientHeight) {
        if (!menu.hasAttribute(HEIGHT_ATTR)) {
          menu.setAttribute(HEIGHT_ATTR, menu.style.getPropertyValue('max-height'));
        }
        menu.style.setProperty('max-height', menu.scrollHeight + 'px', 'important');
      }
    }

    function buildEntries(menu, context, mode) {
      const state = quickLists.membershipState();
      if (state !== 'fresh') {
        // Menu-open heal: cold caches and app-driven staleness refetch
        // without a /discover visit. Stale data still renders entries
        // below; absent data cannot.
        quickLists.refreshMembership();
      }
      if (state === 'absent') {
        if (!warnedNoData) {
          warn('Quick list toggles: no membership data yet; entries appear once the sweep lands');
          warnedNoData = true;
        }
        return;
      }
      const rows = [...menu.querySelectorAll('li')].filter(li => !li.hasAttribute(ENTRY_ATTR));
      if (rows.length === 0) return;
      const template = rows[0];
      // Placement: directly after the native Watchlist row when present
      // (Watchlist is the app's own one-click membership toggle, so the
      // injected toggles group with it), else first. The summary menu has
      // no Watchlist row, so entries lead.
      const anchor = mode === 'popup'
        ? rows.find(li => /^Watchlist\b/.test(li.textContent.trim())) || null
        : null;
      const slugKey = slugKeyOf(context.type, context.slug);
      let insertAfter = anchor;
      for (const name of QUICK_LIST_NAMES) {
        const target = quickLists.getListTarget(name);
        if (!target) {
          if (!warnedTargets.has(name)) {
            warn(`Quick list toggles: list "${name}" missing or ambiguous; entry skipped`);
            warnedTargets.add(name);
          }
          continue;
        }
        const entry = buildEntry(template, name, context, target.has(slugKey));
        if (!entry) {
          if (!warnedTargets.has('markup')) {
            warn('Quick list toggles: menu row markup changed; entries skipped');
            warnedTargets.add('markup');
          }
          continue;
        }
        if (insertAfter) {
          insertAfter.after(entry);
        } else {
          menu.prepend(entry);
        }
        insertAfter = entry;
      }
      if (mode === 'popup') growPopupMenu(menu);
    }

    // Clones carry native styling and no Svelte listeners (same technique
    // as the fade feature's cloned filter section). Row contract (verified
    // in the live app this session): a menu row li contains an svg icon
    // and a p label. Fails closed on drift: a row whose label or icon
    // cannot be located must not ship, or it would keep the template's own
    // label and icon while writing to a different list.
    function buildEntry(template, name, context, member) {
      const entry = template.cloneNode(true);
      const label = entry.querySelector('p');
      if (!label || !entry.querySelector('svg')) return null;
      entry.setAttribute(ENTRY_ATTR, '1');
      entry.setAttribute('data-qlt-list', name);
      entry.setAttribute('data-qlt-type', context.type);
      entry.setAttribute('data-qlt-slug', context.slug);
      entry.setAttribute('data-qlt-title', context.title);
      label.textContent = name;
      applyEntryState(entry, member);
      entry.style.cursor = 'pointer';
      entry.addEventListener('click', onEntryClick);
      return entry;
    }

    // Icon and captured action state always move together: the click acts
    // on data-qlt-member, the same state the icon renders, so a sweep
    // committing mid-open can never flip the click behind the icon.
    // Idempotent by design: the shared body observer watches childList,
    // and a DOM icon swap mutates children even when the markup is
    // byte-identical, so an unguarded per-scan rewrite would requeue the
    // scan it ran in and loop every frame. Skip when the entry already
    // shows the target state. Only the svg node itself is swapped (the
    // truncate feature's buildRow precedent): rewriting a parent's
    // innerHTML would erase the label that shares the container. The
    // replacement inherits the native svg's width/height so injected
    // icons match their row neighbors.
    function applyEntryState(entry, member) {
      const next = member ? '1' : '0';
      if (entry.getAttribute('data-qlt-member') === next) return;
      entry.setAttribute('data-qlt-member', next);
      const icons = ICONS[entry.getAttribute('data-qlt-list')];
      const svg = entry.querySelector('svg');
      if (!icons || !svg) return;
      svg.insertAdjacentHTML('afterend', icons[member ? 'filled' : 'outline']);
      const replacement = svg.nextElementSibling;
      if (replacement) {
        for (const attr of ['width', 'height']) {
          if (svg.hasAttribute(attr)) replacement.setAttribute(attr, svg.getAttribute(attr));
        }
      }
      svg.remove();
    }

    function refreshEntryStates(root) {
      for (const entry of root.querySelectorAll(`[${ENTRY_ATTR}]`)) {
        const target = quickLists.getListTarget(entry.getAttribute('data-qlt-list'));
        if (!target) continue;
        const slugKey = slugKeyOf(entry.getAttribute('data-qlt-type'), entry.getAttribute('data-qlt-slug'));
        applyEntryState(entry, target.has(slugKey));
      }
      // Long-lived entries (the inline summary menu especially) are the
      // one surface where an app-driven or cross-tab membership change
      // must heal without a rebuild: the staleness-gated refresh is a
      // no-op when data is fresh.
      quickLists.refreshMembership();
    }

    function onEntryClick(e) {
      e.preventDefault();
      e.stopPropagation();
      const entry = e.currentTarget;
      performToggle({
        name: entry.getAttribute('data-qlt-list'),
        type: entry.getAttribute('data-qlt-type'),
        slug: entry.getAttribute('data-qlt-slug'),
        title: entry.getAttribute('data-qlt-title'),
        add: entry.getAttribute('data-qlt-member') !== '1',
      });
      closeMenus();
    }

    // The card popup dismisses itself on any trusted click, including one
    // on an injected row, so it needs no help (synthetic events are
    // ignored by its dismissal handlers, verified live). The inline
    // summary menu does NOT close on row clicks; its underlay element
    // accepts synthetic clicks, so dismiss through the app's own
    // dismissal surface.
    function closeMenus() {
      const underlay = document.querySelector('.trakt-summary-actions-underlay');
      if (underlay) {
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          underlay.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
      }
    }

    async function performToggle({ name, type, slug, title, add }) {
      const target = quickLists.getListTarget(name);
      if (!target) {
        // A target can de-resolve between render and click (list deleted
        // or renamed, sweep committed in between); a silent no-op would
        // read as success since the menu closes either way.
        warn(`Quick list toggle: list "${name}" no longer resolved; nothing written`);
        showToast(`Couldn't update ${name}: list not found`);
        return;
      }
      const slugKey = slugKeyOf(type, slug);
      const flightKey = `${target.id}:${slugKey}`;
      // Per list+item guard: without it, rapid toggle races can leave the
      // server holding the opposite of the last click.
      if (inFlight.has(flightKey)) return;
      inFlight.add(flightKey);
      let ok = false;
      try {
        quickLists.applyListToggle(name, slugKey, add);
        try {
          ok = await postToggle(target.id, type, slug, add);
        } catch (e) {
          warn(`Quick list ${add ? 'add' : 'remove'} failed for ${slugKey}`, e);
        }
      } finally {
        // A leaked flight key would make the item untoggleable for the
        // rest of the session.
        inFlight.delete(flightKey);
      }
      // Every settled outcome notifies and reconciles: other mutation
      // consumers (list counts) must hear about the write, an indeterminate
      // failure may have landed server-side, and the forced sweep is what
      // replaces the optimistic state with server truth on any page.
      notifyMutation();
      quickLists.bumpInvalidationMarker();
      // Only body-judged success enters the ledger (the block around it
      // runs on every settled outcome); after the bump, so the entry's
      // marker snapshot includes this write's own bump.
      if (ok) {
        quickLists.noteConfirmedWrite(name, slugKey, add);
      }
      quickLists.refreshMembership({ writeTriggered: true });
      if (!ok) {
        quickLists.applyListToggle(name, slugKey, !add);
        showToast(`Couldn't ${add ? 'add' : 'remove'} ${title ? `"${title}"` : 'item'} ${add ? 'to' : 'from'} ${name}`);
      }
    }

    // Success is judged by the response body, not status alone (the
    // truncate feature's precedent): these endpoints return 2xx with the
    // rejected item under not_found. Add requires the item to have landed
    // (added + existing >= 1). Remove succeeds on any 2xx: deleted 0 with
    // the item in not_found means it was not in the list, which is exactly
    // the end state the user asked for. A token missing at click time is a
    // transport failure with no request sent. Every failure path logs its
    // details; the toast carries only the headline.
    async function postToggle(listId, type, slug, add) {
      const auth = readAuth();
      if (!auth) {
        warn('Quick list toggle: no Trakt access token at write time; nothing sent');
        return false;
      }
      const bodyKey = mediaPathSegment(type);
      const url = apiUrl(`/users/me/lists/${listId}/items${add ? '' : '/remove'}`);
      const response = await apiPost(auth, url, { [bodyKey]: [{ ids: { slug } }] });
      if (!response.ok) {
        warn(`Quick list ${add ? 'add' : 'remove'} got HTTP ${response.status} for ${type}:${slug}`);
        return false;
      }
      if (!add) return true;
      const body = await response.json();
      const added = (body.added && body.added[bodyKey]) || 0;
      const existing = (body.existing && body.existing[bodyKey]) || 0;
      if (added + existing < 1) {
        warn(`Quick list add rejected for ${type}:${slug}; response:`, body);
        return false;
      }
      return true;
    }

    // One toast element; a new failure replaces the message and restarts
    // the dismiss timer. Failures are rare enough that stacking is not
    // worth building.
    function showToast(message) {
      let toast = document.getElementById(TOAST_ID);
      if (!toast) {
        toast = document.createElement('div');
        toast.id = TOAST_ID;
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);'
          + 'z-index:99999;padding:10px 18px;border-radius:8px;font-size:14px;'
          + 'background:#222;color:#fff;box-shadow:0 2px 12px rgba(0,0,0,0.4);';
        document.body.appendChild(toast);
      }
      const light = document.documentElement.classList.contains('tff-light');
      toast.style.background = light ? '#fff' : '#222';
      toast.style.color = light ? '#111' : '#fff';
      toast.textContent = message;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.remove(), TOAST_DISMISS_MS);
    }

    function renderPopup() {
      const container = document.querySelector('.trakt-popup-menu-container');
      if (!container) return;
      if (container.querySelector(`[${ENTRY_ATTR}]`)) {
        refreshEntryStates(container);
        return;
      }
      if (!pendingContext || Date.now() - pendingContext.at > CONTEXT_FRESH_MS) return;
      const menu = container.querySelector('ul');
      if (!menu) return;
      buildEntries(menu, pendingContext, 'popup');
    }

    // Summary-page identity comes from the pathname (bare two-segment
    // /movies/<slug> or /shows/<slug>; detail URLs keep season selection in
    // the query string, and episode pages have deeper paths). The title
    // for user-facing text is the page heading, slug as fallback.
    function summaryContext() {
      const segments = location.pathname.split('/').filter(Boolean);
      const type = segments.length === 2 ? mediaType(segments[0]) : null;
      if (!type) return null;
      const heading = document.querySelector('.trakt-summary-title h1');
      const title = heading && heading.textContent.trim() ? heading.textContent.trim() : segments[1];
      return { type, slug: segments[1], title, at: Date.now() };
    }

    // The inline actions menu (div.trakt-summary-actions holding li rows
    // as DIRECT children; an outer wrapper shares the class and is an
    // ANCESTOR of the menu, so a descendant-scoped li lookup would match
    // the wrapper too and double-inject) grows naturally in its slider,
    // so no height override applies here. SPA navigation can swap detail
    // pages without rebuilding the menu DOM, so entries record their
    // identity and are rebuilt whenever it no longer matches.
    function renderSummary() {
      const context = summaryContext();
      for (const menu of document.querySelectorAll('div.trakt-summary-actions')) {
        if (!menu.querySelector(':scope > li')) continue;
        const existing = [...menu.querySelectorAll(`[${ENTRY_ATTR}]`)];
        if (!context) {
          existing.forEach(entry => entry.remove());
          continue;
        }
        if (existing.length > 0
          && (existing[0].getAttribute('data-qlt-slug') !== context.slug
            || existing[0].getAttribute('data-qlt-type') !== context.type)) {
          existing.forEach(entry => entry.remove());
        }
        if (menu.querySelector(`[${ENTRY_ATTR}]`)) {
          refreshEntryStates(menu);
        } else {
          buildEntries(menu, context, 'summary');
        }
      }
    }

    scanCallbacks.push(() => {
      renderPopup();
      renderSummary();
    });
  })();

  // ---------------------------------------------------------------------
  // Feature: classic rating labels
  // Restores the old ten-point rating scale in the rating hover preview:
  // the app's half-star values (0.5-5.0) become "7 - Good" style labels
  // (1 Weak Sauce ... 10 Totally Ninja). "No rating" passes through.
  // ---------------------------------------------------------------------

  (function initRatingLabels() {
    const PREVIEW_SELECTOR = '.trakt-rating-stars .rating-preview';
    const STAR_VALUE_PATTERN = /^[0-5](\.[05])?$/;
    const LABELS = ['Weak Sauce', 'Terrible', 'Bad', 'Poor', 'Meh', 'Fair', 'Good', 'Great', 'Superb', 'Totally Ninja'];

    // The shared body observer sees only childList changes, but the hover
    // preview updates are pure text mutations, so each preview span gets its
    // own observer. Svelte re-renders strip marker attributes from
    // app-managed nodes; the WeakSet tracks instrumented spans instead, and
    // a span destroyed by a re-render takes its observer with it.
    const instrumented = new WeakSet();

    // Half-stars times two is the classic ten-scale. Text outside the
    // numeric pattern ("No rating", already-rewritten labels) passes
    // through untouched, which also terminates the observer's own rewrite
    // mutation without a reentrancy flag. The rewrite mutates the existing
    // text node's data rather than replacing it (setting textContent
    // detaches the node Svelte holds a reference to, freezing the preview:
    // its later writes would land on the detached node, invisibly).
    function rewrite(span) {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const text = node.data.trim();
      if (!STAR_VALUE_PATTERN.test(text)) return;
      const ten = Math.round(parseFloat(text) * 2);
      if (ten < 1) return;
      node.data = ten + ' - ' + LABELS[ten - 1];
    }

    function scan() {
      for (const span of document.querySelectorAll(PREVIEW_SELECTOR)) {
        if (instrumented.has(span)) continue;
        instrumented.add(span);
        new MutationObserver(() => rewrite(span)).observe(span, { childList: true, characterData: true, subtree: true });
        rewrite(span);
      }
    }

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: swimlane scrollbar fixes
  // Hides the phantom horizontal scrollbar on exactly-full lanes (card widths
  // derive from 100dvw, which includes the classic Windows scrollbar width)
  // and reserves a bottom gutter on truly scrollable lanes so the horizontal
  // scrollbar no longer covers lane content.
  // ---------------------------------------------------------------------

  (function initLaneScrollbars() {
    // The SPA's re-renders strip unknown attributes from lane nodes (observed
    // live) but leave inline styles alone, so fixes are identified by their own
    // inline !important styles rather than by marker attributes. The app never
    // uses !important on inline overflow styles, so the priority is a reliable
    // signature. Reading el.style parses only the style attribute: no layout.
    function isVFixed(el) {
      return el.style.getPropertyPriority('overflow-y') === 'important';
    }

    function isXFixed(el) {
      return el.style.getPropertyPriority('overflow-x') === 'important';
    }

    function fixedEls(isFixed) {
      return [...document.querySelectorAll('[style]')].filter(isFixed);
    }

    // Width of the page's classic vertical scrollbar (0 with overlay scrollbars
    // or when the page does not scroll).
    function pageScrollbarWidth() {
      return window.innerWidth - document.documentElement.clientWidth;
    }

    function isHorizontalScroller(el, cs) {
      const ox = cs.overflowX;
      return (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    }

    // Height of the rendered horizontal scrollbar (0 with overlay scrollbars).
    function hScrollbarHeight(el, cs) {
      return el.offsetHeight - el.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    }

    // Trakt sizes lane cards with CSS formulas based on 100dvw, which includes
    // the page's classic vertical scrollbar width, so an exactly-full lane
    // overflows horizontally by a few px (scrollbar width minus the formula's
    // one-gap slack) with no real content to scroll into view. The signature:
    // horizontal overflow no larger than the page scrollbar width. (+1 for px
    // rounding) Assumes the caller's isHorizontalScroller gate supplies the
    // lower bound; unguarded, zero overflow would classify as phantom.
    function isPhantomOverflow(el, sbW) {
      return sbW > 0 && el.scrollWidth - el.clientWidth <= sbW + 1;
    }

    // Measurements for an artifact lane, or null if el is not one. The
    // artifact's signature: the horizontal scrollbar consumes part of the
    // lane's height, so vertical overflow is at most the scrollbar's own
    // height. Real content overflow always exceeds it. (+1 for px rounding)
    function measureArtifactLane(el, cs) {
      const oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return null;

      const sbH = hScrollbarHeight(el, cs);
      if (sbH <= 0) return null;

      const vOverflow = el.scrollHeight - el.clientHeight;
      if (!(vOverflow > 0 && vOverflow <= sbH + 1)) return null;

      return {
        el,
        gutterPx: parseFloat(cs.paddingBottom) + sbH,
        expectedClientH: el.clientHeight + sbH - 2,
      };
    }

    // A fixed element that has since gained REAL overflow (or whose node was
    // reused for a different component) and needs scrollability back. The +4
    // hysteresis margin keeps px rounding jitter from flapping fix/unfix.
    function isStaleVFix(el) {
      const vOverflow = el.scrollHeight - el.clientHeight;
      return vOverflow > hScrollbarHeight(el, getComputedStyle(el)) + 4;
    }

    function isStaleXFix(el, sbW) {
      return el.scrollWidth - el.clientWidth > sbW + 4;
    }

    // Hide the phantom vertical scrollbar and reserve a bottom gutter equal to
    // the horizontal scrollbar's height, so the scrollbar rides in the gutter
    // instead of covering the lane's bottom row of content.
    function fixV({ el, gutterPx }) {
      el.style.setProperty('overflow-y', 'hidden', 'important');
      el.style.setProperty('padding-bottom', gutterPx + 'px', 'important');
    }

    function unfixV(el) {
      el.style.removeProperty('overflow-y');
      el.style.removeProperty('padding-bottom');
    }

    // Hide the phantom horizontal scrollbar outright. With no horizontal
    // scrollbar consuming lane height, the vertical artifact disappears too,
    // so any vertical fix (and its gutter) on the same node is dropped.
    function fixX(el) {
      unfixV(el);
      el.style.setProperty('overflow-x', 'hidden', 'important');
    }

    function unfixX(el) {
      el.style.removeProperty('overflow-x');
    }

    function staleVFixes() {
      return fixedEls(isVFixed).filter(isStaleVFix);
    }

    function staleXFixes(sbW) {
      return fixedEls(isXFixed).filter((el) => isStaleXFix(el, sbW));
    }

    // Two-phase scan: all layout reads happen before any style writes, so a
    // scan costs one reflow instead of one per fixed lane. The tag list limits
    // candidates to element types that can host swimlanes; the cheap overflow
    // style checks filter out the rest before any layout reads. Phantom
    // detection supersedes the artifact-lane fix: a phantom lane also shows the
    // vertical artifact, but hiding its horizontal scrollbar cures both.
    function scan() {
      const sbW = pageScrollbarWidth();
      const staleV = staleVFixes();
      const staleX = staleXFixes(sbW);
      const phantoms = [];
      const lanes = [];
      for (const el of document.querySelectorAll('div, ul, section, main')) {
        if (isXFixed(el)) continue;
        const cs = getComputedStyle(el);
        if (!isHorizontalScroller(el, cs)) continue;
        if (isPhantomOverflow(el, sbW)) {
          phantoms.push(el);
          continue;
        }
        if (isVFixed(el)) continue;
        const lane = measureArtifactLane(el, cs);
        if (lane) lanes.push(lane);
      }
      staleV.forEach(unfixV);
      staleX.forEach(unfixX);
      phantoms.forEach(fixX);
      lanes.forEach(fixV);
      // The gutter cannot work on a border-box element with a fixed height,
      // where padding shrinks the content area instead of growing the box and
      // would flap the un-fix guard; verify it took effect and drop it if not
      // (the scrollbar stays hidden either way).
      lanes.forEach(({ el, expectedClientH }) => {
        if (el.clientHeight < expectedClientH) {
          el.style.removeProperty('padding-bottom');
        }
      });
      // An X-unfix re-exposes the horizontal scrollbar and with it the vertical
      // artifact, but the read phase already skipped the element as X-fixed and
      // style writes fire no observed mutation, so follow up with another scan
      // to apply the fix the lane now needs. (A V-unfix restores the natural
      // state and needs none.)
      if (staleX.length > 0) {
        queueScan();
      }
    }

    // Layout changes (window resize, zoom) can re-introduce the artifact
    // on elements not yet fixed.
    window.addEventListener('resize', queueScan, { passive: true });

    // Backstop for layout changes that fire no observed event (unlikely, but
    // cheap insurance). An X-unfix needs a follow-up scan, same as in scan().
    setInterval(() => {
      staleVFixes().forEach(unfixV);
      const staleX = staleXFixes(pageScrollbarWidth());
      staleX.forEach(unfixX);
      if (staleX.length > 0) {
        queueScan();
      }
    }, 5000);

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: popup menu scroll shield
  // Keeps the card/list kebab popup and the summary actions menu open
  // while the page scrolls: while either menu is rendered and at least
  // partially in the viewport, wheel and scroll events are swallowed at
  // window capture before the app's closing listeners hear them (native
  // scrolling is a default action and proceeds untouched). Once the menu
  // is fully offscreen, events pass through and the app closes its own
  // menu.
  // ---------------------------------------------------------------------

  (function initPopupScrollShield() {
    // Rendered-menu guard: the SPA can reuse one popup container across
    // opens, so container presence alone is not proof of an open menu,
    // and the container is a zero-height positioning anchor on some
    // surfaces (observed live on list-page kebab popups), so its own
    // rect cannot distinguish open from closed either. The inner ul
    // carries the menu's real geometry everywhere: no ul, or a
    // collapsed ul rect, means no rendered menu, and arming anyway
    // would swallow every event for the session (a zero rect at 0,0
    // matches none of the offscreen tests).
    function popupMenuRect() {
      const container = document.querySelector('.trakt-popup-menu-container');
      if (!container) return null;
      const menu = container.querySelector('ul');
      return menu ? menu.getBoundingClientRect() : null;
    }

    // The summary actions menu closes on document scrolls too (observed
    // live on the episode side panel, where the app's boot scroll
    // listener hears main-page scrolls; panel-internal scrolls never
    // reach it because scroll events do not bubble). Its class is shared
    // by a permanently-rendered wrapper with a nonzero rect and no
    // direct li rows, so keying on class presence alone would arm the
    // shield forever on detail pages; the li-bearing menu element and
    // the dismissal underlay both exist only while the menu is open
    // (verified live 2026-08-03), and requiring both fails toward
    // native app behavior.
    function summaryMenuRect() {
      if (!document.querySelector('.trakt-summary-actions-underlay')) return null;
      for (const menu of document.querySelectorAll('div.trakt-summary-actions')) {
        if (!menu.querySelector(':scope > li')) continue;
        return menu.getBoundingClientRect();
      }
      return null;
    }

    // Fully offscreen counts as not shielded: events pass through so the
    // app's own listeners close the menu; the app stays the sole closing
    // authority.
    function partlyOnscreen(rect) {
      if (!rect || rect.width === 0 || rect.height === 0) return false;
      return !(rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth);
    }

    function shield(e) {
      if (partlyOnscreen(popupMenuRect()) || partlyOnscreen(summaryMenuRect())) {
        e.stopImmediatePropagation();
      }
    }

    window.addEventListener('wheel', shield, { capture: true, passive: true });
    window.addEventListener('scroll', shield, { capture: true, passive: true });
  })();

  // Initial pass + re-run as the SPA renders; class toggles and inline style
  // writes are attribute mutations, so feature scans never retrigger this
  // childList observer.
  queueScan();
  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
})();
