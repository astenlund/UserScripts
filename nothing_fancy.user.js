// ==UserScript==
// @name         Nothing Fancy - Movies on Google Play
// @namespace    fork-scripts
// @version      0.4
// @description  Remove expensive movies from Google Play
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/nothing_fancy.user.js
// @author       Andreas Stenlund
// @match        https://play.google.com/store/movies*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    $("div.card").each(function(i, cardDiv) {
        var priceButton = $(cardDiv).find("button.price");
        var priceSpan = $(priceButton).find("span.display-price");
        var price = parseInt(priceSpan.html().split(",")[0]);
        if (price > 50) {
            console.log("Expensive: " + $(cardDiv).find("a.title").attr("title") + " (" + price + " kr)");
            $(priceButton).css("font-weight", "bold");
            $(priceButton).css("text-decoration", "underline");
        }
    });
})();
