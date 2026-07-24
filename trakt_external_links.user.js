// ==UserScript==
// @name        External Links for Trakt.tv
// @namespace   fork-scripts
// @description Deterministic Rotten Tomatoes and Letterboxd links on Trakt Web, resolved via Trakt ids and Wikidata with title-search fallback
// @author      Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @updateURL   https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @match       https://app.trakt.tv/*
// @run-at      document-idle
// @noframes
// @grant       GM_xmlhttpRequest
// @connect     www.wikidata.org
// @version     1.1
// ==/UserScript==

(function () {
    'use strict';

    const CHIP_CLASS = 'tel-chip';
    const KIND_ATTR = 'data-tel-kind';
    const ROW_SELECTOR = '.trakt-summary-ratings';
    // Native Rotten Tomatoes links appear in the visible ratings row and in the
    // Ratings drawer (view=ratings); both get rewritten. Letterboxd links in the
    // drawer are direct and correct when present, so they are left alone.
    const REWRITE_SCOPES = '.trakt-summary-ratings, .trakt-ratings-drawer-content';
    const RT_HREF_MATCH = 'a[href*="rottentomatoes."]';
    const API_BASE = 'https://apiz.trakt.tv';
    const OIDC_KEY_PREFIX = 'oidc.user:https://auth.trakt.tv:';
    const CACHE_KEY = 'trakt-external-links-cache';
    const CACHE_VERSION = 1;
    // The TTL also schedules retries for titles Wikidata has no RT path for
    // yet; id mappings drift rarely, so a month keeps lookups near zero.
    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 500;
    const RETRY_BACKOFF_MS = 60 * 1000;
    const FETCH_TIMEOUT_MS = 15 * 1000;
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

    function warn(...args) {
        console.warn('[trakt-external-links]', ...args);
    }

    // All localStorage JSON goes through these guards: corrupt or unwritable
    // storage degrades to a console warning, never a thrown scan.
    function readJson(key) {
        const raw = localStorage.getItem(key);
        if (raw === null) {
            return null;
        }
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

    function readAuth() {
        const key = Object.keys(localStorage).find(k => k.startsWith(OIDC_KEY_PREFIX));
        if (!key) {
            return null;
        }
        const entry = readJson(key);
        const token = entry && typeof entry === 'object' ? entry.access_token : null;
        if (!token) {
            return null;
        }
        return { token, clientId: key.slice(key.lastIndexOf(':') + 1) };
    }

    async function jsonFetch(url, headers) {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
        }
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
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: FETCH_TIMEOUT_MS,
                onload: r => {
                    if (r.status < 200 || r.status >= 300) {
                        reject(new Error(`HTTP ${r.status} from ${new URL(url).hostname}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(r.responseText));
                    } catch (e) {
                        reject(e);
                    }
                },
                ontimeout: () => reject(new Error(`Timeout from ${new URL(url).hostname}`)),
                onerror: () => reject(new Error(`Network error from ${new URL(url).hostname}`)),
            });
        });
    }

    // The app's canonical ids for the title, riding along on its own OAuth
    // token; these beat scraping the page's IMDb tile, which shares provenance
    // with the unreliable native RT links.
    async function fetchTraktIds(auth, type, slug) {
        const body = await jsonFetch(`${API_BASE}/${type === 'movie' ? 'movies' : 'shows'}/${slug}`, {
            'Authorization': `Bearer ${auth.token}`,
            'trakt-api-version': '2',
            'trakt-api-key': auth.clientId,
        });
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
        const searchUrl = 'https://www.wikidata.org/w/api.php?action=query&format=json&origin=*&list=search&srnamespace=0&srsearch='
            + encodeURIComponent('haswbstatement:P345=' + imdbId);
        const qid = (await gmFetchJson(searchUrl)).query?.search?.[0]?.title;
        if (!qid) {
            return null;
        }
        const claimsUrl = 'https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&origin=*&property=P1258&entity='
            + encodeURIComponent(qid);
        const value = (await gmFetchJson(claimsUrl)).claims?.P1258?.[0]?.mainsnak?.datavalue?.value;
        return typeof value === 'string' && RT_PATH_PATTERN.test(value) ? value : null;
    }

    const inFlight = new Set();
    const failedAt = {};
    let authWarned = false;

    // Fire-and-forget resolution: scan renders search links immediately and a
    // completed resolution queues a rescan that upgrades them to direct links.
    // A missing Wikidata RT path is cached as null (the search fallback covers
    // it; the TTL retries eventually); transient failures are not cached and
    // retry after a short backoff.
    function resolveIds(type, slug) {
        const key = `${type}:${slug}`;
        if (inFlight.has(key) || (failedAt[key] && Date.now() - failedAt[key] < RETRY_BACKOFF_MS)) {
            return;
        }
        const auth = readAuth();
        if (!auth) {
            failedAt[key] = Date.now();
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
            failedAt[key] = Date.now();
            warn(`Id resolution failed for ${key}; keeping title-search links`, e);
        }).finally(() => inFlight.delete(key));
    }

    // Detail pages only: /movies/<slug> and /shows/<slug>. Season selection is
    // a query param on the show URL, so shows keep their links across seasons.
    function pageContext() {
        const segments = location.pathname.split('/').filter(Boolean);
        if (segments.length !== 2) {
            return null;
        }
        if (segments[0] === 'movies') {
            return { type: 'movie', slug: segments[1] };
        }
        if (segments[0] === 'shows') {
            return { type: 'show', slug: segments[1] };
        }
        return null;
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
        if (entry?.imdb) {
            return 'https://letterboxd.com/imdb/' + entry.imdb;
        }
        if (entry?.tmdb) {
            return 'https://letterboxd.com/tmdb/' + entry.tmdb;
        }
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
        if (!anchor || !item) {
            return null;
        }
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
            tiles[tiles.length - 1].after(chip);
        }
        const anchor = chip.querySelector('a');
        if (anchor && anchor.href !== url) {
            anchor.href = url;
        }
    }

    function removeChip(row, kind) {
        const chip = row.querySelector(`.${CHIP_CLASS}[${KIND_ATTR}="${kind}"]`);
        if (chip) {
            chip.remove();
        }
    }

    function scan() {
        const page = pageContext();
        const row = document.querySelector(ROW_SELECTOR);
        if (!page || !row) {
            return;
        }
        const title = pageTitle();
        if (!title) {
            return;
        }
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
        if (!templateTile) {
            return;
        }
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

    // rAF batches scans to one per frame, but rAF never fires in a hidden tab;
    // fall back to a macrotask there so links are ready before first view.
    // The observer watches childList only, so href rewrites (attribute
    // mutations) cannot retrigger it; chip insertion retriggers one idempotent
    // scan and settles.
    let scanQueued = false;
    function queueScan() {
        if (scanQueued) {
            return;
        }
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

    queueScan();
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
})();
