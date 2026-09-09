const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initSeasonLists() {');
const end = source.indexOf('\n  })();', start) + '\n  })();'.length;

assert.ok(start >= 0 && end > start, 'Season feature must exist');

function createWindow(t) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="trakt-card"><button class="trakt-popup-menu-button" aria-expanded="true">Season menu</button><a href="/shows/taskmaster-nz?season=2">Season 2</a></div><div class="trakt-popup-menu-container"><ul style="max-height: 120px"><li role="button" tabindex="0"><div class="item-icon"><svg></svg></div><div class="item-label"><p>Report</p></div></li></ul></div></body></html>', { url: 'https://app.trakt.tv/shows/taskmaster-nz?season=1', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  return w;
}

test('season picker preserves identity and serializes writes across reopen and retry', async t => {
  const w = createWindow(t);
  let member = false;
  let release;
  let mutationCount = 0;
  let rejectWrite = false;
  const posts = [];
  const callbacks = [];
  const response = body => ({ ok: true, json: async () => body, headers: { get: () => '1' } });
  Object.assign(w, {
    scanCallbacks: callbacks,
    queueScan() {},
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    readAuth: () => ({ token: 'fixture' }),
    notifyMutation: () => { mutationCount++; },
    quickLists: { bumpInvalidationMarker() {} },
    apiGet: async (auth, url) => {
      if (url.pathname.endsWith('/seasons')) return response([{ number: 2, ids: { trakt: 262805 } }]);
      if (url.pathname === '/users/me/lists') return response([{ name: '<b>My list</b>', ids: { trakt: 7 } }]);
      assert.equal(url.pathname, '/users/me/lists/7/items/season');
      return response(member ? [{ type: 'season', season: { ids: { trakt: 262805 } } }] : []);
    },
    apiPost: async (auth, url, payload) => {
      posts.push({ path: url.pathname, payload: JSON.parse(JSON.stringify(payload)) });
      await new Promise(resolve => { release = resolve; });
      if (rejectWrite) throw new Error('Request timed out');
      member = !url.pathname.endsWith('/remove');
      return response(member ? { added: { seasons: 1 } } : { deleted: { seasons: 1 } });
    },
  });
  w.eval(source.slice(start, end));
  const scan = () => callbacks.forEach(callback => callback());
  const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const trigger = w.document.querySelector('button');
  trigger.click();
  scan();
  const entry = w.document.querySelector('[data-season-lists-entry]');
  assert.ok(entry);
  for (let i = 0; i < 10; i++) scan();
  assert.equal(w.document.querySelectorAll('[data-season-lists-entry]').length, 1);
  assert.equal(entry.querySelector('p').textContent, 'Manage lists...');
  entry.click();
  await drain();
  let row = w.document.querySelector('.season-list-row');
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  assert.equal(row.querySelector('b'), null, 'List name must be plain text');
  assert.equal(w.document.querySelector('.trakt-popup-menu-container').style.display, 'none');
  row.click();
  row.click();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { path: '/users/me/lists/7/items', payload: { seasons: [{ ids: { trakt: 262805 } }] } });
  w.document.querySelector('dialog').close();
  entry.click();
  await drain();
  row = w.document.querySelector('.season-list-row');
  assert.equal(row.disabled, true, 'Reopen waits for an outstanding write');
  release();
  await drain();
  assert.equal(row.getAttribute('aria-pressed'), 'true');
  row.click();
  release();
  await drain();
  assert.equal(posts[1].path, '/users/me/lists/7/items/remove');
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  assert.equal(mutationCount, 2);
  rejectWrite = true;
  row.click();
  release();
  await drain();
  assert.equal(row.getAttribute('aria-pressed'), null);
  assert.equal(row.querySelector('.season-list-state').textContent, 'Retry');
  assert.equal(row.disabled, false);
  const beforeRetry = posts.length;
  row.click();
  await drain();
  assert.equal(posts.length, beforeRetry, 'Retry must only read after an uncertain write');
  assert.equal(row.getAttribute('aria-pressed'), 'false');
  rejectWrite = false;
  w.document.querySelector('dialog').close();
  w.document.querySelector('a').href = '/shows/taskmaster-nz?season=3';
  scan();
  assert.equal(w.document.querySelector('[data-season-lists-entry]').getAttribute('aria-label'), 'Manage lists for Season 3');
  entry.click();
  assert.equal(w.document.querySelector('dialog'), null, 'A stale captured entry must not open the previous season');
  w.document.querySelector('a').href = '/shows/taskmaster-nz?season=2&episode=1';
  trigger.click();
  scan();
  assert.equal(w.document.querySelector('[data-season-lists-entry]'), null);
  assert.equal(w.document.querySelector('ul').style.maxHeight, '120px');
});

