// ==UserScript==
// @name        External Links for Trakt.tv
// @namespace   fork-scripts
// @description Replace unreliable Rotten Tomatoes links with title searches and add a Letterboxd search link on Trakt Web
// @author      Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @updateURL   https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @match       https://app.trakt.tv/*
// @run-at      document-idle
// @noframes
// @grant       none
// @version     1.0
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

    // Detail pages only: /movies/<slug> and /shows/<slug>. Season selection is a
    // query param on the show URL, so shows keep their chips across seasons.
    function pageType() {
        const segments = location.pathname.split('/').filter(Boolean);
        if (segments.length !== 2) {
            return null;
        }
        if (segments[0] === 'movies') {
            return 'movie';
        }
        if (segments[0] === 'shows') {
            return 'show';
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

    // Native RT links are unreliable (sometimes missing, sometimes the wrong
    // title), so every one of them becomes a title search. Svelte re-renders
    // restore the original hrefs; the observer rescan puts the search URL back,
    // and the equality check keeps the pass idempotent.
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
                console.warn('[trakt-external-links] Ratings tile markup changed; cannot inject ' + kind + ' chip');
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
        const type = pageType();
        const row = document.querySelector(ROW_SELECTOR);
        if (!type || !row) {
            return;
        }
        const title = pageTitle();
        if (!title) {
            return;
        }
        const rtUrl = rtSearchUrl(title);
        rewriteRtAnchors(rtUrl);
        const templateTile = row.querySelector(`rating:not(.${CHIP_CLASS})`);
        if (!templateTile) {
            return;
        }
        // A rewritten native RT tile already shows the score and links to the
        // search, so the icon-only chip is only for pages missing RT entirely.
        const hasNativeRt = !!templateTile.parentElement.querySelector(`rating:not(.${CHIP_CLASS}) ${RT_HREF_MATCH}`);
        if (hasNativeRt) {
            removeChip(row, 'rt');
        } else {
            ensureChip(row, templateTile, 'rt', 'Search on Rotten Tomatoes', rtUrl);
        }
        // Letterboxd covers films only; drop the chip when SPA navigation reuses
        // the row for a show.
        if (type === 'movie') {
            ensureChip(row, templateTile, 'lb', 'Search on Letterboxd', lbSearchUrl(title));
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
