const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('    const fetchers = (function initFetchers() {');
const returnAt = source.indexOf('      return { fetchAll, fetchAddedOrder,', start);
const end = source.indexOf('    })();', returnAt);
assert.ok(start >= 0 && returnAt > start && end > returnAt);
const feature = source.slice(start, end + '    })();'.length) + '\nglobalThis.subject = fetchers;';

const PAGE_SIZE = 250;

// added is the server's opaque date-added key (ties allowed); release
// stands in for a collection's own sort setting, such as release date.
function entry(id, { added = id, release = id } = {}) {
  return { id, type: 'show', listed_at: new Date(Date.UTC(2026, 0, 1) + added * 1000).toISOString(), added, release, show: { ids: { slug: `show-${id}` } } };
}

function entries(from, to, keys = () => ({})) {
  return Array.from({ length: to - from + 1 }, (_, i) => entry(from + i, keys(from + i)));
}

// Models the server cache measured live: page 1 of every read shape
// reflects the current collection, while every later page keeps serving
// the copy cached before the latest write. Date-added order breaks ties
// by id in both directions, so the two directions are not mirror images,
// as observed live.
function load(collections, { pageCountHeader = true, ignorePage = false } = {}) {
  const requests = [];
  const apiGet = async (auth, url) => {
    requests.push(url);
    const collection = collections[url.pathname];
    assert.ok(collection, `unexpected request for ${url.pathname}`);
    const page = ignorePage ? 1 : Number(url.searchParams.get('page') || 1);
    const limit = Math.min(Number(url.searchParams.get('limit') || 10), PAGE_SIZE);
    const items = page === 1 ? collection.fresh : collection.stale ?? collection.fresh;
    const how = url.searchParams.get('sort_how');
    const order = url.searchParams.get('sort_by') === 'added'
      ? (a, b) => (how === 'desc' ? b.added - a.added : a.added - b.added) || a.id - b.id
      : collection.defaultOrder ?? ((a, b) => a.added - b.added || a.id - b.id);
    const body = [...items].sort(order).slice((page - 1) * limit, page * limit);
    const pageCount = String(Math.ceil(items.length / limit));
    return {
      json: async () => JSON.parse(JSON.stringify(body)),
      headers: { get: name => (name === 'X-Pagination-Page-Count' && pageCountHeader ? pageCount : null) },
    };
  };
  const context = vm.createContext({
    URL,
    apiGet,
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    warn: () => {},
    QUICK_LIST_NAMES: ['Anticipated', 'Uninterested'],
  });
  vm.runInContext(feature, context);
  return { fetchers: context.subject, requests };
}

const ids = items => [...items.map(item => item.id)].sort((a, b) => a - b);
const shapes = requests => requests.map(url => `${url.searchParams.get('page')}:${url.searchParams.get('sort_how')}`);
const ITEMS = '/users/me/lists/7/items';

test('a collection that fits one page takes a single oldest-added request', async () => {
  const { fetchers, requests } = load({ [ITEMS]: { fresh: entries(1, 3) } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), [1, 2, 3]);
  assert.deepEqual(shapes(requests), ['1:asc']);
  assert.equal(requests[0].searchParams.get('sort_by'), 'added');
  assert.equal(requests[0].searchParams.has('marker'), true);
});

test('an add that lands past page 1 is read while later pages still serve the pre-write copy', async () => {
  const { fetchers, requests } = load({ [ITEMS]: { fresh: entries(1, 547), stale: entries(1, 546) } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(entries(1, 547)));
  assert.deepEqual(shapes(requests), ['1:asc', '2:asc', '3:asc', '1:desc']);
});

test('an add that the collection sort would insert mid-list costs no other entry', async () => {
  // Release order reverses id order, so the newest add sorts first and
  // would push an entry across the page-1 boundary of a release-sorted walk.
  const release = id => ({ release: -id });
  const defaultOrder = (a, b) => a.release - b.release;
  const { fetchers } = load({ [ITEMS]: { fresh: entries(1, 342, release), stale: entries(1, 341, release), defaultOrder } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(entries(1, 342)));
});

test('adds are found even when date-added ties keep the two directions from mirroring', async () => {
  const tied = id => ({ added: id <= 494 ? 1 : id });
  const { fetchers } = load({ [ITEMS]: { fresh: entries(1, 1001, tied), stale: entries(1, 1000, tied) } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(entries(1, 1001)));
});

test('a removal on page 1 drops, and entries it shifted are not duplicated', async () => {
  const before = entries(1, 547);
  const after = before.filter(item => item.id !== 10);
  const { fetchers } = load({ [ITEMS]: { fresh: after, stale: before } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(after));
  assert.equal(new Set(ids(items)).size, items.length);
});

test('a removal past page 1 reads stale until the server copy expires', async () => {
  const before = entries(1, 547);
  const after = before.filter(item => item.id !== 540);
  const { fetchers } = load({ [ITEMS]: { fresh: after, stale: before } });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.equal(items.some(item => item.id === 540), true);
  assert.equal(new Set(ids(items)).size, items.length);
});

test('without a page-count header the walk pages on by the server page size and still reads the newest page', async () => {
  const { fetchers, requests } = load({ [ITEMS]: { fresh: entries(1, 547), stale: entries(1, 546) } }, { pageCountHeader: false });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(entries(1, 547)));
  assert.deepEqual(shapes(requests), ['1:asc', '2:asc', '3:asc', '1:desc']);
});

test('without a page-count header a collection with date-added ties is read in full', async () => {
  // Every entry shares one date-added second, so both page-1 reads
  // return the same 250 entries and only the walk reaches the rest.
  const tied = () => ({ added: 1 });
  const { fetchers } = load({ [ITEMS]: { fresh: entries(1, 300, tied) } }, { pageCountHeader: false });
  const items = await fetchers.fetchAddedOrder({}, ITEMS);
  assert.deepEqual(ids(items), ids(entries(1, 300)));
});

test('a header-less server that ignores the page param fails instead of looping', async () => {
  const { fetchers, requests } = load({ [ITEMS]: { fresh: entries(1, 300) } }, { pageCountHeader: false, ignorePage: true });
  await assert.rejects(fetchers.fetchAddedOrder({}, ITEMS), /did not end within 100 pages/);
  assert.equal(requests.length, 100);
});

test('quick-list membership sees an add that lands past page 1 of the list', async () => {
  const lists = [{ name: 'Uninterested', ids: { trakt: 7, slug: 'uninterested' }, user: { ids: { slug: 'me' } } }];
  const { fetchers } = load({
    '/users/me/lists': { fresh: lists.map(list => Object.assign({ added: 0 }, list)) },
    [ITEMS]: { fresh: entries(1, 547), stale: entries(1, 546) },
  });
  const listed = await fetchers.fetchListedData({});
  assert.equal(listed.targets.Uninterested.slugs.includes('show:show-547'), true);
  assert.equal(listed.targets.Uninterested.fadeSlugs.includes('show:show-547'), true);
});
