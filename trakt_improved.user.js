// ==UserScript==
// @name         Trakt Improved
// @namespace    fork-scripts
// @version      1.11
// @description  All-in-one enhancements for the new Trakt Web: fade/hide filters for tracked items, deterministic Rotten Tomatoes and Letterboxd links, restored list item counts, and swimlane scrollbar fixes.
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_improved.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/trakt_improved.user.js
// @match        https://app.trakt.tv/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      www.wikidata.org
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
  async function apiGet(auth, url) {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${auth.token}`,
        'trakt-api-version': '2',
        'trakt-api-key': auth.clientId,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.pathname}`);
    return response;
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

  // ---------------------------------------------------------------------
  // Feature: fade filters
  // Restores fade/dim filtering: adds a Fade section to the filter pane and
  // fades watched/started/watchlisted/listed posters, with hover-to-reveal.
  // Supersedes the app's own watched-item fade (is-deemphasized), which is
  // neutralized so the two treatments never stack.
  // ---------------------------------------------------------------------

  (function initFadeFilters() {
    const STATE_KEY = 'trakt-fade-filters';
    const CACHE_KEY = 'trakt-fade-cache';
    const CACHE_VERSION = 2;
    const MARKER_SNAPSHOT_KEY = 'trakt-fade-markers';
    const MARKER_PREFIX = 'trakt-marker:invalidate:';
    const MODE_KEY = 'trakt_toggler_discover';
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const PAGE_LIMIT = 1000;
    const FADE_CLASS = 'tff-fade';
    const HIDE_CLASS = 'tff-hide';
    const LIGHT_CLASS = 'tff-light';
    const STYLE_ID = 'tff-style';
    const SECTION_ATTR = 'data-tff-section';
    const ROW_ATTR = 'data-tff-row';
    const HIDE_ROW_ATTR = 'data-tff-hide-row';
    const CATEGORIES = ['started', 'watched', 'watchlisted', 'listed'];
    const LABELS = { started: 'Started', watched: 'Watched', watchlisted: 'Watchlisted', listed: 'Listed' };
    // Hide rows injected into the NATIVE Display section for parity: the app
    // already hides Watched/Watchlisted server-side; these hide Started/Listed
    // client-side.
    const HIDE_CATEGORIES = [
      { stateKey: 'hideStarted', category: 'started', label: 'Started' },
      { stateKey: 'hideListed', category: 'listed', label: 'Listed' },
    ];
    const SAVE_BUTTON_SELECTOR = 'button[aria-label="Set filters as default"]';

    const state = { watched: true, started: true, watchlisted: true, listed: true, hideStarted: false, hideListed: false };
    const storedState = readJson(STATE_KEY);
    if (storedState && typeof storedState === 'object') {
      for (const key of Object.keys(state)) {
        if (typeof storedState[key] === 'boolean') state[key] = storedState[key];
      }
    }

    // Cache record per category: { slugs: [...], fetchedAt: <epoch ms> }, under
    // a top-level version stamp so a format change forces a refetch instead of
    // serving entries the new matching logic misreads.
    function normalizeCache(raw) {
      const versionOk = raw && typeof raw === 'object' && raw.v === CACHE_VERSION;
      const cache = {};
      for (const cat of CATEGORIES) {
        const rec = versionOk ? raw[cat] : null;
        cache[cat] = rec && Array.isArray(rec.slugs) && typeof rec.fetchedAt === 'number' ? rec : null;
      }
      return cache;
    }

    function buildSets(cache) {
      const sets = {};
      for (const cat of CATEGORIES) {
        sets[cat] = new Set(cache[cat] ? cache[cat].slugs : []);
      }
      return sets;
    }

    const cache = normalizeCache(readJson(CACHE_KEY));
    let sets = buildSets(cache);

    // Marker snapshot: captured at refresh start, committed when the refresh
    // commits, so an app action landing mid-refresh still triggers a follow-up.
    function currentMarkers() {
      const markers = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(MARKER_PREFIX)) markers[key] = localStorage.getItem(key);
      }
      return markers;
    }

    let committedMarkers = readJson(MARKER_SNAPSHOT_KEY);

    function markersChanged() {
      if (!committedMarkers || typeof committedMarkers !== 'object') return true;
      const current = currentMarkers();
      const keys = new Set([...Object.keys(current), ...Object.keys(committedMarkers)]);
      return [...keys].some(key => current[key] !== committedMarkers[key]);
    }

    async function fetchPage(auth, path, page) {
      const url = apiUrl(path);
      url.searchParams.set('page', page);
      url.searchParams.set('limit', PAGE_LIMIT);
      const response = await apiGet(auth, url);
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
      const items = [];
      for (let page = 1; ; page++) {
        const { batch, pageCount } = await fetchPage(auth, path, page);
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
      const response = await apiGet(auth, url);
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

    async function fetchListedItems(auth) {
      const lists = await fetchAll(auth, '/users/me/lists');
      const perList = await Promise.all(
        lists
          .filter(list => list.ids && list.ids.trakt !== undefined)
          .map(list => fetchAll(auth, `/users/me/lists/${list.ids.trakt}/items`)),
      );
      return perList.flat();
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

    function cacheStale() {
      const now = Date.now();
      return CATEGORIES.some(cat => !cache[cat] || now - cache[cat].fetchedAt > CACHE_TTL_MS);
    }

    let refreshInFlight = false;
    let lastFailureAt = 0;
    let forceRefresh = false;

    // A mutation-triggered refresh bypasses the failure backoff (see
    // refresh()): user actions are rare and deserve promptness. The shared
    // hook queues the scan that notices the flag; the marker mechanism stays
    // as backup and for actions performed in other tabs.
    mutationCallbacks.push(() => {
      forceRefresh = true;
    });

    // Single-flight, atomic per category: a category's record is replaced only
    // when every fetch it depends on succeeded; otherwise it keeps its stale
    // record wholesale and the backoff gates the next attempt.
    async function refresh() {
      if (refreshInFlight) return;
      // A mutation-triggered refresh bypasses the failure backoff: user actions
      // are rare and deserve promptness. Ordinary staleness still respects it.
      if (!forceRefresh && Date.now() - lastFailureAt < RETRY_BACKOFF_MS) return;
      const auth = readAuth();
      if (!auth) {
        warn('No Trakt access token in localStorage; fading stays on cached/empty data until login');
        lastFailureAt = Date.now();
        return;
      }
      forceRefresh = false;
      refreshInFlight = true;
      try {
        const captured = currentMarkers();
        const [shows, progress, movies, watchlist, listed] = await Promise.allSettled([
          fetchAll(auth, '/users/me/watched/shows?extended=full'),
          fetchWatchedProgress(auth),
          fetchAll(auth, '/users/me/watched/movies'),
          fetchAll(auth, '/users/me/watchlist'),
          fetchListedItems(auth),
        ]);
        const now = Date.now();
        let anyFailed = false;
        let changed = false;

        if (shows.status === 'fulfilled' && progress.status === 'fulfilled' && movies.status === 'fulfilled') {
          const split = splitWatchedShows(shows.value, progress.value);
          cache.watched = { slugs: [...split.watched, ...movieSlugs(movies.value)], fetchedAt: now };
          cache.started = { slugs: split.started, fetchedAt: now };
          changed = true;
        } else {
          anyFailed = true;
          warn('Watched/started refresh failed; keeping stale data', shows.reason || progress.reason || movies.reason);
        }

        if (watchlist.status === 'fulfilled') {
          cache.watchlisted = { slugs: watchlist.value.map(itemSlug).filter(Boolean), fetchedAt: now };
          changed = true;
        } else {
          anyFailed = true;
          warn('Watchlist refresh failed; keeping stale data', watchlist.reason);
        }

        if (listed.status === 'fulfilled') {
          cache.listed = { slugs: listed.value.map(itemSlug).filter(Boolean), fetchedAt: now };
          changed = true;
        } else {
          anyFailed = true;
          warn('List-membership refresh failed; keeping stale data', listed.reason);
        }

        if (changed) {
          writeJson(CACHE_KEY, Object.assign({ v: CACHE_VERSION }, cache));
          sets = buildSets(cache);
        }
        committedMarkers = captured;
        writeJson(MARKER_SNAPSHOT_KEY, captured);
        if (anyFailed) lastFailureAt = now;
        if (changed) queueScan();
      } finally {
        refreshInFlight = false;
      }
    }

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
        .${FADE_CLASS} .trakt-card-cover, .${FADE_CLASS} .trakt-card-footer,
        .${FADE_CLASS} .trakt-summary-card-details,
        .${FADE_CLASS} .trakt-summary-card-bottom-bar,
        .${FADE_CLASS} .trakt-card-action-bar,
        .${FADE_CLASS} .trakt-summary-card-background img {
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
          filter: saturate(0.75) !important;
        }
        .${FADE_CLASS} .trakt-card-footer,
        .${FADE_CLASS} .trakt-summary-card-details,
        .${FADE_CLASS} .trakt-summary-card-bottom-bar,
        .${FADE_CLASS} .trakt-card-action-bar {
          filter: brightness(0.35) !important;
        }
        /* Same theme split for the text/rating layer: brightness pushes
           toward black, which on a light card RAISES contrast (the rating
           star stayed vivid purple), so light washes by alpha instead,
           in lockstep with the art above. */
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-card-footer,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-summary-card-details,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-summary-card-bottom-bar,
        :where(:root.${LIGHT_CLASS}) .${FADE_CLASS} .trakt-card-action-bar {
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
          .${FADE_CLASS}:hover .trakt-card-action-bar {
            opacity: 1 !important;
            filter: none !important;
          }
        }
        .${HIDE_CLASS} {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }

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
      const templateRow = displaySection.querySelector(`div.trakt-filter:not([${HIDE_ROW_ATTR}])`);
      const section = displaySection.cloneNode(true);
      const title = section.querySelector('.display-title');
      const toggles = section.querySelector('.display-toggles');
      if (!templateRow || !title || !toggles) return null;
      section.setAttribute(SECTION_ATTR, '1');
      title.textContent = 'Fade';
      toggles.textContent = '';
      for (const cat of CATEGORIES) {
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

    function ensureFadeSection() {
      const displaySection = document.querySelector(`div.trakt-display-section:not([${SECTION_ATTR}])`);
      if (!displaySection) return;
      let section = displaySection.parentElement.querySelector(`[${SECTION_ATTR}]`);
      if (!section) {
        section = buildFadeSection(displaySection);
        if (!section) {
          warn('Filter pane markup changed; cannot inject Fade section');
          return;
        }
        displaySection.after(section);
      }
      const startedRow = section.querySelector(`[${ROW_ATTR}="started"]`);
      if (startedRow) startedRow.style.display = activeMode() === 'movie' ? 'none' : '';
    }

    // Started/Listed hide rows appended to the NATIVE Display section, styled
    // by the same cloned row markup as the Fade section's toggles.
    function ensureHideRows() {
      const displaySection = document.querySelector(`div.trakt-display-section:not([${SECTION_ATTR}])`);
      if (!displaySection) return;
      const toggles = displaySection.querySelector('.display-toggles');
      const templateRow = displaySection.querySelector(`div.trakt-filter:not([${HIDE_ROW_ATTR}])`);
      if (!toggles || !templateRow) return;
      for (const { stateKey, category, label } of HIDE_CATEGORIES) {
        let row = toggles.querySelector(`[${HIDE_ROW_ATTR}="${category}"]`);
        if (!row) {
          row = templateRow.cloneNode(true);
          const labelEl = row.querySelector('span.secondary');
          const input = row.querySelector('input[type=checkbox]');
          if (!labelEl || !input) {
            warn('Filter pane markup changed; cannot inject hide rows');
            return;
          }
          row.setAttribute(HIDE_ROW_ATTR, category);
          labelEl.textContent = label;
          input.setAttribute('aria-label', 'Hide ' + label.toLowerCase());
          input.checked = state[stateKey];
          input.addEventListener('change', () => {
            state[stateKey] = input.checked;
            queueScan();
          });
          toggles.appendChild(row);
        }
        if (category === 'started') row.style.display = activeMode() === 'movie' ? 'none' : '';
      }
    }

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

    // Episode cards never fade by show membership: lanes like Continue Watching
    // and Calendar surface unwatched episodes of started shows on purpose, so
    // dimming them would defeat those lanes. Season cards fade by the season's
    // own progress; show/movie cards by their slug.
    // Hide wins over fade; both use the same granularity rules (episode cards
    // exempt, season cards by season key).
    function applyFades() {
      const fadeCats = CATEGORIES.filter(cat => state[cat]);
      const hideCats = HIDE_CATEGORIES.filter(({ stateKey }) => state[stateKey]).map(({ category }) => category);
      for (const card of document.querySelectorAll('div.trakt-card')) {
        const target = cardTarget(card);
        let fade = false;
        let hide = false;
        if (target !== null && target.episode === null) {
          const key = target.season === null ? target.slug : `${target.slug}:s${target.season}`;
          hide = hideCats.some(cat => sets[cat].has(key));
          fade = !hide && fadeCats.some(cat => sets[cat].has(key));
        }
        card.classList.toggle(HIDE_CLASS, hide);
        card.classList.toggle(FADE_CLASS, fade);
      }
    }

    // Fading is scoped to the /discover pages: personal surfaces (home lanes
    // like Start Watching, watchlist, lists) consist of tracked items by
    // definition, so fading there would dim entire lanes. The @match stays
    // site-wide because the SPA navigates without reloading; outside /discover
    // the scan only clears stale fade classes on reused nodes and skips the
    // Fade section and API refreshes entirely.
    function fadingActive() {
      return location.pathname === '/discover' || location.pathname.startsWith('/discover/');
    }

    function scan() {
      if (!fadingActive()) {
        document.querySelectorAll(`.${FADE_CLASS}, .${HIDE_CLASS}`).forEach(el => el.classList.remove(FADE_CLASS, HIDE_CLASS));
        return;
      }
      injectStyles();
      ensureHideRows();
      ensureFadeSection();
      applyFades();
      if (forceRefresh || cacheStale() || markersChanged()) {
        refresh().catch(e => {
          warn('Refresh failed unexpectedly', e);
          lastFailureAt = Date.now();
        });
      }
    }

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

    scanCallbacks.push(scan);
  })();

  // ---------------------------------------------------------------------
  // Feature: external links
  // Replaces unreliable native Rotten Tomatoes links with deterministic
  // direct links (Wikidata bridges IMDb id to RT path) and adds a Letterboxd
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
    const CACHE_VERSION = 1;
    // The TTL also schedules retries for titles Wikidata has no RT path for
    // yet; id mappings drift rarely, so a month keeps lookups near zero.
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 500;
    const RT_PATH_PATTERN = /^(m|tv)\/[\w-]+$/;

    const ICONS = {
      rt: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24">'
        + '<circle cx="12" cy="13.5" r="8.5" fill="#fa320a"/>'
        + '<path d="M12 6c-.4-1.8-1.8-3.2-3.7-3.6 1 .8 1.6 1.8 1.8 3-1.4-1-3.2-1.3-4.8-.7 1.3.4 2.4 1.2 3.1 2.3 1.2-.7 2.4-1 3.6-1z" fill="#00912d"/>'
        + '</svg>',
      lb: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24">'
        + '<circle cx="6.5" cy="12" r="5.5" fill="#ff8000"/>'
        + '<circle cx="17.5" cy="12" r="5.5" fill="#40bcf4"/>'
        + '<circle cx="12" cy="12" r="5.5" fill="#00e054"/>'
        + '</svg>',
    };

    // Cache entry per "<type>:<slug>": { imdb, tmdb, rtPath, fetchedAt }, under
    // a version stamp so a format change forces a refetch.
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

    // Wikidata is not on the app's connect-src CSP whitelist, so those calls
    // go through GM_xmlhttpRequest (extension background, exempt from page
    // CSP). The jsonFetch fallback covers managers without the API; under
    // this app's CSP it will fail and degrade to title-search links.
    function gmFetchJson(url) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        return jsonFetch(url);
      }
      const hostname = new URL(url).hostname;
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: FETCH_TIMEOUT_MS,
          onload: r => {
            if (r.status < 200 || r.status >= 300) {
              reject(new Error(`HTTP ${r.status} from ${hostname}`));
              return;
            }
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(e);
            }
          },
          ontimeout: () => reject(new Error(`Timeout from ${hostname}`)),
          onerror: () => reject(new Error(`Network error from ${hostname}`)),
        });
      });
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
        cachePut(key, { imdb: ids.imdb, tmdb: ids.tmdb, rtPath, fetchedAt: Date.now() });
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

    // Native RT links are unreliable (sometimes missing, sometimes the wrong
    // title), so every one of them is repointed. Svelte re-renders restore the
    // original hrefs; the observer rescan puts ours back, and the equality
    // check keeps the pass idempotent.
    function rewriteRtAnchors(url) {
      for (const scope of document.querySelectorAll(REWRITE_SCOPES)) {
        for (const anchor of scope.querySelectorAll(RT_HREF_MATCH)) {
          if (!anchor.closest('.' + CHIP_CLASS) && anchor.href !== url) {
            anchor.href = url;
          }
        }
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
      if (anchor && anchor.href !== url) {
        anchor.href = url;
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
      // A rewritten native RT tile already shows the score and links right,
      // so the icon-only chip is only for pages missing RT entirely.
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

    // A list detail path is exactly /users/<owner>/lists/<slug>, query
    // string ignored. Returns null for anything else (lists index, smart
    // list views, non-list pages).
    function parseListPath(pathname) {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length !== 4 || segments[0] !== 'users' || segments[2] !== 'lists') {
        return null;
      }
      return { kind: 'list', ownerSegment: segments[1], slug: segments[3], key: canonicalKey(segments[1], segments[3]) };
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
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length !== 4 || segments[0] !== 'users' || segments[2] !== 'lists') {
        return false;
      }
      return (segments[1] === 'me' || segments[1] === TRUNCATE_OWNER) && segments[3] === TRUNCATE_SLUG;
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
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'trakt-api-version': '2',
          'trakt-api-key': auth.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
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

  // Initial pass + re-run as the SPA renders; class toggles and inline style
  // writes are attribute mutations, so feature scans never retrigger this
  // childList observer.
  queueScan();
  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
})();
