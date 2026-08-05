# RT Page Bridge MVP (Link Verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify at resolution time that the Wikidata-bridged Rotten Tomatoes path actually belongs to the viewed title, demote dead or both-signals-wrong links to a title search, and record intermediate verdicts as `uncertain` in a widened cache entry.

**Architecture:** All changes live inside the `initExternalLinks` IIFE of `trakt_improved.user.js` (plus two userscript header lines). A new four-state `fetchRtPage` helper fetches and parses the RT page; pure functions implement the two-signal (year + title) match rule; `verifyRtPath` maps signals to verdicts and the widened cache write happens in `resolveIds`. Governing spec: `.claude/features/rt-page-bridge.md` (hardened, stamp at f57af45).

**Tech Stack:** Vanilla JS userscript (Tampermonkey), GM_xmlhttpRequest, DOMParser. No build process, no test framework; logic is verified with ephemeral node harnesses in `.tmp/` plus `node --check`.

## Global Constraints

- Never use em-dashes, en-dashes, emoticons, or emoji in code, comments, or commit messages. ASCII `--` in prose; dash codepoints appear only as escaped `\uXXXX` in regexes.
- `trakt_improved.user.js` is CRLF. Edit in place with the Edit tool (preserves line endings). Node harnesses that match multi-line anchors must strip `\r` from an in-memory copy used for matching/eval only, and must NEVER write that copy back.
- End every created file with a newline.
- Commits: Conventional Commits subject only (max 72 chars), no body, no Co-Authored-By trailer. One commit per task as specified; `.tmp/` files are never committed (the directory is ephemeral scratch, untracked).
- Tasks 1-5 all edit the same file: execute strictly sequentially, never in parallel.
- Work on the current branch (master) directly. Do NOT create a git worktree or a feature branch; commit on master.
- Comment style: comments explain constraints the code cannot show, matching the file's existing register. Never reference this plan or its task numbers anywhere.
- The three same-named `CACHE_VERSION` constants belong to different IIFEs; only the `initExternalLinks` copy (currently line 1640) is touched.

---

### Task 1: `fetchRtPage` four-state helper

**Files:**
- Modify: `trakt_improved.user.js` (userscript header, lines 1-16; and inside `initExternalLinks`, after `gmFetchJson` which ends near line 1725)

**Interfaces:**
- Consumes: existing `FETCH_TIMEOUT_MS` (shared constant, line 32 area), nothing else new.
- Produces: `async function fetchRtPage(rtPath)` returning exactly one of `{ status: 'ok', data: { name: string, year: number, critics: number|null, audience: number|null } }`, `{ status: 'not-found' }`, `{ status: 'parse-failure' }`, `{ status: 'error' }`. Never throws. Also `gmFetchText(url)` (resolves `{ status, text }`, rejects on network/timeout) and `parseRtPage(html)` / `parseScore(html, field)` used only by `fetchRtPage`.

- [ ] **Step 1: Add the `@connect` header line**

In the userscript header block at the top of `trakt_improved.user.js`, directly below the existing line `// @connect      www.wikidata.org`, add:

```javascript
// @connect      www.rottentomatoes.com
```

- [ ] **Step 2: Add the helper functions**

Insert immediately after the closing brace of `gmFetchJson` (after its `});` + `}` near line 1725), inside `initExternalLinks`:

