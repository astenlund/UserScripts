const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initFadeFilters() {');
const end = source.indexOf('    // ---- Theme detection', start);
assert.ok(start >= 0 && end > start);
const feature = source.slice(start, end) + 'window.subject = { cardTarget, applyFades, ensureFadeSection }; })();';
const categories = ['started', 'watched', 'watchlisted', 'anticipated', 'uninterested', 'listed'];

function load(html = '', stored = null) {
  const dom = new JSDOM(html, { url: 'https://app.trakt.tv/discover', runScripts: 'outside-only' });
  const { window } = dom;
  const sets = Object.fromEntries(categories.map(cat => [cat, new Set()]));
  const saved = [];
  const warnings = [];
  Object.assign(window, {
    CATEGORIES: ['started', 'watched', 'watchlisted', 'listed'],
    QUICK_CATS: { anticipated: 'Anticipated', uninterested: 'Uninterested' },
    readJson: key => key === 'trakt-fade-filters' ? stored : null,
    writeJson: (key, value) => saved.push({ key, value: JSON.parse(JSON.stringify(value)) }),
    queueScan() {},
    warn: message => warnings.push(message),
    mediaType: type => ({ shows: 'show', movies: 'movie' })[type],
    membership: { sets: () => sets, listedCounts: () => ({}) },
  });
  window.eval(feature);
  return { window, document: window.document, subject: window.subject, sets, saved, warnings };
}

function card(subtitle, query = '') {
  return `<div class="trakt-card"><a href="/shows/taskmaster${query}"><p class="trakt-card-title">Taskmaster</p><p class="trakt-card-subtitle">${subtitle}</p></a></div>`;
}

function display(legacy = false) {
  const control = legacy ? '<input type="checkbox">' : `<div role="radiogroup" aria-label="Watched" style="--segment-count:3;--selected-index:1">
    <div class="segment-row"><div class="segment-selector"></div>
    ${['Default', 'On', 'Off'].map(label => `<button type="button" role="radio" aria-label="${label}" aria-checked="${label === 'On'}" class="segment${label === 'On' ? ' is-selected' : ''}">${label}</button>`).join('')}
    </div></div>`;
  return `<div class="pane"><div class="trakt-display-section"><span class="display-title">Display</span><div class="display-toggles"><div class="trakt-filter"><span class="secondary">Watched</span>${control}</div></div></div><button aria-label="Set filters as default"><span>Save</span></button></div>`;
}

test('season subtitles prevent list cards from inheriting whole-show fading', () => {
  const { document, subject, sets } = load(card('Season 7') + card('Season 16'));
  sets.started.add('show:taskmaster');
  sets.started.add('show:taskmaster:s7');
  subject.applyFades('discover');
  const cards = [...document.querySelectorAll('.trakt-card')];
  assert.equal(cards[0].classList.contains('tff-fade'), true);
  assert.equal(cards[1].classList.contains('tff-fade'), false);
  sets.started.delete('show:taskmaster:s7');
  subject.applyFades('discover');
  assert.equal(cards[0].classList.contains('tff-fade'), false);
});

test('URL seasons and episodes remain authoritative; specials and plain shows retain identity', () => {
  for (const [subtitle, query, season, episode] of [
    ['Season 7', '?season=2', '2', null],
    ['Season 7', '?season=2&episode=3', '2', '3'],
    ['Specials', '', '0', null],
    ['Season 0', '', '0', null],
    ['Comedy', '', null, null],
  ]) {
    const { document, subject } = load(card(subtitle, query));
    const target = subject.cardTarget(document.querySelector('.trakt-card'));
    assert.equal(target.season, season);
    assert.equal(target.episode, episode);
  }
});

test('unreadable season cards stay unfaded instead of falling back to show membership', () => {
  for (const subtitle of ['Season ?', 'Season 02', 'Season -1', 'Season 1.5', 'Season 9007199254740992']) {
    const { document, subject } = load(card(subtitle));
    assert.equal(subject.cardTarget(document.querySelector('.trakt-card')), null);
  }
  const { document, subject } = load(card('').replace('</a>', '<img src="https://media.trakt.tv/images/seasons/1/poster.webp"></a>'));
  assert.equal(subject.cardTarget(document.querySelector('.trakt-card')), null);
});

test('redesigned drawer renders binary controls, applies changes and saves only on explicit save', () => {
  const { window, document, subject, sets, saved } = load(display() + card('Season 7'), { started: false });
  subject.ensureFadeSection();
  const section = document.querySelector('[data-tff-section]');
  assert.ok(section);
  assert.equal(section.querySelectorAll('[data-tff-row]').length, 6);
  assert.equal(section.querySelectorAll('[aria-label="Default"]').length, 0);
  const group = section.querySelector('[aria-label="Fade started"]');
  const on = group.querySelector('[aria-label="On"]');
  const off = group.querySelector('[aria-label="Off"]');
  assert.equal(off.getAttribute('aria-checked'), 'true');
  assert.equal(group.style.getPropertyValue('--segment-count'), '2');
  sets.started.add('show:taskmaster:s7');
  on.click();
  subject.applyFades('discover');
  assert.equal(document.querySelector('.trakt-card').classList.contains('tff-fade'), true);
  assert.equal(saved.length, 0);
  assert.equal(on.tabIndex, 0);
  assert.equal(off.tabIndex, -1);
  on.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  subject.applyFades('discover');
  assert.equal(document.querySelector('.trakt-card').classList.contains('tff-fade'), false);
  assert.equal(document.activeElement, off);
  assert.equal(group.style.getPropertyValue('--selected-index'), '1');
  document.querySelector('button[aria-label="Set filters as default"] span').click();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].value.started, false);
  assert.equal(document.querySelector('.trakt-display-section:not([data-tff-section]) [aria-label="Default"]') !== null, true);
});

