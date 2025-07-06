// ==UserScript==
// @name         Plex AMP Poster Button
// @namespace    fork-scripts
// @version      0.1
// @description  Add a one‑click AlternativeMoviePosters search button to Plex Web’s movie detail page; replaces the Share icon when present or appends just before the “More” button otherwise.
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/plex_amp.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/plex_amp.user.js
// @author       Andreas Stenlund
// @match        https://app.plex.tv/*
// @icon         https://alternativemovieposters.com/favicon.ico
// @grant        GM_openInTab
// @run-at       document-end
// ==/UserScript==

(() => {
  'use strict';

  const BUTTON_LABEL = 'AMP';
  const BUTTON_TOOLTIP = 'Search on Alternative Movie Posters';
  const AMP_SEARCH_URL = 'https://alternativemovieposters.com/?s=';

  function createAMPButton() {
    const button = document.createElement('button');
    button.setAttribute('data-state', 'closed');
    button.setAttribute('aria-label', BUTTON_TOOLTIP);
    button.setAttribute('role', 'button');
    button.setAttribute('type', 'button');
    button.title = BUTTON_TOOLTIP;

    // Copy classes from other buttons
    button.className = '_1v4h9jl0 _76v8d62 _76v8d61 _76v8d6a tvbry60 _76v8d6g _76v8d65 _1v25wbq1g _1v25wbq18';

    // Create inner structure
    button.innerHTML = `
      <div class="_1h4p3k00 _1v25wbq8 _1v25wbq1w _1v25wbqg _1v25wbq1g _1v25wbq1c _1v25wbq14 _1v25wbq3g _1v25wbq2g">
        <span style="font-weight: bold; font-size: 14px;">${BUTTON_LABEL}</span>
      </div>
    `;

    return button;
  }

  function getMovieTitle() {
    // Try to find the movie title from the metadata title element
    const titleElement = document.querySelector('[data-testid="metadata-title"]');
    return titleElement ? titleElement.textContent.trim() : null;
  }

  function insertAMPButton() {
    // Find the More button
    const moreButton = document.querySelector('[data-testid="preplay-more"]');
    if (!moreButton) return false;

    // Check if we already added any AMP button in the button container
    const buttonContainer = moreButton.parentNode;
    if (buttonContainer.querySelector(`button[aria-label="${BUTTON_TOOLTIP}"]`)) {
      return true;
    }

    const movieTitle = getMovieTitle();
    if (!movieTitle) return false;

    const ampButton = createAMPButton();

    // Add click handler
    ampButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const searchUrl = AMP_SEARCH_URL + encodeURIComponent(movieTitle);
      GM_openInTab(searchUrl, { active: true, insert: true });
    });

    // Insert before the More button
    moreButton.parentNode.insertBefore(ampButton, moreButton);

    return true;
  }

  function init() {
    // Initial attempt
    insertAMPButton();

    // Watch for changes since Plex is a SPA
    const observer = new MutationObserver((mutations) => {
      // Check if we're on a movie detail page
      if (document.querySelector('[data-testid="metadata-title"]') &&
          document.querySelector('[data-testid="preplay-more"]')) {
        insertAMPButton();
      }
    });

    // Start observing
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
