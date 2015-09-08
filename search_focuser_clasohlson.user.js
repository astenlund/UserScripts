// ==UserScript==
// @name        clas ohlson Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on clas ohlson's search box on pageload and on esc key press
// @grant       none
// @match       *://www.clasohlson.com/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('searchterms');
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
