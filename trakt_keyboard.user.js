// ==UserScript==
// @name         Trakt.tv keyboard navigation
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_keyboard.user.js
// @author       Andreas Stenlund
// @match        *://trakt.tv/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const handleActionButtonKeypresses = code => {
        const buttons = $("#info-wrapper .action-buttons");

        if (!buttons.length) {
            return false;
        }

        switch(code) {
            case "KeyL":
                buttons.find(".popover.with-list").length
                    ? buttons.find(".popover.with-list i.cancel").click()
                    : buttons.find("a.btn-list").click();
                break;
            case "KeyH":
                buttons.find("a.btn-watch").click()
                buttons.find(".popover-content button.btn-primary:contains('Right now')").click();
                break;
            default:
                return false;
        }

        return true;
    }

    const handleGeneralKeypresses = code => {
        switch(code) {
            case "KeyC":
                localStorage.clear();
                location.reload(true);
                break;
            default:
                return false;
        }

        return true;
    }

    document.addEventListener('keyup', event => {
        handleActionButtonKeypresses(event.code) ||
        handleGeneralKeypresses(event.code);
    });
})();
