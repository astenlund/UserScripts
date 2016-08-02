// ==UserScript==
// @name         SF Date Selector B
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @author       Andreas Stenlund
// @match        http://www.sf.se/biljetter/bokningsflodet/valj-forestallning/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var elem = $("ul.customSelectBoxList li a[data-showlistfilterdate='05-08|20160805']");

    if (elem.length !== 0) {
        elem.click();
    }
})();
