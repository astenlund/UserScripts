// ==UserScript==
// @name         SF Date Selector
// @namespace    fork-scripts
// @version      0.1
// @description  Select a particular date on the SF booking page
// @author       Andreas Stenlund
// @match        http://www.sf.se/biljetter/bokningsflodet/valj-forestallning/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    $("ul li a[data-movielistfilterdate='05-08']").click();
})();
