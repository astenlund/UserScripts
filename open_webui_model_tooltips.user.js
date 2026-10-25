// ==UserScript==
// @name         Open WebUI Model Tooltip Remover
// @namespace    fork-scripts
// @version      0.1
// @description  Removes the model info tooltips from the model selector dropdown items
// @author       Andreas Stenlund
// @match        http://localhost:3000/*
// @match        https://open-webui.taild4ff10.ts.net/*
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/open_webui_model_tooltips.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/open_webui_model_tooltips.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const OPTION_SELECTOR = '[role="listbox"][aria-label="Available models"] [role="option"]';

    // Tippy opens on mouseenter, which the browser dispatches after mouseover,
    // so disabling the instances here beats the tooltip to it.
    // Icon buttons (External, More) keep their tooltips.
    document.addEventListener('mouseover', event => {
        const option = event.target.closest?.(OPTION_SELECTOR);
        if (!option) {
            return;
        }

        option.querySelectorAll('*').forEach(el => {
            const tip = el._tippy;
            if (tip && tip.state.isEnabled && !el.querySelector('svg')) {
                tip.disable();
            }
        });
    }, true);
})();
