// ==UserScript==
// @name         Open WebUI Model Tooltip Remover
// @namespace    fork-scripts
// @version      0.2
// @description  Removes the model info tooltips from the model selector dropdown and the settings models list
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

    const SURFACES = [
        {
            // Model selector dropdown items. Icon buttons (External, More)
            // contain an svg and keep their tooltips.
            selector: '[role="listbox"][aria-label="Available models"] [role="option"]',
            keepsTooltip: el => Boolean(el.querySelector('svg'))
        },
        {
            // Settings models list rows. The rows themselves contain svgs
            // (drag handle, Edit, More), so the svg check would spare the
            // whole row; the action buttons are the only labelled elements,
            // and they keep their tooltips.
            selector: '[id^="model-item-"]',
            keepsTooltip: el => el.hasAttribute('aria-label')
        }
    ];

    // Tippy opens on mouseenter, which the browser dispatches after mouseover,
    // so disabling the instances here beats the tooltip to it.
    document.addEventListener('mouseover', event => {
        const target = event.target;
        if (!target?.closest) {
            return;
        }

        for (const surface of SURFACES) {
            const host = target.closest(surface.selector);
            if (!host) {
                continue;
            }

            [host, ...host.querySelectorAll('*')].forEach(el => {
                const tip = el._tippy;
                if (tip && tip.state.isEnabled && !surface.keepsTooltip(el)) {
                    tip.disable();
                }
            });
        }
    }, true);
})();
