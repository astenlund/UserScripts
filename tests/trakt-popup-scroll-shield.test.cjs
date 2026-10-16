const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initPopupScrollShield() {');
const end = source.indexOf('\n  })();', start);
assert.ok(start >= 0 && end > start);
const feature = source.slice(start, end + '\n  })();'.length);

const ONSCREEN = { top: 100, bottom: 300, left: 100, right: 300, width: 200, height: 200 };

// Summary actions markup as observed 2026-10-17: the permanently rendered
// wrapper shares the menu's class; the inner menu with its ul row group
// and the dismissal underlay render only while the menu is open.
function summaryPage({ open, underlay: withUnderlay = open }) {
  const menu = open
    ? '<div class="trakt-summary-actions-slider"><div class="trakt-summary-actions"><ul class="trakt-dropdown-group"><li role="button"><p>Share</p></li></ul></div></div>'
    : '';
  const underlay = withUnderlay ? '<div class="trakt-summary-actions-underlay"></div>' : '';
  return `<div class="trakt-summary-actions"><div class="trakt-summary-actions-bar">${menu}</div></div>${underlay}`;
}

// jsdom has no layout, so every element reports an onscreen rect, the
// wrapper included, as it does live.
function load(html) {
  const dom = new JSDOM(html, { url: 'https://app.trakt.tv/shows/treasure-island-2026', runScripts: 'outside-only' });
  const { window } = dom;
  for (const el of window.document.querySelectorAll('*')) {
    el.getBoundingClientRect = () => ONSCREEN;
  }
  window.eval(feature);
  let heard = 0;
  window.document.addEventListener('wheel', () => heard++);
  const wheel = () => window.document.body.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }));
  return { wheel, heard: () => heard };
}

test('an open summary menu swallows wheel events before the app hears them', () => {
  // Arrange
  const { wheel, heard } = load(summaryPage({ open: true }));

  // Act
  wheel();

  // Assert
  assert.equal(heard(), 0);
});

test('a closed summary menu lets wheel events through despite the onscreen wrapper', () => {
  // Arrange
  const { wheel, heard } = load(summaryPage({ open: false }));

  // Act
  wheel();

  // Assert
  assert.equal(heard(), 1);
});

test('an underlay without the row group lets wheel events through', () => {
  // Arrange
  const { wheel, heard } = load(summaryPage({ open: false, underlay: true }));

  // Act
  wheel();

  // Assert
  assert.equal(heard(), 1);
});

test('a row group without the underlay lets wheel events through', () => {
  // Arrange
  const { wheel, heard } = load(summaryPage({ open: true, underlay: false }));

  // Act
  wheel();

  // Assert
  assert.equal(heard(), 1);
});
