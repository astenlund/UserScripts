// ==UserScript==
// @name         Trakt Web: fade filters
// @namespace    fork-scripts
// @version      1.9
// @description  Restores fade/dim filtering in the new Trakt Web design: adds a Fade section to the filter pane and fades watched/started/watchlisted/listed posters, with hover-to-reveal.
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_fade_filters.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/trakt_fade_filters.user.js
// @match        https://app.trakt.tv/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STATE_KEY = 'trakt-fade-filters';
  const CACHE_KEY = 'trakt-fade-cache';
  const CACHE_VERSION = 2;
  const MARKER_SNAPSHOT_KEY = 'trakt-fade-markers';
  const MARKER_PREFIX = 'trakt-marker:invalidate:';
  const MODE_KEY = 'trakt_toggler_discover';
  const OIDC_KEY_PREFIX = 'oidc.user:https://auth.trakt.tv:';
  const API_BASE = 'https://apiz.trakt.tv';
  const CACHE_TTL_MS = 15 * 60 * 1000;
  const RETRY_BACKOFF_MS = 60 * 1000;
  const FETCH_TIMEOUT_MS = 30 * 1000;
  const PAGE_LIMIT = 1000;
  const FADE_CLASS = 'tff-fade';
  const HIDE_CLASS = 'tff-hide';
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

  function warn(...args) {
    console.warn('[trakt-fade-filters]', ...args);
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

  function readAuth() {
    const key = Object.keys(localStorage).find(k => k.startsWith(OIDC_KEY_PREFIX));
    if (!key) return null;
    const entry = readJson(key);
    const token = entry && typeof entry === 'object' ? entry.access_token : null;
    if (!token) return null;
    return { token, clientId: key.slice(key.lastIndexOf(':') + 1) };
  }

  // A fetch succeeds only on HTTP 2xx with a JSON array body; anything else
  // (network error, timeout, 401/429/5xx, interstitial HTML) throws and feeds
  // the category's stale-fallback path. fetch() resolves on HTTP errors, so
  // response.ok is checked explicitly; a 401 is how an expired token shows up.
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

  async function fetchPage(auth, path, page) {
    const url = new URL(API_BASE + path);
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
    const url = new URL(API_BASE + '/users/me/watched/shows');
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

  // Single-flight, atomic per category: a category's record is replaced only
  // when every fetch it depends on succeeded; otherwise it keeps its stale
  // record wholesale and the backoff gates the next attempt.
  async function refresh() {
    if (refreshInFlight || Date.now() - lastFailureAt < RETRY_BACKOFF_MS) return;
    const auth = readAuth();
    if (!auth) {
      warn('No Trakt access token in localStorage; fading stays on cached/empty data until login');
      lastFailureAt = Date.now();
      return;
    }
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
      .${FADE_CLASS} .trakt-card-cover,
      .${FADE_CLASS} .trakt-summary-card-background img {
        opacity: 0.35 !important;
        filter: brightness(0.35) saturate(0.35) !important;
      }
      .${FADE_CLASS} .trakt-card-footer,
      .${FADE_CLASS} .trakt-summary-card-details,
      .${FADE_CLASS} .trakt-summary-card-bottom-bar,
      .${FADE_CLASS} .trakt-card-action-bar {
        filter: brightness(0.35) !important;
      }
      .${FADE_CLASS}:hover .trakt-card-cover,
      .${FADE_CLASS}:hover .trakt-summary-card-background img {
        opacity: 1 !important;
        filter: none !important;
      }
      .${FADE_CLASS}:hover .trakt-card-footer,
      .${FADE_CLASS}:hover .trakt-summary-card-details,
      .${FADE_CLASS}:hover .trakt-summary-card-bottom-bar,
      .${FADE_CLASS}:hover .trakt-card-action-bar {
        filter: none !important;
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
      if (segments.length >= 2 && (segments[0] === 'shows' || segments[0] === 'movies')) {
        return {
          slug: (segments[0] === 'shows' ? 'show:' : 'movie:') + segments[1],
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
    if (cacheStale() || markersChanged()) {
      refresh().catch(e => {
        warn('Refresh failed unexpectedly', e);
        lastFailureAt = Date.now();
      });
    }
  }

  // rAF batches scans to one per frame, but rAF never fires in a hidden tab;
  // fall back to a macrotask there so fades are in place before the tab is
  // ever shown (background-tab loads would otherwise pop in on first view).
  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const run = () => {
      scanQueued = false;
      scan();
    };
    if (document.visibilityState === 'hidden') {
      setTimeout(run, 0);
    } else {
      requestAnimationFrame(run);
    }
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

  // Initial pass + re-run as the SPA renders; class toggles are attribute
  // mutations, so applyFades never retriggers this childList observer.
  queueScan();
  new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
})();
