// ==UserScript==
// @name         HAProxy keyboard shortcuts
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/haproxy_keyboard.user.js
// @author       Andreas Stenlund
// @match        *://tckbalancete1.ticket.se:8080/*
// @grant        none
// @run-at       document-end
// @require      https://code.jquery.com/jquery-3.4.1.slim.min.js
// ==/UserScript==

(function() {
    'use strict';

    document.addEventListener('keyup', event => {
        switch(event.code) {
            case "KeyR":
                $("table ul li a:contains('Refresh now')")[0].click();
                break;
        }
    });
})();
