// ==UserScript==
// @name        trakt UserScript for IMDb
// @namespace   fork-scripts
// @description Find a movie on trakt
// @grant       none
// @version     0.1
// @match       *://*.imdb.com/title/tt*
// @match       *://imdb.com/title/tt*
// ==/UserScript==

function create() {
    switch (arguments.length) {
    case 1:
        var A = document.createTextNode(arguments[0]);
        break;
    default:
        var A = document.createElement(arguments[0]), B = arguments[1];
        for (var b in B) {
            if (b.indexOf("on") == 0) {
                A.addEventListener(b.substring(2), B[b], false);
            }
            else if (",style,accesskey,id,name,src,href,which,class".indexOf("," + b.toLowerCase()) != -1) {
                A.setAttribute(b, B[b]);
            }
            else {
                A[b] = B[b];
            }
        }
        for ( var i = 2, len = arguments.length; i < len; ++i) {
            A.appendChild(arguments[i]);
        }
    }
    return A;
}

var osd = function() {
    var trakt_url = ''

    try {
        var regex = new RegExp(/tt(\d{7})/);
        var imdb_id = document.body.innerHTML.match(regex)[0];
        if (imdb_id) {
            trakt_url = 'http://trakt.tv/search/imdb/' + imdb_id;
        }
    }
    catch(e) {}

    var add_button_text = create('span', {
        'class': 'btn2_text',
        'innerHTML': 'trakt'
    });

    var add_button = create('a', {
        'class': 'btn2 btn2_text_on large title-trailer',
        'title': '',
        'id': 'add_to',
        'href': trakt_url,
        'target': '_blank'
    });

    add_button.appendChild(add_button_text);

    var overviewBottom = document.getElementById('overview-bottom');

    for (var i = 0; i < overviewBottom.childNodes.length; i++) {
        var elem = overviewBottom.childNodes[i];
        if (elem.nodeName == 'SPAN' && elem.className == 'btn2_wrapper') {
            elem.parentNode.replaceChild(add_button, elem);
        }
        else {
            for (var j = 0; j < elem.childNodes.length; j++) {
                var innerElem = elem.childNodes[j];
                if (innerElem.nodeName == 'SPAN' && innerElem.className == 'btn2_text') {
                    innerElem.innerHTML = 'Trailer';
                };
            };
        }
    }
}

osd();