```javascript
    // Text-body sibling of gmFetchJson. Resolves on any HTTP status (the
    // caller classifies), rejects only on network failure or timeout.
    function gmFetchText(url) {
      const hostname = new URL(url).hostname;
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: FETCH_TIMEOUT_MS,
          onload: r => resolve({ status: r.status, text: r.responseText }),
          ontimeout: () => reject(new Error(`Timeout from ${hostname}`)),
          onerror: () => reject(new Error(`Network error from ${hostname}`)),
        });
      });
    }

    function parseScore(html, field) {
      const m = html.match(new RegExp(`"${field}":\\{[^}]*"score":"(\\d{1,3})"`));
      if (!m) return null;
      const score = Number(m[1]);
      return score >= 0 && score <= 100 ? score : null;
    }

    // name and year are required for ok (the match rule must only ever
    // compare two real values); scores are optional, null on score-less or
    // unreleased titles.
    function parseRtPage(html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      let name = null;
      let year = null;
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data;
        try {
          data = JSON.parse(script.textContent);
        } catch {
          // Malformed ld+json block; keep looking.
          continue;
        }
        if (data && typeof data.name === 'string' && data.name && typeof data.dateCreated === 'string') {
          const parsedYear = Number(data.dateCreated.slice(0, 4));
          if (Number.isInteger(parsedYear) && parsedYear > 0) {
            name = data.name;
            year = parsedYear;
            break;
          }
        }
      }
      if (name === null || year === null) return null;
      return { name, year, critics: parseScore(html, 'criticsScore'), audience: parseScore(html, 'audienceScore') };
    }

    // Four-state result, never throws. A hard 404/410 after redirects is
    // RT's definitive statement that the path is dead and demotes like a
    // mismatch (same definitive-miss-vs-transient split as initListCounts'
    // deleted-list tombstone). 403/429/5xx stay in error deliberately: they
    // are what a bot wall returns, and a bot wall must never demote links.
    async function fetchRtPage(rtPath) {
      if (typeof GM_xmlhttpRequest !== 'function') return { status: 'error' };
      try {
        const r = await gmFetchText(`https://www.rottentomatoes.com/${rtPath}`);
        if (r.status === 404 || r.status === 410) return { status: 'not-found' };
        if (r.status < 200 || r.status >= 300) return { status: 'error' };
        const data = parseRtPage(r.text);
        return data ? { status: 'ok', data } : { status: 'parse-failure' };
      } catch {
        // Network failure or timeout; transient, must not demote.
        return { status: 'error' };
      }
    }
```

- [ ] **Step 3: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add fetchRtPage four-state rt page fetcher"
```

---

### Task 2: Two-signal match rule (pure functions) with node harness

**Files:**
- Modify: `trakt_improved.user.js` (inside `initExternalLinks`, insert directly after `fetchRtPage` from Task 1)
- Create: `.tmp/rtb-logic-test.mjs` (ephemeral, never committed)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `normalizeTitle(title) -> string`, `titleSignal(traktTitle, rtName) -> 'agree'|'disagree'|'unavailable'`, `yearSignal(traktYear, rtYear) -> 'agree'|'disagree'` (both args guaranteed numbers by callers), `matchVerdict(years, titles) -> 'match'|'uncertain'|'mismatch'`.

- [ ] **Step 1: Write the failing harness**

Create `.tmp/rtb-logic-test.mjs` with EXACTLY this content:

