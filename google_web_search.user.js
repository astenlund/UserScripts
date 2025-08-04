// ==UserScript==
// @name         Google Web Search Enforcer
// @namespace    fork-scripts
// @version      0.1
// @description  Automatically adds udm=14 to Google searches to show Web results
// @author       Andreas Stenlund
// @match        https://www.google.com/search*
// @match        https://google.com/search*
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/google_web_search.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/google_web_search.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const url = new URL(window.location.href);
    const params = url.searchParams;

    if (!params.has('udm')) {
        params.set('udm', '14');
        window.location.replace(url.toString());
    }
})();
