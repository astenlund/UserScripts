// ==UserScript==
// @name         Nothing Fancy - Movies on Google Play
// @namespace    fork-scripts
// @version      0.1
// @description  Remove expensive movies from Google Play
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/nothing_fancy.user.js
// @author       Andreas Stenlund
// @match        https://play.google.com/store/movies/new
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // var element = $("div.card:has(a[title='Hidden Figures'])");
    // element.remove();
    // alert(element.length);

    $("div.card").each(function(i, card) {
        var priceLmnt = $(card).find("span.display-price");
        var price = parseInt(priceLmnt.html().split(",")[0]);
        if(price > 50) {
            console.log("Removing " + $(card).find("a.title").attr("title") + " (" + price + " kr)");
            card.remove();
        }
    });
})();
