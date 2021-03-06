// ==UserScript==
// @name        Rotten Tomatoes UserScript for Trakt.tv
// @namespace   fork-scripts
// @description Find a movie on Rotten Tomatoes
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/rottentomatoes_trakt.user.js
// @grant       none
// @version     0.5
// @match       *://trakt.tv
// @match       *://trakt.tv/*
// ==/UserScript==

(function() {
    'use strict';

    var addRT = function() {
        var url = document.location;

        if (!/trakt\.tv\/movies/.test(url) && !/trakt\.tv\/shows/.test(url)) {
            return;
        }

        if (/trakt\.tv\/shows\/.+?\/seasons\/\d+/.test(url)) {
            return;
        }

        var imdbLmnt = $('#info-wrapper .sidebar ul.external li a:contains("IMDB")')[0];
        if (imdbLmnt == undefined) {
            return;
        }

        var rtLmnt = $('#info-wrapper .sidebar ul.external li a:contains("Rotten Tomatoes")')[0];
        if (rtLmnt != undefined) {
            return;
        }

        var title = $('#info-wrapper #overview a.btn-checkin').attr('data-top-title');
        if (title == undefined) {
            title = $('meta[property="og:title"]').attr('content');
        }

        title = title.replace(/\s\(\d{4}\)$/, ''); // Remove year from title

        var search_url = 'https://www.rottentomatoes.com/search?search=' + title;

        $('<a target="_blank" href="' + search_url + '" data-original-title title>Rotten Tomatoes</a>').insertBefore(imdbLmnt);
    };

    window.onclick = function(e) {
        addRT();
    };

    addRT();
})();
