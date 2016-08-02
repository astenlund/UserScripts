// ==UserScript==
// @name         SF Date Selector A
// @namespace    fork-scripts
// @version      0.2
// @description  try to take over the world!
// @author       Andreas Stenlund
// @match        http://www.sf.se/biljetter/bokningsflodet/valj-forestallning/
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    var title = 'Jason Bourne';

    var player = document.createElement('audio');
    player.preload = 'auto';
    player.src = 'https://dl.dropboxusercontent.com/u/2355432/tada.wav';

    if (Notification.permission !== 'granted') {
        Notification.requestPermission();
    }

    $("ul.customSelectBoxList li a[data-movielistfilterdate='05-08']").click();

    var elem = $("#BookingList").find('li:contains(' + title + ')');
    if (!elem.hasClass('displayNone')) {
        player.play();

        var notification = new Notification(title + ' går nu att boka!', {
            icon: 'https://upload.wikimedia.org/wikipedia/commons/c/c3/Svensk_Filmindustri_logo.png',
            body: 'Klicka här för att komma till bokningssidan',
            requireInteraction: true
        });

        notification.onclick = function () {
            notification.close();
            window.open('http://www.sf.se/biljetter/bokningsflodet/valj-forestallning/?MoviePageId=18037');
        };
    } else {
        setTimeout(function() {
            window.location.reload(1);
        }, 5000);
    }
})();