```javascript
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync('C:/Git/UserScripts/trakt_improved.user.js', 'utf8').replace(/\r/g, '');

function extract(name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start === -1) start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  do {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  } while (depth > 0);
  return src.slice(start, i);
}

const pure = new Function(`${extract('normalizeTitle')}
${extract('titleSignal')}
${extract('yearSignal')}
${extract('matchVerdict')}
return { normalizeTitle, titleSignal, yearSignal, matchVerdict };`)();

const { normalizeTitle, titleSignal, yearSignal, matchVerdict } = pure;

assert.equal(normalizeTitle('The Avengers'), 'avengers');
assert.equal(normalizeTitle("Ocean's Eleven"), 'oceans eleven');
assert.equal(normalizeTitle('Ocean\u2019s Eleven'), 'oceans eleven');
assert.equal(normalizeTitle('L\u00e9on'), 'leon');
assert.equal(normalizeTitle('Spider-Man'), 'spider man');
assert.equal(normalizeTitle('?!'), '');

assert.equal(titleSignal('Up', 'Up in the Air'), 'disagree');
assert.equal(titleSignal('Blade Runner', 'Blade Runner: The Final Cut'), 'agree');
assert.equal(titleSignal('Mission: Impossible', 'Mission: Impossible - Fallout'), 'agree');
assert.equal(titleSignal('The Office', 'The Office (US)'), 'agree');
assert.equal(titleSignal('Daredevil', "Marvel's Daredevil"), 'disagree');
assert.equal(titleSignal('Alien', 'Aliens'), 'disagree');
assert.equal(titleSignal('Inception', 'Inception'), 'agree');
assert.equal(titleSignal(null, 'Inception'), 'unavailable');
assert.equal(titleSignal('?!', 'Inception'), 'unavailable');

assert.equal(yearSignal(2010, 2010), 'agree');
assert.equal(yearSignal(2010, 2011), 'agree');
assert.equal(yearSignal(1954, 1956), 'disagree');

assert.equal(matchVerdict('agree', 'agree'), 'match');
assert.equal(matchVerdict('agree', 'disagree'), 'uncertain');
assert.equal(matchVerdict('agree', 'unavailable'), 'uncertain');
assert.equal(matchVerdict('disagree', 'agree'), 'uncertain');
assert.equal(matchVerdict('disagree', 'unavailable'), 'uncertain');
assert.equal(matchVerdict('disagree', 'disagree'), 'mismatch');

console.log('rtb-logic-test: all assertions passed');
```

- [ ] **Step 2: Run harness to verify it fails**

Run: `node C:/Git/UserScripts/.tmp/rtb-logic-test.mjs`
Expected: FAIL with `function normalizeTitle not found`.

- [ ] **Step 3: Add the pure functions**

Insert directly after `fetchRtPage`'s closing brace in `trakt_improved.user.js`:

```javascript
    // Case-fold; strip diacritics (NFD, drop combining marks); delete
    // apostrophes (ASCII, right single quote, modifier letter); every other
    // non-alphanumeric becomes a space; collapse; drop one leading English
    // article. Deleting apostrophes (rather than spacing them) keeps
    // "Ocean's" equal to "Oceans" across the two sites' encodings.
    function normalizeTitle(title) {
      return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/['\u2019\u02BC]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:the|a|an) /, '');
    }

    // Titles agree on normalized equality, or when the longer raw title
    // extends the shorter at a subtitle separator (colon, opening
    // parenthesis, or space-surrounded dash) whose prefix normalizes equal
    // to the shorter title: "Blade Runner: The Final Cut" agrees with
    // "Blade Runner" while "Up in the Air" does not agree with "Up". An
    // empty normalized side or a null Trakt title makes the signal
    // unavailable rather than a disagreement.
    function titleSignal(traktTitle, rtName) {
      if (typeof traktTitle !== 'string' || !traktTitle) return 'unavailable';
      const normTrakt = normalizeTitle(traktTitle);
      const normRt = normalizeTitle(rtName);
      if (!normTrakt || !normRt) return 'unavailable';
      if (normTrakt === normRt) return 'agree';
      const [shortRaw, longRaw] = traktTitle.length <= rtName.length
        ? [traktTitle, rtName]
        : [rtName, traktTitle];
      const shortNorm = normalizeTitle(shortRaw);
      for (const sep of longRaw.matchAll(/:|\(| [-\u2010\u2013\u2014] /g)) {
        if (normalizeTitle(longRaw.slice(0, sep.index)) === shortNorm) return 'agree';
      }
      return 'disagree';
    }

    // The +-1 tolerance absorbs festival-vs-wide-release boundary years.
    function yearSignal(traktYear, rtYear) {
      return Math.abs(traktYear - rtYear) <= 1 ? 'agree' : 'disagree';
    }

    // Demotion requires both independent signals to point at a different
    // work; any intermediate combination is uncertain, never destructive.
    function matchVerdict(years, titles) {
      if (years === 'agree' && titles === 'agree') return 'match';
      if (years === 'disagree' && titles === 'disagree') return 'mismatch';
      return 'uncertain';
    }
```

