// ==UserScript==
// @name        trakt Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on trakt's search box on pageload and on esc key press
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/search_focuser_trakt.user.js
// @grant       none
// @match       *://trakt.tv/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('search-q');
    textBox.focus();
    textBox.select();
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
