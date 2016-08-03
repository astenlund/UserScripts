// ==UserScript==
// @name         RibbedTee Package Tracker
// @namespace    fork-scripts
// @version      0.1
// @author       Andreas Stenlund
// @match        http://www.postnord.se/en/tools/track/Pages/track-and-trace.aspx
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var trackingNumber = 'LJ903134669US';

    var textbox = $("div.PWP-module input.PWP-textbox");
    if (textbox.val().length === 0) {
        textbox.val(trackingNumber);
        $("div.PWP-module div.button input").click();
    }
})();