- [ ] **Step 4: Run harness to verify it passes**

Run: `node C:/Git/UserScripts/.tmp/rtb-logic-test.mjs`
Expected: `rtb-logic-test: all assertions passed`.

- [ ] **Step 5: Syntax check and commit**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js` (expect clean), then:

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add title normalization and two-signal match rule"
```

---

### Task 3: Widen `fetchTraktIds` with title and year

**Files:**
- Modify: `trakt_improved.user.js` (the `fetchTraktIds` return statement, near line 1737)

**Interfaces:**
- Consumes: existing `fetchTraktIds` body.
- Produces: `fetchTraktIds` now resolves `{ imdb: string|null, tmdb: number|null, title: string|null, year: number|null }`. Task 4 consumes `title` and `year`.

- [ ] **Step 1: Widen the return value**

In `fetchTraktIds`, replace:

```javascript
      return {
        imdb: typeof ids.imdb === 'string' && ids.imdb ? ids.imdb : null,
        tmdb: typeof ids.tmdb === 'number' ? ids.tmdb : null,
      };
```

with:

```javascript
      return {
        imdb: typeof ids.imdb === 'string' && ids.imdb ? ids.imdb : null,
        tmdb: typeof ids.tmdb === 'number' ? ids.tmdb : null,
        title: typeof body.title === 'string' && body.title ? body.title : null,
        year: typeof body.year === 'number' ? body.year : null,
      };
```

- [ ] **Step 2: Syntax check and commit**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js` (expect clean), then:

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): widen fetchTraktIds with title and year"
```

---

### Task 4: `verifyRtPath` and the widened `resolveIds` cache write

**Files:**
- Modify: `trakt_improved.user.js` (insert `verifyRtPath` after `matchVerdict`; modify the async body of `resolveIds`, near line 1783)
- Modify: `.tmp/rtb-logic-test.mjs` (append verdict-band assertions)

**Interfaces:**
- Consumes: `fetchRtPage` (Task 1), `titleSignal`/`yearSignal`/`matchVerdict` (Task 2), `fetchTraktIds`'s `title`/`year` (Task 3), shared `warn`.
- Produces: `async function verifyRtPath(rtPath, traktTitle, traktYear)` returning `{ rtPath, rtVerified, rtTitle, rtYear, rtScores }` per the spec's verdict table. `resolveIds` writes the widened entry `{ imdb, tmdb, rtPath, rtVerified, rtTitle, rtYear, rtScores, fetchedAt }`.

- [ ] **Step 1: Add `verifyRtPath`**

Insert directly after `matchVerdict`'s closing brace:

