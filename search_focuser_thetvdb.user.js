// ==UserScript==
// @name        TheTVDB.com Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on TheTVDB.com's search box on pageload and on esc key press
// @grant       none
// @match       *://thetvdb.com/*
// @version     0.1
// ==/UserScript==

function focusSearch()
{
    document.getElementById('search').focus();
}

function focusKey(ev)
{
    var esc_key = 27

    if (ev.keyCode == esc_key)
    {
        focusSearch();
    }
}

document.addEventListener('keyup', focusKey, false);
window.addEventListener('load', focusSearch, false);
