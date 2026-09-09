const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initSeasonLists() {');
const end = source.indexOf('\n  })();', start) + '\n  })();'.length;

assert.ok(start >= 0 && end > start, 'Season feature must exist');

test('season picker preserves identity and serializes writes across reopen and retry', async t => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="trakt-card"><button class="trakt-popup-menu-button" aria-expanded="true">Season menu</button><a href="/shows/taskmaster-nz?season=2">Season 2</a></div><div class="trakt-popup-menu-container"><ul style="max-height: 120px"><li role="button" tabindex="0"><div class="item-icon"><svg></svg></div><div class="item-label"><p>Report</p></div></li></ul></div></body></html>', { url: 'https://app.trakt.tv/shows/taskmaster-nz?season=1', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
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