```javascript
    // Maps the two-signal rule onto cache fields. Demotion (rtPath: null)
    // happens only on not-found or when both signals disagree; parse-failure,
    // error, and a missing Trakt year yield unknown (rtVerified: false, link
    // kept: a failed check is not a failed verification). rtTitle/rtYear are
    // stored exactly on uncertain verdicts (the click-time confirm slice's
    // inputs); rtScores exactly on match (resolution-time score storage is
    // match-only). Never throws: fetchRtPage is four-state, so the caller's
    // catch (and its failure backoff) stays reserved for Trakt and Wikidata
    // failures.
    async function verifyRtPath(rtPath, traktTitle, traktYear) {
      const blank = { rtVerified: false, rtTitle: null, rtYear: null, rtScores: null };
      if (!rtPath) {
        return { rtPath: null, ...blank };
      }
      const fetchStartedAt = Date.now();
      const result = await fetchRtPage(rtPath);
      if (result.status === 'not-found') {
        warn(`RT link demoted (not-found): ${rtPath}; trakt "${traktTitle}" (${traktYear}) vs RT null (null)`);
        return { rtPath: null, ...blank };
      }
      if (result.status !== 'ok' || typeof traktYear !== 'number') {
        return { rtPath, ...blank };
      }
      const years = yearSignal(traktYear, result.data.year);
      const titles = titleSignal(traktTitle, result.data.name);
      const verdict = matchVerdict(years, titles);
      if (verdict === 'match') {
        return {
          rtPath,
          rtVerified: 'auto',
          rtTitle: null,
          rtYear: null,
          rtScores: { critics: result.data.critics, audience: result.data.audience, fetchedAt: fetchStartedAt },
        };
      }
      if (verdict === 'mismatch') {
        warn(`RT link demoted (both-disagree): ${rtPath}; trakt "${traktTitle}" (${traktYear}) vs RT "${result.data.name}" (${result.data.year})`);
        return { rtPath: null, ...blank };
      }
      warn(`RT link uncertain: trakt "${traktTitle}" (${traktYear}) vs RT "${result.data.name}" (${result.data.year})`);
      return { rtPath, rtVerified: 'uncertain', rtTitle: result.data.name, rtYear: result.data.year, rtScores: null };
    }
```

- [ ] **Step 2: Wire it into `resolveIds`**

In `resolveIds`'s async IIFE body, replace:

```javascript
        const ids = await fetchTraktIds(auth, type, slug);
        const rtPath = ids.imdb ? await fetchRtPath(ids.imdb) : null;
        cachePut(key, { imdb: ids.imdb, tmdb: ids.tmdb, rtPath, fetchedAt: Date.now() });
        queueScan();
```

with:

```javascript
        const ids = await fetchTraktIds(auth, type, slug);
        const rtPath = ids.imdb ? await fetchRtPath(ids.imdb) : null;
        const verification = await verifyRtPath(rtPath, ids.title, ids.year);
        cachePut(key, { imdb: ids.imdb, tmdb: ids.tmdb, ...verification, fetchedAt: Date.now() });
        queueScan();
```

- [ ] **Step 3: Append verdict-band assertions to the harness**

Append to `.tmp/rtb-logic-test.mjs` (before the final `console.log`, and change that final message to `rtb-logic-test + verdict bands: all assertions passed`):

```javascript
const warns = [];
const makeVerify = fetchStub => new Function(
  'fetchRtPage', 'warn', 'titleSignal', 'yearSignal', 'matchVerdict',
  `${extract('verifyRtPath')}; return verifyRtPath;`,
)(fetchStub, (...a) => warns.push(a.join(' ')), titleSignal, yearSignal, matchVerdict);

const okData = { name: 'Inception', year: 2010, critics: 86, audience: 91 };
const band = (stubResult, title, year) => makeVerify(async () => stubResult)('m/x', title, year);

let v = await band({ status: 'ok', data: okData }, 'Inception', 2010);
assert.equal(v.rtVerified, 'auto');
assert.equal(v.rtScores.critics, 86);
assert.equal(v.rtScores.audience, 91);
assert.equal(typeof v.rtScores.fetchedAt, 'number');
assert.equal(v.rtTitle, null);

v = await band({ status: 'ok', data: okData }, 'Inception', 2005);
assert.deepEqual([v.rtVerified, v.rtPath, v.rtTitle, v.rtYear, v.rtScores], ['uncertain', 'm/x', 'Inception', 2010, null]);

v = await band({ status: 'ok', data: okData }, 'Up', 2010);
assert.deepEqual([v.rtVerified, v.rtPath, v.rtTitle, v.rtYear], ['uncertain', 'm/x', 'Inception', 2010]);

v = await band({ status: 'ok', data: okData }, 'Up', 2005);
assert.deepEqual([v.rtVerified, v.rtPath, v.rtScores], [false, null, null]);
assert.ok(warns.some(w => w.includes('both-disagree') && w.includes('m/x') && w.includes('"Up" (2005)') && w.includes('"Inception" (2010)')));

v = await band({ status: 'ok', data: okData }, null, 2010);
assert.deepEqual([v.rtVerified, v.rtPath, v.rtTitle], ['uncertain', 'm/x', 'Inception']);

v = await band({ status: 'ok', data: okData }, 'Inception', null);
assert.deepEqual([v.rtVerified, v.rtPath, v.rtTitle, v.rtScores], [false, 'm/x', null, null]);

v = await band({ status: 'not-found' }, 'Inception', 2010);
assert.deepEqual([v.rtVerified, v.rtPath], [false, null]);
assert.ok(warns.some(w => w.includes('not-found') && w.includes('RT null (null)')));

v = await band({ status: 'parse-failure' }, 'Inception', 2010);
assert.deepEqual([v.rtVerified, v.rtPath], [false, 'm/x']);

v = await band({ status: 'error' }, 'Inception', 2010);
assert.deepEqual([v.rtVerified, v.rtPath], [false, 'm/x']);

let fetchCalls = 0;
v = await makeVerify(async () => { fetchCalls += 1; return { status: 'error' }; })(null, 'Inception', 2010);
assert.deepEqual([v.rtPath, v.rtVerified, fetchCalls], [null, false, 0]);
```

