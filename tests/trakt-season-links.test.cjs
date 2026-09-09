const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  function cardSubtitleSeason(card) {');
const end = source.indexOf('  // Feature: fade filters', start);
assert.ok(start >= 0 && end > start);

function load(subtitle = 'Season 7', href = '/shows/taskmaster?mode=media&ignore_watched=false#details') {
  const dom = new JSDOM('<div class="trakt-card"><p class="trakt-card-subtitle"></p><a>Poster</a><a>Title</a></div>', {
    url: 'https://app.trakt.tv/users/thefork/lists/taskmaster-hall-of-fame', runScripts: 'outside-only',
  });
  const { window } = dom;
  const label = window.document.querySelector('p');
  label.textContent = subtitle;
  const anchors = [...window.document.querySelectorAll('a')];
  for (const anchor of anchors) anchor.setAttribute('href', href);
  window.scanCallbacks = [];
  window.eval(source.slice(start, end));
  assert.equal(window.scanCallbacks.length, 1);
  return { window, label, anchors, scan: window.scanCallbacks[0] };
}

test('all season-card show links navigate to the season while preserving query and hash', () => {
  const { anchors, scan } = load();
  scan();
  for (const anchor of anchors) {
    const url = new URL(anchor.href);
    assert.equal(url.pathname, '/shows/taskmaster');
    assert.equal(url.searchParams.get('season'), '7');
    assert.equal(url.searchParams.get('mode'), 'media');
    assert.equal(url.searchParams.get('ignore_watched'), 'false');
    assert.equal(url.hash, '#details');
  }
});

test('explicit season and episode links, unrelated destinations and malformed links remain unchanged', () => {
  for (const href of ['/shows/taskmaster?season=2', '/shows/taskmaster?season=', '/shows/taskmaster?episode=3',
    '/movies/taskmaster', '/shows/taskmaster/related', 'https://example.com/shows/taskmaster', 'http://[']) {
    const { anchors, scan } = load('Season 7', href);
    scan();
    assert.equal(anchors[0].getAttribute('href'), href);
  }
});

test('specials map to zero, while unknown and invalid subtitles do not change show links', () => {
  for (const subtitle of ['Specials', 'Season 0', 'Season 2']) {
    const { anchors, scan } = load(subtitle);
    scan();
    assert.equal(new URL(anchors[0].href).searchParams.get('season'), subtitle === 'Season 2' ? '2' : '0');
  }
  for (const subtitle of ['Comedy', 'Season ?', 'Season 02', 'Season -1', 'Season 1.5', 'Season 9007199254740992']) {
    const { anchors, scan } = load(subtitle);
    const original = anchors[0].getAttribute('href');
    scan();
    assert.equal(anchors[0].getAttribute('href'), original);
  }
});

test('recycled cards update and remove only script-owned season parameters', () => {
  const { anchors, label, scan } = load();
  const original = anchors[0].getAttribute('href');
  scan();
  label.textContent = 'Season 16';
  scan();
  assert.equal(new URL(anchors[0].href).searchParams.get('season'), '16');
  label.textContent = 'Comedy';
  scan();
  assert.equal(anchors[0].getAttribute('href'), original);
  label.textContent = 'Season 5';
  scan();
  anchors[0].setAttribute('href', '/shows/taskmaster-nz?season=2');
  scan();
  assert.equal(anchors[0].getAttribute('href'), '/shows/taskmaster-nz?season=2');
  anchors[0].setAttribute('href', '/shows/taskmaster-au?mode=media');
  scan();
  assert.equal(new URL(anchors[0].href).pathname, '/shows/taskmaster-au');
  assert.equal(new URL(anchors[0].href).searchParams.get('season'), '5');
});

test('repeat scans make no attribute or child-node writes', async () => {
  const { window, scan } = load();
  scan();
  const records = [];
  const observer = new window.MutationObserver(batch => records.push(...batch));
  observer.observe(window.document.body, { subtree: true, childList: true, attributes: true });
  scan();
  scan();
  await Promise.resolve();
  observer.disconnect();
  assert.equal(records.length, 0);
});
