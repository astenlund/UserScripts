// ==UserScript==
// @name        Goodreads Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on Goodreads' search box on pageload and on esc key press
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/search_focuser_goodreads.user.js
// @grant       none
// @match       *://www.goodreads.com/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('sitesearch_field');
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
