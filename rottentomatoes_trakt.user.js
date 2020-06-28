// ==UserScript==
// @name        Rotten Tomatoes UserScript for Trakt.tv
// @namespace   fork-scripts
// @description Find a movie on Rotten Tomatoes
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/rottentomatoes_trakt.user.js
// @grant       none
// @version     0.1
// @match       *://trakt.tv/movies/*
// @match       *://trakt.tv/shows/*
// ==/UserScript==

(function() {
    'use strict';

    var title = $('meta[property="og:title"]').attr('content');
    var search_url = 'https://www.rottentomatoes.com/search?search=' + title;

    $('<a target="_blank" href="' + search_url + '" data-original-title title>Rotten Tomatoes</a>').insertBefore('#info-wrapper .sidebar ul.external li a:contains("IMDB")');
})();
