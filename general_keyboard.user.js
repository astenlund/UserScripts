// ==UserScript==
// @name         General keyboard shortcuts
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/general_keyboard.user.js
// @author       Andreas Stenlund
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const handleKeypress = event => {
        if (event.code == "KeyC" && event.ctrlKey && event.altKey)
        {
            localStorage.clear();
            location.reload(true);
            return true;
        }

        return false;
    }

    document.addEventListener('keyup', event => {
        handleKeypress(event);
    });
})();
