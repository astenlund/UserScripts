const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  (function initSeasonLists() {');
const end = source.indexOf('\n  })();', start) + 1;
assert.ok(start >= 0 && end > start, 'Season feature must exist');
const feature = source.slice(start, end) + 'globalThis.subject = { seasonFromUrl, seasonMembership, writeSucceeded, readPages }; })();';

function load(apiGet = async () => { throw new Error('Unexpected request'); }) {
  const context = vm.createContext({
    URL,
    location: { origin: 'https://app.trakt.tv' },
    document: { addEventListener() {} },
    scanCallbacks: [],
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    apiGet,
  });
  vm.runInContext(feature, context);
  return context.subject;
}

function response(items, pages = null) {
  return { json: async () => items, headers: { get: () => pages } };
}

test('season identity comes from the card URL, including specials', () => {
  const { seasonFromUrl } = load();
  for (const number of [0, 1, 2, 12]) {
    const item = seasonFromUrl('/shows/taskmaster-nz?view=seasons&season=' + number);
    assert.equal(item.slug, 'taskmaster-nz');
    assert.equal(item.number, number);
  }
});

test('episodes, shows, foreign URLs and ambiguous season numbers are excluded', () => {
  const { seasonFromUrl } = load();
  for (const href of [
    '/shows/taskmaster-nz',
    '/shows/taskmaster-nz?season=2&episode=1',
    '/shows/taskmaster-nz?season=2&episode=',
    '/movies/example?season=2',
    'https://example.com/shows/taskmaster-nz?season=2',
    '/shows/taskmaster-nz/related?season=2',
    ...['', '-1', '1.5', '02', 'NaN', '9007199254740992', '2&season=3'].map(value => '/shows/taskmaster-nz?season=' + value),
  ]) assert.equal(seasonFromUrl(href), null, href);
});

test('membership uses the season ID rather than the parent show or season number', () => {
  const { seasonMembership } = load();
  const items = [{ type: 'season', season: { number: 2, ids: { trakt: 262805 } }, show: { ids: { trakt: 123 } } }];
  assert.equal(seasonMembership(items, 262805), true);
  assert.equal(seasonMembership(items, 123), false);
  assert.equal(seasonMembership(items, 2), false);
  assert.equal(seasonMembership([], 262805), false);
  assert.throws(() => seasonMembership([{ type: 'show', show: { ids: { trakt: 262805 } } }], 262805));
  assert.throws(() => seasonMembership([{ type: 'season', season: {} }], 262805));
});

test('write success requires a season result and rejects not-found seasons', () => {
  const { writeSucceeded } = load();
  assert.equal(writeSucceeded({ added: { seasons: 1 } }, true), true);
  assert.equal(writeSucceeded({ existing: { seasons: 1 } }, true), true);
  assert.equal(writeSucceeded({ deleted: { seasons: 1 } }, false), true);
  for (const body of [null, {}, { added: { shows: 1 } }, { added: { seasons: 0 } }, { added: { seasons: 1 }, not_found: { seasons: [{}] } }]) {
    assert.equal(writeSucceeded(body, true), false);
  }
  assert.equal(writeSucceeded({ deleted: { seasons: 0 } }, false), false);
});

test('membership pagination reads later pages even when an earlier batch is short', async () => {
  const calls = [];
  const { readPages, seasonMembership } = load(async (auth, url) => {
    calls.push(url);
    return response([{ type: 'season', season: { ids: { trakt: Number(url.searchParams.get('page')) } } }], '2');
  });
  const result = await readPages({}, '/users/me/lists/7/items/season');
  assert.equal(seasonMembership(result, 2), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.searchParams.get('limit') === '1000' && url.searchParams.has('marker')));
});

test('broken pagination or transport cannot become an empty membership result', async () => {
  for (const get of [
    async () => response([], '2'),
    async () => response([], 'unknown'),
    async () => response([{}], '0'),
    async () => response({}, '1'),
    async () => { throw new Error('HTTP 401'); },
  ]) await assert.rejects(load(get).readPages({}, '/users/me/lists'));
  assert.equal((await load(async () => response([], '0')).readPages({}, '/users/me/lists')).length, 0);
});
