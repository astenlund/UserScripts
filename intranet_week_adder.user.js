// ==UserScript==
// @name         Intranet Week Adder
// @namespace    fork-scripts
// @version      0.2
// @description  Display current week on page
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/intranet_week_adder.user.js
// @author       Andreas Stenlund
// @match        https://intranet.kvadrat.se/tidrapportering/Tidrapport.cshtml
// @icon         https://www.google.com/s2/favicons?domain=kvadrat.se
// @grant        none
// @run-at       document-end
// @require      https://code.jquery.com/jquery-3.6.0.slim.min.js
// ==/UserScript==

(function() {
    'use strict';

    var main = function() {
        var lmnt = createWeekElement();
        var trgt = $('div#timredovisning form div.row div.span8');

        trgt.append(lmnt);
    };

    var createWeekElement = function() {
        var week = new Date().getWeek();
        var span = document.createElement('span');
        var br = document.createElement('br');
        var em = document.createElement('em');
        var text = document.createTextNode("Nuvarande vecka: " + week);

        em.appendChild(text);
        span.appendChild(br);
        span.appendChild(em);

        return span;
    };

    Date.prototype.getWeek = function() {
        var date = new Date(this.getTime());
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
        var week1 = new Date(date.getFullYear(), 0, 4);
        return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    };

    main();
})();
