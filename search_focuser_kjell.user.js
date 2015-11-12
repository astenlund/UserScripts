// ==UserScript==
// @name        Kjell & Company Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on Kjell & Company's search box on pageload and on esc key press
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/search_focuser_kjell.user.js
// @grant       none
// @match       *://www.kjell.com/*
// @version     0.2
// ==/UserScript==

function focusSearch()
{
    var textBox = document.getElementById('query');
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