- [ ] **Step 4: Run harness to verify it passes**

Run: `node C:/Git/UserScripts/.tmp/rtb-logic-test.mjs`
Expected: `rtb-logic-test + verdict bands: all assertions passed`.

- [ ] **Step 5: Syntax check and commit**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js` (expect clean), then:

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): verify rt paths in resolveIds via two-signal rule"
```

---

### Task 5: Cache version bump, shape comment, script version

**Files:**
- Modify: `trakt_improved.user.js` (header `@version`, near line 4; `initExternalLinks` `CACHE_VERSION`, near line 1640; entry-shape comment, near line 1663)

**Interfaces:**
- Consumes: the widened write from Task 4.
- Produces: `CACHE_VERSION = 2` in `initExternalLinks` (the OTHER two same-named constants in other IIFEs are untouched); `@version 1.32`.

- [ ] **Step 1: Bump the `initExternalLinks` cache version**

Replace (inside `initExternalLinks`, near line 1640, adjacent to `CACHE_KEY = 'trakt-external-links-cache'`):

```javascript
    const CACHE_VERSION = 1;
```

with:

```javascript
    const CACHE_VERSION = 2;
```

- [ ] **Step 2: Update the entry-shape comment**

Replace:

```javascript
    // Cache entry per "<type>:<slug>": { imdb, tmdb, rtPath, fetchedAt }, under
    // a version stamp so a format change forces a refetch.
```

with:

```javascript
    // Cache entry per "<type>:<slug>": { imdb, tmdb, rtPath, rtVerified,
    // rtTitle, rtYear, rtScores, fetchedAt }, under a version stamp so a
    // format change forces a refetch. rtVerified is 'auto' | 'uncertain' |
    // false ('user' reserved for click-time confirm); rtTitle/rtYear are
    // non-null exactly on uncertain verdicts; rtScores is
    // { critics, audience, fetchedAt } (integers 0-100 or null) exactly on
    // match verdicts.
```

- [ ] **Step 3: Bump `@version`**

In the userscript header, replace `// @version      1.31` with `// @version      1.32`.

- [ ] **Step 4: Syntax check, full harness, and commit**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js` and `node C:/Git/UserScripts/.tmp/rtb-logic-test.mjs` (both expect clean/pass), then:

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): bump external-links cache to v2 and version to 1.32"
```

---

### Task 6: e2e bundle build script

**Files:**
- Create: `.tmp/build-rtb-e2e.mjs` (ephemeral, never committed; no git commit in this task)

