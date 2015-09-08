// ==UserScript==
// @name        Google Play Music Search Focuser
// @namespace   fork-scripts
// @grant       none
// @match       *://play.google.com/music/*
// @version     0.1
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('gbqfq');
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
