// ==UserScript==
// @name         Continue to Image Clicker
// @namespace    fork-scripts
// @version      0.1.3
// @description  try to take over the world!
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/continue_to_image_clicker.user.js
// @author       Andreas Stenlund
// @match        *://img.yt/*.html
// @match        *://imgpix.net/*.html
// @match        *://xximg.net/*.html
// @match        *://sximg.nl/*.html
// @match        *://imagepics.xyz/*.html
// @match        *://imgpics.nl/*.html
// @grant        none
// @require      https://code.jquery.com/jquery-3.2.1.slim.min.js
// ==/UserScript==

(function() {
    'use strict';

    $('input[name="imgContinue"]').click();
})();