**Interfaces:**
- Consumes: the final `trakt_improved.user.js` from Tasks 1-5.
- Produces: `.tmp/rtb-e2e-bundle.js`, an injectable page-context build containing the shared plumbing plus only the external-links feature, with renamed storage/DOM constants and a `window.__rtb` handle exposing `{ resolveIds, cacheEntries, evict(key), isBackedOff(key), stubs }`, where assigning `stubs.fetchRtPage` / `stubs.fetchTraktIds` overrides the real transports.

- [ ] **Step 1: Write the build script**

Create `.tmp/build-rtb-e2e.mjs` with EXACTLY this content:

```javascript
import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('C:/Git/UserScripts/trakt_improved.user.js', 'utf8');
const src = raw.replace(/\r/g, '');

const sharedEnd = src.indexOf('  // Feature: fade filters');
if (sharedEnd === -1) throw new Error('shared-section boundary not found');
const shared = src.slice(0, sharedEnd);

const featStart = src.indexOf('  // Feature: external links');
if (featStart === -1) throw new Error('external-links feature start not found');
const iifeStart = src.indexOf('  (function initExternalLinks() {', featStart);
let i = src.indexOf('{', iifeStart);
let depth = 0;
do {
  if (src[i] === '{') depth += 1;
  else if (src[i] === '}') depth -= 1;
  i += 1;
} while (depth > 0);
const featEnd = src.indexOf(')();', i) + ')();'.length;
let feature = src.slice(featStart, featEnd);

const replaceOnce = (haystack, from, to) => {
  if (!haystack.includes(from)) throw new Error(`anchor not found: ${from}`);
  return haystack.replace(from, to);
};

feature = replaceOnce(feature, "const CACHE_KEY = 'trakt-external-links-cache';", "const CACHE_KEY = 'trakt-external-links-cache-e2e';");
feature = replaceOnce(feature, "const CHIP_CLASS = 'tel-chip';", "const CHIP_CLASS = 'rtb2-chip';");
feature = replaceOnce(feature, "const KIND_ATTR = 'data-tel-kind';", "const KIND_ATTR = 'data-rtb2-kind';");
feature = replaceOnce(
  feature,
  'const ids = await fetchTraktIds(auth, type, slug);',
  'const ids = await (window.__rtb.stubs.fetchTraktIds || fetchTraktIds)(auth, type, slug);',
);
feature = replaceOnce(
  feature,
  'const result = await fetchRtPage(rtPath);',
  'const result = await (window.__rtb.stubs.fetchRtPage || fetchRtPage)(rtPath);',
);
feature = replaceOnce(
  feature,
  'const backoff = createFailureBackoff();',
  `const backoff = createFailureBackoff();
    window.__rtb = {
      resolveIds,
      cacheEntries,
      evict: key => { delete cacheEntries[key]; writeJson(CACHE_KEY, { v: CACHE_VERSION, entries: cacheEntries }); },
      isBackedOff: key => backoff.isBackedOff(key),
      stubs: {},
    };`,
);

const bundle = `${shared}
${feature}
})();
`;
writeFileSync('C:/Git/UserScripts/.tmp/rtb-e2e-bundle.js', bundle);
console.log(`bundle written: ${bundle.length} chars`);
```

- [ ] **Step 2: Run it and syntax-check the bundle**

Run: `node C:/Git/UserScripts/.tmp/build-rtb-e2e.mjs` (expect `bundle written: ...`), then `node --check C:/Git/UserScripts/.tmp/rtb-e2e-bundle.js` (expect clean). No commit: `.tmp/` is ephemeral.

---

## Post-plan verification

The live e2e run (the spec's `## Verification plan (MVP)`: stub-driven verdict matrix through `window.__rtb`, failure-independence via `evict`/`isBackedOff`, cache-version migration, and the remaining live-claim probes) is executed by the controlling session after this plan lands, not by a plan task: it needs interactive browser tooling on app.trakt.tv.
