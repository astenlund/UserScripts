// ==UserScript==
// @name        External Links for Trakt.tv
// @namespace   fork-scripts
// @description Add Rotten Tomatoes and Letterboxd search links to Trakt.tv
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @updateURL   https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @grant       none
// @version     0.6
// @match       *://trakt.tv
// @match       *://trakt.tv/*
// ==/UserScript==

(function() {
    'use strict';

    var addExternalLinks = function() {
        var url = document.location;

        // Only run on movie and show pages (but not season pages)
        if (!/trakt\.tv\/movies/.test(url) && !/trakt\.tv\/shows/.test(url)) {
            return;
        }

        if (/trakt\.tv\/shows\/.+?\/seasons\/\d+/.test(url)) {
            return;
        }

        // Need IMDB link as reference point
        var imdbLmnt = $('#info-wrapper .sidebar ul.external li a:contains("IMDB")')[0];
        if (imdbLmnt == undefined) {
            return;
        }

        // Get the title
        var title = $('#info-wrapper #overview a.btn-checkin').attr('data-top-title');
        if (title == undefined) {
            title = $('meta[property="og:title"]').attr('content');
        }

        title = title.replace(/\s\(\d{4}\)$/, ''); // Remove year from title

        // Define external services to add
        var services = [
            {
                name: 'Letterboxd',
                url: 'https://letterboxd.com/search/' + title
            },
            {
                name: 'Rotten Tomatoes',
                url: 'https://www.rottentomatoes.com/search?search=' + title
            }
        ];

        // Add each service if it doesn't exist
        services.forEach(function(service) {
            var existingLink = $('#info-wrapper .sidebar ul.external li a:contains("' + service.name + '")')[0];
            if (existingLink == undefined) {
                $('<a target="_blank" href="' + service.url + '" data-original-title title>' + service.name + '</a>').insertBefore(imdbLmnt);
            }
        });
    };

    window.onclick = function(e) {
        addExternalLinks();
    };

    addExternalLinks();
})();