test('catalog cache renders immediately, reconciles rows, and bounds fresh membership reads', async t => {
  const w = createWindow(t);
  const lists = [];
  const memberships = [];
  const scans = [];
  let token = 'first-account';
  let active = 0;
  let maximumActive = 0;
  const response = body => ({ json: async () => body, headers: { get: () => '1' } });
  function deferred(queue) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { resolve: value => { item.settled = true; resolve(value); }, reject, settled: false };
    queue.push(item);
    return promise;
  }
  Object.assign(w, {
    scanCallbacks: scans,
    queueScan() {},
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    readAuth: () => ({ token }),
    apiGet: async (auth, url) => {
      if (url.pathname.endsWith('/seasons')) return response([{ number: 2, ids: { trakt: 262805 } }]);
      if (url.pathname === '/users/me/lists') return deferred(lists);
      assert.match(url.pathname, /^\/users\/me\/lists\/\d+\/items\/season$/);
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await deferred(memberships);
      } finally {
        active--;
      }
    },
    apiPost: () => { throw new Error('Catalog refresh must never write'); },
  });
  w.eval(source.slice(start, end));
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const open = () => {
    w.document.querySelector('.trakt-popup-menu-button').click();
    scans.forEach(scan => scan());
    w.document.querySelector('[data-season-lists-entry]').click();
  };
  const rows = () => [...w.document.querySelectorAll('.season-list-row')];
  const close = () => w.document.querySelector('dialog').close();
  const metadata = (id, name = 'List ' + id) => ({ name, ids: { trakt: id } });
  async function finishMemberships() {
    for (let batch = 0; batch < 4; batch++) {
      memberships.filter(item => !item.settled).forEach(item => item.resolve(response([])));
      await settle();
    }
    assert.equal(active, 0);
  }

  open();
  assert.equal(rows().length, 0);
  close();
  open();
  assert.equal(lists.length, 1, 'Reopening shares an outstanding catalog read');
  lists[0].resolve(response([1, 2, 3, 4, 5, 6].map(id => metadata(id))));
  await settle();
  assert.equal(rows().length, 6, 'All metadata rows render before slow membership reads finish');
  assert.equal(memberships.length, 4);
  assert.ok(rows().every(row => row.disabled));
  await finishMemberships();
  assert.equal(memberships.length, 6);
  assert.equal(maximumActive, 4);
  assert.ok(rows().every(row => row.getAttribute('aria-pressed') === 'false'));
  close();

  open();
  const cached = rows();
  assert.equal(cached.length, 6, 'Cached metadata renders synchronously on open');
  assert.ok(cached.every(row => row.disabled), 'Catalog cache cannot supply membership');
  assert.equal(memberships.length, 6, 'Wait for catalog validation before checking membership');
  lists[1].resolve(response([metadata(6), metadata(1, 'Renamed'), metadata(7)]));
  await settle();
  assert.equal(rows().length, 3);
  assert.equal(rows()[0], cached[5], 'Retained rows are moved without recreation');
  assert.equal(rows()[1], cached[0], 'Renaming preserves the existing row');
  assert.equal(rows()[1].firstChild.textContent, 'Renamed');
  assert.equal(cached[1].isConnected, false);
  assert.equal(rows()[2].firstChild.textContent, 'List 7');
  assert.equal(memberships.length, 9, 'Each reopen checks membership afresh');
  await finishMemberships();
  close();

  open();
  const retained = rows();
  assert.equal(retained.length, 3);
  lists[2].reject(new Error('HTTP 503'));
  await settle();
  assert.ok(rows().every(row => row.disabled));
  assert.equal(rows()[0], retained[0], 'Failed refresh retains cached rows');
  assert.match(w.document.querySelector('[role="status"]').textContent, /Could not load lists/);
  const retry = w.document.querySelector('[data-season-list-rows]').nextElementSibling;
  assert.equal(retry.hidden, false);
  retry.click();
  lists[3].resolve(response([metadata(6), metadata(1, 'Renamed'), metadata(7)]));
  await settle();
  assert.equal(rows()[0], retained[0], 'Unchanged catalog retry preserves row identity');
  await finishMemberships();
  close();

  token = 'second-account';
  open();
  assert.equal(rows().length, 0, 'Another account must not see cached personal list names');
  lists[4].resolve(response([]));
  await settle();
  assert.equal(rows().length, 0);
  assert.match(w.document.querySelector('[role="status"]').textContent, /No personal lists yet/);
});

