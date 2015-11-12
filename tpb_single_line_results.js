// ==UserScript==
// @name         TPB Single Line Results
// @namespace    fork-scripts
// @version      0.1
// @description  Makes sure that the results are shown with a single line per item.
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/tpb_single_line_results.js
// @author       Andreas Stenlund
// @match        https://thepiratebay.tld/search/*
// @grant        none
// ==/UserScript==

try {
    var url = document.location.toString();
    var updateUrl = updateQueryStringParameter(url, 'view', 's');
    console.log(updateUrl);
    console.log(url != updateUrl);
    if (url != updateUrl) {
        document.location = updateUrl;
    }
} catch (e) {}

function updateQueryStringParameter(uri, key, value) {
    var re = new RegExp("([?&])" + key + "=.*?(&|$)", "i");
    var separator = uri.indexOf('?') !== -1 ? "&" : "?";
    if (uri.match(re)) {
        return uri.replace(re, '$1' + key + "=" + value + '$2');
    } else {
        return uri + separator + key + "=" + value;
    }
}
