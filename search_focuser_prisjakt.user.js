// ==UserScript==
// @name        Prisjakt Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on Prisjakt's search box on pageload and on esc key press
// @grant       none
// @match       *://www.prisjakt.nu/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('super_search_textbox');
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
