const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'trakt_improved.user.js'), 'utf8');
const start = source.indexOf('  const seasonProgress = (function initSeasonProgress() {');
const end = source.indexOf('  // Season subtitles identify', start);
assert.ok(start >= 0 && end > start);
const feature = source.slice(start, end) + 'globalThis.subject = seasonProgress;';
const drain = () => new Promise(resolve => setImmediate(resolve));

function load() {
  const state = { token: 'account-a', stamp: 1, now: 1000, scans: 0 };
  const requests = [];
  const context = vm.createContext({
    URL, Date: { now: () => state.now },
    readAuth: () => state.token === null ? null : { token: state.token },
    membership: { watchedStamp: () => state.stamp },
    apiUrl: route => new URL(route, 'https://apiz.trakt.tv'),
    apiGet: (auth, url) => new Promise((resolve, reject) => requests.push({ auth, url, resolve: body => resolve({ json: async () => body }), reject })),
    queueScan: () => { state.scans++; },
  });
  vm.runInContext(feature, context);
  return { category: context.subject.category, state, requests };
}

function progress() {
  return { seasons: [
    { number: 0, aired: 2, completed: 2 },
    { number: 1, aired: 10, completed: 10 },
    { number: 2, aired: 10, completed: 3 },
    { number: 3, aired: 10, completed: 0 },
    { number: 4, aired: 0, completed: 0 },
  ] };
}

test('one on-demand request classifies each season by its own aired completion', async () => {
  const { category, requests } = load();
  assert.equal(category('taskmaster', '1'), null);
  assert.equal(category('taskmaster', '2'), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/shows/taskmaster/progress/watched');
  for (const key of ['hidden', 'specials']) assert.equal(requests[0].url.searchParams.get(key), 'true');
  assert.equal(requests[0].url.searchParams.get('count_specials'), 'false');
  assert.equal(requests[0].url.searchParams.has('marker'), true);
  requests[0].resolve(progress());
  await drain();
  for (const [number, expected] of [['0', 'watched'], ['1', 'watched'], ['2', 'started'], ['3', null], ['4', null], ['9', null]]) {
    assert.equal(category('taskmaster', number), expected);
  }
  assert.equal(requests.length, 1);
});

test('progress expires and a watched refresh invalidates it immediately', async () => {
  const { category, requests, state } = load();
  category('taskmaster', '1');
  requests[0].resolve(progress());
  await drain();
  state.now += 15 * 60 * 1000;
  assert.equal(category('taskmaster', '1'), null);
  assert.equal(requests.length, 2);
  requests[1].resolve(progress());
  await drain();
  state.stamp++;
  assert.equal(category('taskmaster', '1'), null);
  assert.equal(requests.length, 3);
});

test('account changes and stale in-flight responses cannot reuse another account progress', async () => {
  const { category, requests, state } = load();
  category('taskmaster', '1');
  state.token = 'account-b';
  category('taskmaster', '1');
  requests[0].resolve(progress());
  await drain();
  assert.equal(category('taskmaster', '1'), null);
  requests[1].resolve({ seasons: [{ number: 1, aired: 10, completed: 2 }] });
  await drain();
  assert.equal(category('taskmaster', '1'), 'started');
  state.token = null;
  assert.equal(category('taskmaster', '1'), null);
  assert.equal(requests.length, 2);
});

test('malformed responses and transport failure stay unknown with retry backoff', async () => {
  for (const body of [null, {}, { seasons: [{ number: 1, aired: null, completed: 2 }] },
    { seasons: [{ number: 1, aired: 10, completed: -1 }] },
    { seasons: [{ number: 1, aired: 10, completed: 1 }, { number: 1, aired: 10, completed: 2 }] }, 'transport']) {
    const { category, requests, state } = load();
    category('taskmaster', '1');
    if (body === 'transport') requests[0].reject(new Error('HTTP 429'));
    else requests[0].resolve(body);
    await drain();
    assert.equal(category('taskmaster', '1'), null);
    assert.equal(requests.length, 1);
    state.now += 60000;
    category('taskmaster', '1');
    assert.equal(requests.length, 2);
  }
});

test('requests are concurrency bounded and fresh cache entries cannot churn after reaching capacity', async () => {
  const { category, requests } = load();
  for (let i = 0; i < 5; i++) category('show-' + i, '1');
  assert.equal(requests.length, 4);
  requests.forEach(request => request.resolve(progress()));
  await drain();
  for (let i = 4; i < 100; i++) {
    category('show-' + i, '1');
    requests.at(-1).resolve(progress());
    await drain();
  }
  assert.equal(requests.length, 100);
  category('show-overflow', '1');
  assert.equal(requests.length, 100);
  assert.equal(category('show-0', '1'), 'watched');
});

test('whole-show buckets no longer carry season keys or classify unwatched shows as started', () => {
  const splitStart = source.indexOf('      function splitWatchedShows(items, progress) {');
  const splitEnd = source.indexOf('      function movieSlugs', splitStart);
  const context = vm.createContext({});
  vm.runInContext(source.slice(splitStart, splitEnd) + 'globalThis.split = splitWatchedShows;', context);
  const items = [{ show: { ids: { trakt: 1, slug: 'taskmaster' }, aired_episodes: 100 } }];
  const result = context.split(items, { 1: { seen: 10, seasons: ['1'] } });
  assert.deepEqual([...result.started], ['show:taskmaster']);
  assert.equal(result.watched.length, 0);
  assert.equal(context.split(items, { 1: { seen: 0 } }).started.length, 0);
});
