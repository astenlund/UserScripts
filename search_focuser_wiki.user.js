// ==UserScript==
// @name        wiki Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on wiki's search box on pageload and on esc key press
// @grant       none
// @match       *://wiki/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('qsearch__in');
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