for (const nextToken of ['second-account', null]) {
  test('failed catalog retry clears prior account rows for ' + (nextToken || 'signed-out state'), async t => {
    const w = createWindow(t);
    const scans = [];
    let token = 'first-account';
    let failCatalog = false;
    const response = body => ({ json: async () => body, headers: { get: () => '1' } });
    Object.assign(w, {
      scanCallbacks: scans,
      queueScan() {},
      apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
      readAuth: () => token ? { token } : null,
      apiGet: async (auth, url) => {
        if (url.pathname.endsWith('/seasons')) return response([{ number: 2, ids: { trakt: 262805 } }]);
        if (url.pathname === '/users/me/lists') {
          if (failCatalog) throw new Error('HTTP 503');
          return response([{ name: 'First account private list', ids: { trakt: 7 } }]);
        }
        return response([]);
      },
    });
    w.eval(source.slice(start, end));
    const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
    const open = () => {
      w.document.querySelector('.trakt-popup-menu-button').click();
      scans.forEach(scan => scan());
      w.document.querySelector('[data-season-lists-entry]').click();
    };
    open();
    await settle();
    w.document.querySelector('dialog').close();
    failCatalog = true;
    open();
    await settle();
    assert.equal(w.document.querySelector('.season-list-row').firstChild.textContent, 'First account private list');
    token = nextToken;
    w.document.querySelector('[data-season-list-rows]').nextElementSibling.click();
    assert.equal(w.document.querySelectorAll('.season-list-row').length, 0, 'Foreign rows must disappear before the network settles');
    await settle();
    assert.equal(w.document.querySelectorAll('.season-list-row').length, 0);
    assert.match(w.document.querySelector('[role="status"]').textContent, nextToken ? /HTTP 503/ : /Sign in to Trakt/);
  });
}

test('row retries share the initial membership concurrency limit', async t => {
  const w = createWindow(t);
  const scans = [];
  const reads = [];
  let active = 0;
  let maximum = 0;
  const response = body => ({ json: async () => body, headers: { get: () => '1' } });
  Object.assign(w, {
    scanCallbacks: scans,
    queueScan() {},
    readAuth: () => ({ token: 'account' }),
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    apiGet: async (auth, url) => {
      if (url.pathname.endsWith('/seasons')) return response([{ number: 2, ids: { trakt: 262805 } }]);
      if (url.pathname === '/users/me/lists') return response([1, 2, 3, 4, 5, 6].map(id => ({ name: 'List ' + id, ids: { trakt: id } })));
      active++;
      maximum = Math.max(maximum, active);
      try {
        return await new Promise((resolve, reject) => {
          const request = {
            settled: false,
            resolve: () => { request.settled = true; resolve(response([])); },
            reject: () => { request.settled = true; reject(new Error('HTTP 503')); },
          };
          reads.push(request);
        });
      } finally {
        active--;
      }
    },
  });
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  w.eval(source.slice(start, end));
  w.document.querySelector('.trakt-popup-menu-button').click();
  scans.forEach(scan => scan());
  w.document.querySelector('[data-season-lists-entry]').click();
  await settle();
  assert.equal(active, 4);
  reads[0].reject();
  await settle();
  const row = w.document.querySelector('.season-list-row');
  assert.equal(active, 4);
  assert.equal(row.disabled, false);
  row.click();
  await settle();
  assert.equal(active, 4, 'Retry waits for capacity instead of starting a fifth request');
  assert.equal(row.disabled, true);
  for (let batch = 0; batch < 4; batch++) {
    reads.filter(read => !read.settled).forEach(read => read.resolve());
    await settle();
  }
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(reads.length, 7, 'All six initial checks and the queued retry complete');
  assert.equal(row.disabled, false);
  assert.equal(row.getAttribute('aria-pressed'), 'false');
});
