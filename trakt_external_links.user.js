// ==UserScript==
// @name        External Links for Trakt.tv
// @namespace   fork-scripts
// @description Add Rotten Tomatoes and Letterboxd search links to Trakt.tv
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @updateURL   https://github.com/astenlund/UserScripts/raw/master/trakt_external_links.user.js
// @grant       none
// @version     0.7
// @match       *://trakt.tv
// @match       *://trakt.tv/*
// ==/UserScript==

(function() {
    'use strict';

    const EXTERNAL_SERVICES = [
        {
            name: 'Letterboxd',
            pageTypes: ['movie'],
            buildUrl: (title) => 'https://letterboxd.com/search/' + title
        },
        {
            name: 'Rotten Tomatoes',
            pageTypes: ['movie', 'show'],
            buildUrl: (title) => 'https://www.rottentomatoes.com/search?search=' + title
        }
    ];

    const PAGE_PATTERNS = {
        movie: /trakt\.tv\/movies/,
        show: /trakt\.tv\/shows/,
        seasonExclude: /trakt\.tv\/shows\/.+?\/seasons\/\d+/
    };

    var getPageType = function(url) {
        if (PAGE_PATTERNS.seasonExclude.test(url)) {
            return null;
        }
        if (PAGE_PATTERNS.movie.test(url)) {
            return 'movie';
        }
        if (PAGE_PATTERNS.show.test(url)) {
            return 'show';
        }
        return null;
    };

    var extractTitle = function() {
        var title = $('#info-wrapper #overview a.btn-checkin').attr('data-top-title');
        if (title == undefined) {
            title = $('meta[property="og:title"]').attr('content');
        }
        if (title) {
            title = title.replace(/\s\(\d{4}\)$/, ''); // Remove year from title
        }
        return title;
    };

    var getApplicableServices = function(pageType) {
        if (!pageType) return [];

        return EXTERNAL_SERVICES.filter(function(service) {
            return service.pageTypes.includes(pageType);
        });
    };

    var addExternalLinks = function() {
        var url = document.location.href;
        var pageType = getPageType(url);

        if (!pageType) {
            return;
        }

        // Need IMDB link as reference point
        var imdbLmnt = $('#info-wrapper .sidebar ul.external li a:contains("IMDB")')[0];
        if (imdbLmnt == undefined) {
            return;
        }

        var title = extractTitle();
        if (!title) {
            return;
        }

        var services = getApplicableServices(pageType);

        services.forEach(function(service) {
            var existingLink = $('#info-wrapper .sidebar ul.external li a:contains("' + service.name + '")')[0];
            if (existingLink == undefined) {
                var url = service.buildUrl(title);
                $('<a target="_blank" href="' + url + '" data-original-title title>' + service.name + '</a>').insertBefore(imdbLmnt);
            }
        });
    };

    window.onclick = function(e) {
        addExternalLinks();
    };

    addExternalLinks();
})();