test('drawer scans are idempotent and rebuild after unmount with current state', async () => {
  const { window, document, subject } = load(display());
  subject.ensureFadeSection();
  let writes = 0;
  const observer = new window.MutationObserver(records => { writes += records.length; });
  observer.observe(document.body, { childList: true, subtree: true });
  subject.ensureFadeSection();
  subject.ensureFadeSection();
  await Promise.resolve();
  assert.equal(writes, 0);
  observer.disconnect();
  document.querySelector('[data-tff-row="watched"] [aria-label="Off"]').click();
  document.querySelector('.pane').remove();
  document.body.insertAdjacentHTML('beforeend', display());
  subject.ensureFadeSection();
  assert.equal(document.querySelector('[data-tff-row="watched"] [aria-label="Off"]').getAttribute('aria-checked'), 'true');
  window.history.replaceState(null, '', '?mode=movie');
  subject.ensureFadeSection();
  assert.equal(document.querySelector('[data-tff-row="started"]').style.display, 'none');
  window.history.replaceState(null, '', '?mode=show');
  subject.ensureFadeSection();
  assert.equal(document.querySelector('[data-tff-row="started"]').style.display, '');
});

test('legacy checkbox drawers still work and unsupported open drawers warn once', () => {
  const { window, document, subject, saved } = load(display(true));
  subject.ensureFadeSection();
  const input = document.querySelector('[data-tff-row="watched"] input');
  input.checked = false;
  input.dispatchEvent(new window.Event('change'));
  document.querySelector('[aria-label="Set filters as default"]').click();
  assert.equal(saved[0].value.watched, false);
  for (const html of ['', '<button aria-label="Set filters as default"></button>', display().replaceAll('role="radio"', 'role="unknown"')]) {
    const fixture = load(html);
    fixture.subject.ensureFadeSection();
    fixture.subject.ensureFadeSection();
    assert.equal(fixture.warnings.length, html ? 1 : 0);
  }
});
