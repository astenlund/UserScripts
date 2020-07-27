// ==UserScript==
// @name         HAProxy keyboard shortcuts
// @namespace    fork-scripts
// @version      0.2
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/haproxy_keyboard.user.js
// @author       Andreas Stenlund
// @match        *://tckbalancete1.ticket.se:8080/*
// @match        *://tckbalancetest1.ticket.se/*
// @match        *://tckbalance1.ticket.se:8080/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    document.addEventListener('keyup', event => {
        switch(event.code) {
            case "KeyR":
                location.reload(true);
                break;
        }
    });
})();
