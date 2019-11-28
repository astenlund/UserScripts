// ==UserScript==
// @name        Play Movies UserScript for Trakt.tv
// @namespace   fork-scripts
// @description Find a movie on Play Movies
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/playmovies_trakt.user.js
// @grant       none
// @version     0.1
// @match       *://trakt.tv/movies/*
// ==/UserScript==

var main = function() {
    var movie_title = $('meta[property="og:title"]').attr('content');
    var search_url = 'https://play.google.com/store/search?q=' + movie_title + '&c=movies';

    $('<a target="_blank" href="' + search_url + '" data-original-title title>Play Movies</a>').insertBefore('#info-wrapper .sidebar ul.external li a:contains("IMDB")');
}

main();
