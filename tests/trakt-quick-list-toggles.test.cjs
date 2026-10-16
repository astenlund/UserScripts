const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initQuickListToggles() {');
const end = source.indexOf('\n  })();', start);
assert.ok(start >= 0 && end > start);
const feature = source.slice(start, end + '\n  })();'.length);

const TITLE = 'Treasure Island';
const MANAGE_LISTS = 'Manage lists' + String.fromCharCode(8230);
const KEY = 'show:treasure-island-2026';
const LIST_IDS = { Anticipated: 11, Uninterested: 22 };
const APP_CHECK = '<path d="M7.5 12.5L10.5 15.5L16.5 9" stroke="var(--checkbox-icon-check-color, var(--color-option-list-background))" stroke-width="2" fill="currentColor"></path>';

// Summary actions menu as observed 2026-10-17: an outer wrapper and the
// inner menu share the class, and the rows sit in a ul group.
function summaryMenu() {
  const row = text => `<li role="button" tabindex="0" data-color="default" disabled="false"><div class="item-icon"><svg width="24" height="24"><path fill="currentColor"></path></svg></div><div class="item-label"><p class="bold">${text}</p></div></li>`;
  return `<div class="trakt-summary-title"><h1>${TITLE}</h1></div>
    <div class="trakt-summary-actions"><div class="trakt-summary-actions-bar"><div class="trakt-summary-actions-slider">
    <div class="trakt-summary-actions"><ul class="trakt-dropdown-group">${row(MANAGE_LISTS)}${row('Share')}</ul></div>
    </div></div></div>`;
}

// Checkbox drawer row as observed 2026-10-17: the app renders its
// checkmark path only while it believes the row is a member.
function drawerRow(name, checked) {
  const label = checked ? `Remove "${TITLE}" from ${name}` : `Add "${TITLE}" to ${name}`;
  return `<li role="button" tabindex="0" data-color="default" label='${label}' aria-pressed="${checked}" disabled="false"><div class="item-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" stroke-width="2" fill="${checked ? 'currentColor' : 'transparent'}"></rect>${checked ? APP_CHECK : ''}<!----></svg></div><div class="item-label"><p class="bold capitalize ellipsis">${name}</p></div></li>`;
}

function drawer(appChecked) {
  const watchlist = `<li role="button" tabindex="0" label='Add "${TITLE}" to your Watchlist'><div class="item-icon"><svg><path class="trakt-bookmark-path" fill="transparent"></path></svg></div><div class="item-label"><p>Watchlist</p></div></li>`;
  return `<div class="trakt-drawer"><ul>${watchlist}</ul><ul>${drawerRow('Uninterested', false)}${drawerRow('Anticipated', appChecked)}</ul></div>`;
}

// With liveScans, queueScan schedules real scans and a body childList
// observer queues them, mirroring the script's shared plumbing, so the
// feature's own observers drive re-assertion as they do in the page.
// Scheduling stops at SCAN_CAP, so a scan loop fails its test's cap
// assertion instead of keeping the process alive.
const SCAN_CAP = 100;

function load(html, { anticipated = [], liveScans = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://app.trakt.tv/shows/treasure-island-2026?season=1', runScripts: 'outside-only' });
  const { window } = dom;
  const members = { Anticipated: new Set(anticipated), Uninterested: new Set() };
  const targets = { ...LIST_IDS };
  const posts = [];
  const scanCallbacks = [];
  let scans = 0;
  let queued = false;
  const scan = () => {
    scans++;
    scanCallbacks.forEach(callback => callback());
  };
  const queueScan = () => {
    if (!liveScans || queued || scans >= SCAN_CAP) return;
    queued = true;
    window.setTimeout(() => {
      queued = false;
      scan();
    }, 0);
  };
  Object.assign(window, {
    QUICK_LIST_NAMES: ['Anticipated', 'Uninterested'],
    quickLists: {
      membershipState: () => 'fresh',
      refreshMembership() {},
      getListTarget: name => (name in targets ? { id: targets[name], has: key => members[name].has(key) } : null),
      applyListToggle(name, key, add) {
        if (add) {
          members[name].add(key);
        } else {
          members[name].delete(key);
        }
      },
      bumpInvalidationMarker() {},
      noteConfirmedWrite() {},
    },
    scanCallbacks,
    queueScan,
    notifyMutation() {},
    warn() {},
    mediaType: segment => ({ shows: 'show', movies: 'movie' })[segment],
    mediaPathSegment: type => (type === 'movie' ? 'movies' : 'shows'),
    readAuth: () => ({}),
    apiUrl: route => new window.URL(route, 'https://apiz.trakt.tv'),
    apiPost: async (auth, url, payload) => {
      posts.push({ path: url.pathname, payload: JSON.parse(JSON.stringify(payload)) });
      return { ok: true, status: 200, json: async () => ({ added: { shows: 1 } }) };
    },
  });
  window.eval(feature);
  const { document } = window;
  if (liveScans) {
    new window.MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
  }
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const openDrawer = () => click([...document.querySelectorAll('div.trakt-summary-actions li')].find(li => li.textContent.includes('Manage lists')));
  const row = name => [...document.querySelectorAll('div.trakt-drawer li')].find(li => li.querySelector('p').textContent === name);
  return { window, document, scan, scans: () => scans, click, openDrawer, row, posts, members, targets };
}

// Every carrier the app keeps in step for one row, read back as the user
// would see it: which check glyph is visible and how the row announces.
function rowState(row) {
  const appCheck = row.querySelector('path:not([data-mlrt-check])');
  const ownCheck = row.querySelector('[data-mlrt-check]');
  return {
    verb: row.getAttribute('label').split(' ')[0],
    pressed: row.getAttribute('aria-pressed'),
    box: row.querySelector('rect').getAttribute('fill'),
    appCheck: appCheck ? (appCheck.style.display === 'none' ? 'hidden' : 'shown') : 'absent',
    ownCheck: ownCheck !== null,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// Enough timer turns for observer callbacks and the scans they queue to
// run to quiescence.
async function settle() {
  for (let i = 0; i < 10; i++) {
    await flush();
  }
}

test('removing through a drawer row the app shows checked unchecks every carrier', async () => {
  // Arrange
  const { scan, click, openDrawer, row, posts } = load(summaryMenu() + drawer(true), { anticipated: [KEY] });
  openDrawer();
  scan();
  const anticipated = row('Anticipated');
  assert.deepEqual(rowState(anticipated), { verb: 'Remove', pressed: 'true', box: 'currentColor', appCheck: 'shown', ownCheck: false });

  // Act
  const notCancelled = click(anticipated);
  await flush();
  scan();

  // Assert
  assert.equal(notCancelled, false);
  assert.deepEqual(posts, [{ path: '/users/me/lists/11/items/remove', payload: { shows: [{ ids: { slug: 'treasure-island-2026' } }] } }]);
  assert.deepEqual(rowState(anticipated), { verb: 'Add', pressed: 'false', box: 'transparent', appCheck: 'hidden', ownCheck: false });
  assert.equal(anticipated.getAttribute('label'), `Add "${TITLE}" to Anticipated`);
});

test('a member row the app shows unchecked gets the script check until the app draws its own', () => {
  // Arrange
  const { window, document, scan, openDrawer, row } = load(summaryMenu() + drawer(false), { anticipated: [KEY] });
  openDrawer();
  scan();
  const anticipated = row('Anticipated');
  const observer = new window.MutationObserver(() => {});
  observer.observe(document.querySelector('div.trakt-drawer'), { subtree: true, childList: true, attributes: true });

  // Act
  scan();
  const settledWrites = observer.takeRecords().length;
  anticipated.querySelector('svg').insertAdjacentHTML('afterbegin', APP_CHECK);
  scan();

  // Assert
  assert.equal(settledWrites, 0);
  assert.deepEqual(rowState(anticipated), { verb: 'Remove', pressed: 'true', box: 'currentColor', appCheck: 'shown', ownCheck: false });
  assert.deepEqual(rowState(row('Uninterested')), { verb: 'Add', pressed: 'false', box: 'transparent', appCheck: 'absent', ownCheck: false });
});

test('the script check copies the app glyph', () => {
  // Arrange
  const { scan, openDrawer, row } = load(summaryMenu() + drawer(false), { anticipated: [KEY] });
  openDrawer();

  // Act
  scan();

  // Assert
  const own = row('Anticipated').querySelector('[data-mlrt-check]');
  const app = new JSDOM(`<svg>${APP_CHECK}</svg>`).window.document.querySelector('path');
  for (const name of ['d', 'stroke', 'stroke-width', 'fill']) {
    assert.equal(own.getAttribute(name), app.getAttribute(name));
  }
  assert.equal(own.namespaceURI, 'http://www.w3.org/2000/svg');
});

test('a row whose list de-resolves hands back showing the app belief and clicks natively', () => {
  // Arrange
  const { scan, click, openDrawer, row, posts, targets } = load(summaryMenu() + drawer(true));
  openDrawer();
  scan();
  const anticipated = row('Anticipated');
  assert.deepEqual(rowState(anticipated), { verb: 'Add', pressed: 'false', box: 'transparent', appCheck: 'hidden', ownCheck: false });

  // Act
  delete targets.Anticipated;
  scan();
  const notCancelled = click(anticipated);

  // Assert
  assert.equal(anticipated.hasAttribute('data-mlrt-item'), false);
  assert.deepEqual(rowState(anticipated), { verb: 'Remove', pressed: 'true', box: 'currentColor', appCheck: 'shown', ownCheck: false });
  assert.equal(notCancelled, true);
  assert.deepEqual(posts, []);
});

test('a row showing another item hands back the app belief whichever item its marker names', () => {
  // Arrange
  const captureMiss = load(summaryMenu() + drawer(true));
  const itemSwitch = load(summaryMenu() + drawer(true));
  for (const { scan, openDrawer } of [captureMiss, itemSwitch]) {
    openDrawer();
    scan();
  }
  const missRow = captureMiss.row('Anticipated');
  const switchRow = itemSwitch.row('Anticipated');
  const painted = [rowState(missRow), rowState(switchRow)];

  // Act
  missRow.setAttribute('label', 'Remove "Other Show" from Anticipated');
  captureMiss.scan();
  itemSwitch.window.history.pushState(null, '', '/shows/other-show');
  itemSwitch.document.querySelector('.trakt-summary-title h1').textContent = 'Other Show';
  itemSwitch.openDrawer();
  itemSwitch.scan();

  // Assert
  const unchecked = { verb: 'Add', pressed: 'false', box: 'transparent', appCheck: 'hidden', ownCheck: false };
  assert.deepEqual(painted, [unchecked, unchecked]);
  for (const [{ click, posts }, row] of [[captureMiss, missRow], [itemSwitch, switchRow]]) {
    assert.equal(row.hasAttribute('data-mlrt-item'), false);
    assert.deepEqual(rowState(row), { verb: 'Remove', pressed: 'true', box: 'currentColor', appCheck: 'shown', ownCheck: false });
    assert.equal(click(row), true);
    assert.deepEqual(posts, []);
  }
});

test('app patches to the label, aria-pressed or box fill are re-asserted and scans settle', async () => {
  // Arrange
  const { openDrawer, row, scans } = load(summaryMenu() + drawer(true), { liveScans: true });
  openDrawer();
  await settle();
  const anticipated = row('Anticipated');
  const painted = rowState(anticipated);

  // Act
  anticipated.setAttribute('aria-pressed', 'true');
  await settle();
  const afterPressed = rowState(anticipated);
  anticipated.querySelector('rect').setAttribute('fill', 'currentColor');
  await settle();
  const afterFill = rowState(anticipated);
  anticipated.setAttribute('label', `Remove "${TITLE}" from Anticipated`);
  await settle();
  const afterLabel = rowState(anticipated);
  const settledScans = scans();
  await settle();

  // Assert
  const unchecked = { verb: 'Add', pressed: 'false', box: 'transparent', appCheck: 'hidden', ownCheck: false };
  assert.deepEqual(painted, unchecked);
  assert.deepEqual(afterPressed, unchecked);
  assert.deepEqual(afterFill, unchecked);
  assert.deepEqual(afterLabel, unchecked);
  assert.ok(settledScans < SCAN_CAP);
  assert.equal(scans(), settledScans);
});

test('the app drawing or dropping its checkmark is reconciled through the body observer', async () => {
  // Arrange
  const { openDrawer, row, scans } = load(summaryMenu() + drawer(false), { anticipated: [KEY], liveScans: true });
  openDrawer();
  await settle();
  const anticipated = row('Anticipated');
  const painted = rowState(anticipated);

  // Act
  anticipated.querySelector('rect').insertAdjacentHTML('afterend', APP_CHECK);
  await settle();
  const appDrawn = rowState(anticipated);
  anticipated.querySelector('path:not([data-mlrt-check])').remove();
  await settle();
  const appDropped = rowState(anticipated);
  const settledScans = scans();
  await settle();

  // Assert
  const checked = { verb: 'Remove', pressed: 'true', box: 'currentColor' };
  assert.deepEqual(painted, { ...checked, appCheck: 'absent', ownCheck: true });
  assert.deepEqual(appDrawn, { ...checked, appCheck: 'shown', ownCheck: false });
  assert.deepEqual(appDropped, { ...checked, appCheck: 'absent', ownCheck: true });
  assert.ok(settledScans < SCAN_CAP);
  assert.equal(scans(), settledScans);
});

test('summary menu entries lead the grouped rows exactly once', () => {
  // Arrange
  const { document, scan } = load(summaryMenu(), { anticipated: [KEY] });

  // Act
  scan();
  scan();

  // Assert
  const group = document.querySelector('ul.trakt-dropdown-group');
  const rows = [...group.children].map(li => li.getAttribute('data-qlt-list') ?? li.textContent.trim());
  assert.deepEqual(rows, ['Anticipated', 'Uninterested', MANAGE_LISTS, 'Share']);
  assert.equal(document.querySelectorAll('[data-qlt-entry]').length, 2);
  assert.equal(group.querySelector('[data-qlt-list="Anticipated"]').getAttribute('data-qlt-member'), '1');
});
