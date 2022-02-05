// ==UserScript==
// @name         Intranet Auto Login
// @namespace    fork-scripts
// @version      0.1
// @description  Auto login to Kvadrat intranet
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/intranet_auto_login.user.js
// @author       a.stenlund@gmail.com
// @match        https://intranet.kvadrat.se/generellt/Inloggning.cshtml
// @icon         https://www.google.com/s2/favicons?domain=kvadrat.se
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var form = document.getElementById('inloggning');
    var user = document.getElementById('anvnamn');
    var pass = document.getElementById('losenord');

    if (form && user && pass) {
        user.value = 'YOUR_USERNAME';
        pass.value = 'YOUR_PASSWORD';
        form.submit();
    } else {
        console.warn('Form id:s have changed, could not login');
    }
})();
