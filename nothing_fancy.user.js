// ==UserScript==
// @name         Nothing Fancy - Movies on Google Play
// @namespace    fork-scripts
// @version      0.2
// @description  Remove expensive movies from Google Play
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/nothing_fancy.user.js
// @author       Andreas Stenlund
// @match        https://play.google.com/store/movies/new
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    $("div.card").each(function(i, card) {
        var priceLmnt = $(card).find("span.display-price");
        var price = parseInt(priceLmnt.html().split(",")[0]);
        if(price > 50) {
            console.log("Removing " + $(card).find("a.title").attr("title") + " (" + price + " kr)");
            card.remove();
        }
    });
})();
