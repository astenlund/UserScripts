// ==UserScript==
// @name        TorrentLeech Search Focuser
// @namespace   fork-scripts
// @description This script puts focus on TorrentLeech's search box on pageload and on esc key press
// @downloadURL https://github.com/astenlund/UserScripts/raw/master/search_focuser_torrentleech.user.js
// @grant       none
// @match       *://www.torrentleech.org/*
// @version     0.3
// ==/UserScript==

function keyupCallback(ev)
{
    var esc_key = 27

    if (ev.keyCode == esc_key)
    {
        focus();
    }
}

function focus()
{
    var textBox = document.getElementsByName('search')[0];
    textBox.focus();
    textBox.select();
}

document.addEventListener('keyup', keyupCallback, false);
