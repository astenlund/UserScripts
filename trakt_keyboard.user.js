// ==UserScript==
// @name         Trakt.tv keyboard navigation
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_keyboard.user.js
// @author       Andreas Stenlund
// @match        *://trakt.tv/shows/*
// @match        *://trakt.tv/movies/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    document.addEventListener('keyup', function(event) {
        switch(event.code) {
            case "KeyL":
                if ($("#info-wrapper .action-buttons .popover.with-list").length) {
                    $("#info-wrapper .action-buttons .popover.with-list i.cancel").click();
                }
                else {
                    $("#info-wrapper .action-buttons a.btn-list").click();
                }
                break;
            case "KeyH":
                $("#info-wrapper .action-buttons a.btn-watch").click()
                $("#info-wrapper .action-buttons .popover-content button.btn-primary:contains('Right now')").click();
                break;
            case "KeyC":
                localStorage.clear();
                location.reload(true);
                break;
            default:
                break;
        }
    });
})();
