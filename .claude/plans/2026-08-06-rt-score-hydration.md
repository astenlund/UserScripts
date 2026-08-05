# RT Score Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the "-" values on taken-over dead Rotten Tomatoes tiles on app.trakt.tv with real critic/audience scores from the `rtScores` cache field, refreshing stale scores on a 24h cadence.

**Architecture:** All code lives inside the existing `initExternalLinks` IIFE in `trakt_improved.user.js` (single-file userscript, no build). A Map-based tracker records tiles the takeover pass processed; each scan pass runs tracker maintenance, then the takeover, then hydration (render + throttled refetch through the existing `fetchRtPage` helper). Tile writes mutate `p.firstChild.data` (characterData; invisible to the childList-only body observer, preserves Svelte's bound text node).

**Tech Stack:** Vanilla JavaScript userscript (Tampermonkey), Node-based logic tests in `.tmp/` using the extract-and-eval pattern from `.tmp/rtb-logic-test.mjs`.

**Authoritative spec:** `.claude/features/rt-page-bridge.md`, section `## Slices` bullet "Continuation: score hydration" plus `## Verification plan (score hydration)`. When this plan and the spec disagree, the spec wins; flag the disagreement rather than improvising.

## Global Constraints

- `trakt_improved.user.js` is CRLF. Never convert line endings; the Edit tool preserves them. Logic tests strip `\r` from an in-memory copy only, never write it back.
- Never use em-dashes, en-dashes, or emoji in any generated text (code, comments, commit messages). Use `--` in prose comments where a dash is needed.
- The tile placeholder is the ASCII hyphen `-` (U+002D). Every text comparison uses trimmed `textContent`.
- Test files live in `.tmp/` and are NEVER committed. Commits touch `trakt_improved.user.js` only.
- Commit subjects: Conventional Commits, subject-only, max 72 chars, no body, no Co-Authored-By trailer.
- Do not bump `@version` until Task 4.
- Existing shipped identifiers this plan consumes (verify with Grep before relying on line numbers; anchors below were verified 2026-08-06): `CACHE_TTL_MS`, `cacheGet`, `cachePut`, `fetchRtPage`, `warn`, `queueScan`, `RT_TILE_VIEWBOXES`, `takeOverDeadRtTiles`, `scan`, `pageContext`.
- End every file with a newline (files already do; preserve).

---

### Task 1: Constants and pure decision helpers

**Files:**
- Modify: `trakt_improved.user.js` (inside the `initExternalLinks` IIFE)
- Test: `.tmp/rtsh-logic-test.mjs` (new; not committed)

**Interfaces:**
- Consumes: `CACHE_TTL_MS` (existing constant, 30 days in ms).
- Produces: `SCORE_TTL_MS` (24h in ms), `RT_TILE_KINDS` (viewBox-to-kind object), `hydrationFetchDue(entry, now) -> boolean`, `renderPlan(entry, kind) -> string | null` (string = text to write, null = leave alone), `mergeHydration(current, rtPath, result, fetchStartedAt) -> object | null` (null = discard). Later tasks call all three.

- [ ] **Step 1: Write the failing logic test**

Create `.tmp/rtsh-logic-test.mjs`:

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

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCORE_TTL_MS = 24 * 60 * 60 * 1000;

const pure = new Function('CACHE_TTL_MS', 'SCORE_TTL_MS', `
${extract('hydrationFetchDue')}
${extract('renderPlan')}
${extract('mergeHydration')}
return { hydrationFetchDue, renderPlan, mergeHydration };`)(CACHE_TTL_MS, SCORE_TTL_MS);

const { hydrationFetchDue, renderPlan, mergeHydration } = pure;

const NOW = 1_800_000_000_000;
const fresh = { fetchedAt: NOW - 1000, rtPath: 'm/inception', rtVerified: 'auto', rtTitle: null, rtYear: null, imdb: 'tt1375666', tmdb: 27205 };

// hydrationFetchDue: the four-condition gate minus the caller-owned nonempty-tracker check
assert.equal(hydrationFetchDue(null, NOW), false, 'missing entry');
assert.equal(hydrationFetchDue({ ...fresh, fetchedAt: NOW - CACHE_TTL_MS - 1, rtScores: null }, NOW), false, 'expired entry belongs to resolveIds');
assert.equal(hydrationFetchDue({ ...fresh, rtPath: null, rtScores: null }, NOW), false, 'null path');
assert.equal(hydrationFetchDue({ ...fresh, rtScores: null }, NOW), true, 'null scores are infinitely stale');
assert.equal(hydrationFetchDue({ ...fresh, rtScores: { critics: 86, audience: 91, fetchedAt: NOW - 1000 } }, NOW), false, 'fresh stamp');
assert.equal(hydrationFetchDue({ ...fresh, rtScores: { critics: 86, audience: 91, fetchedAt: NOW - SCORE_TTL_MS - 1 } }, NOW), true, 'stale stamp');
assert.equal(hydrationFetchDue({ ...fresh, rtScores: { critics: null, audience: null, fetchedAt: NOW - 1000 } }, NOW), false, 'fresh failure stamp holds the gate');

// renderPlan: per-tile render decision
assert.equal(renderPlan(null, 'critics'), '-', 'absent entry resets');
assert.equal(renderPlan({ ...fresh, rtPath: null, rtScores: null }, 'audience'), '-', 'null path resets');
assert.equal(renderPlan({ ...fresh, rtScores: null }, 'critics'), null, 'unknown verdict leaves text alone');
assert.equal(renderPlan({ ...fresh, rtScores: { critics: null, audience: null, fetchedAt: NOW } }, 'critics'), null, 'all-null failure stamp leaves text alone');
assert.equal(renderPlan({ ...fresh, rtScores: { critics: 86, audience: 91, fetchedAt: NOW } }, 'critics'), '86%');
assert.equal(renderPlan({ ...fresh, rtScores: { critics: 86, audience: 91, fetchedAt: NOW } }, 'audience'), '91%');
assert.equal(renderPlan({ ...fresh, rtScores: { critics: null, audience: 87, fetchedAt: NOW } }, 'critics'), '-', 'partial: null field is a truthful dash');
assert.equal(renderPlan({ ...fresh, rtScores: { critics: null, audience: 87, fetchedAt: NOW } }, 'audience'), '87%', 'partial: numeric field renders');

// mergeHydration: merge-write completion, discard on vanished/changed entry
const T0 = NOW - 500;
assert.equal(mergeHydration(null, 'm/inception', { status: 'ok', data: { critics: 86, audience: 91 } }, T0), null, 'vanished entry discards');
assert.equal(mergeHydration({ ...fresh, rtPath: 'm/other', rtScores: null }, 'm/inception', { status: 'ok', data: { critics: 86, audience: 91 } }, T0), null, 'changed path discards');

const okMerged = mergeHydration({ ...fresh, rtScores: null }, 'm/inception', { status: 'ok', data: { critics: 86, audience: 91 } }, T0);
assert.deepEqual(okMerged.rtScores, { critics: 86, audience: 91, fetchedAt: T0 }, 'ok writes scores with fetch-start stamp');
assert.equal(okMerged.imdb, 'tt1375666', 'ids preserved');
assert.equal(okMerged.fetchedAt, fresh.fetchedAt, 'entry fetchedAt untouched');

const nfMerged = mergeHydration({ ...fresh, rtTitle: 'X', rtYear: 2010, rtVerified: 'uncertain', rtScores: null }, 'm/inception', { status: 'not-found' }, T0);
assert.equal(nfMerged.rtPath, null, 'not-found demotes path');
assert.equal(nfMerged.rtVerified, false, 'not-found clears verdict');
assert.equal(nfMerged.rtTitle, null, 'not-found blanks rtTitle (five-field blank)');
assert.equal(nfMerged.rtYear, null, 'not-found blanks rtYear (five-field blank)');
assert.equal(nfMerged.rtScores, null, 'not-found blanks scores');
assert.equal(nfMerged.imdb, 'tt1375666', 'ids preserved on demotion');

for (const status of ['parse-failure', 'error']) {
  const failMerged = mergeHydration({ ...fresh, rtScores: null }, 'm/inception', { status }, T0);
  assert.deepEqual(failMerged.rtScores, { critics: null, audience: null, fetchedAt: T0 }, `${status} writes the failure stamp`);
  assert.equal(failMerged.rtPath, 'm/inception', `${status} keeps the path`);
}

console.log('task 1 assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node C:/Git/UserScripts/.tmp/rtsh-logic-test.mjs`
Expected: FAIL with `function hydrationFetchDue not found`

- [ ] **Step 3: Add `SCORE_TTL_MS` constant**

In `trakt_improved.user.js`, find (unique anchor):

```javascript
    const CACHE_MAX_ENTRIES = 500;
```

Replace with:

```javascript
    const CACHE_MAX_ENTRIES = 500;
    // Scores age faster than ids: they move daily during a title's review
    // window, so hydration refreshes them on a 24h cadence independent of
    // the month-long id TTL.
    const SCORE_TTL_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Replace the viewBox Set with a kind map**

Find (unique anchor):

```javascript
    const RT_TILE_VIEWBOXES = new Set(['0 0 145 140', '0 0 80 80']);
```

Replace with:

```javascript
    // Critic tomato and audience popcorn viewBoxes, captured from live markup
    // during the 1.31 dead-tile diagnosis. The kind map feeds hydration's
    // write-time kind derivation; the Set keeps the takeover's membership test.
    const RT_TILE_KINDS = { '0 0 145 140': 'critics', '0 0 80 80': 'audience' };
    const RT_TILE_VIEWBOXES = new Set(Object.keys(RT_TILE_KINDS));
```

- [ ] **Step 5: Add the three pure decision helpers**

Find (unique anchor):

```javascript
    function removeChip(row, kind) {
      const chip = row.querySelector(`.${CHIP_CLASS}[${KIND_ATTR}="${kind}"]`);
      if (chip) chip.remove();
    }
```

Insert immediately AFTER it:

```javascript
    // ---- Score hydration ----------------------------------------------

    // Hydration refetch gate (minus the nonempty-tracker check the caller
    // owns): only fresh entries with a live path and null-or-stale scores.
    // Expired or missing entries belong to resolveIds, whose completion
    // rewrites the whole entry; fetching for them here would race it.
    function hydrationFetchDue(entry, now) {
      if (!entry || now - entry.fetchedAt > CACHE_TTL_MS) return false;
      if (!entry.rtPath) return false;
      return !entry.rtScores || now - entry.rtScores.fetchedAt > SCORE_TTL_MS;
    }

    // Per-tile render decision: returns the text to write, or null to leave
    // the current text alone. A null score field on a parsed page renders as
    // "-" (RT's definitive no-such-score); the all-null shape doubles as the
    // failure stamp and must not blank last-known-good text.
    function renderPlan(entry, kind) {
      if (!entry || !entry.rtPath) return '-';
      const scores = entry.rtScores;
      if (!scores || (scores.critics === null && scores.audience === null)) return null;
      const score = kind === 'critics' ? scores.critics : scores.audience;
      return score === null ? '-' : `${score}%`;
    }

    // Completion merge: write only hydration's fields onto the CURRENT
    // entry; a vanished entry or changed path means a concurrent resolution
    // owns the entry and the stale result is discarded (returns null).
    // not-found demotes to the same five-field blank as resolution time.
    function mergeHydration(current, rtPath, result, fetchStartedAt) {
      if (!current || current.rtPath !== rtPath) return null;
      if (result.status === 'ok') {
        return { ...current, rtScores: { critics: result.data.critics, audience: result.data.audience, fetchedAt: fetchStartedAt } };
      }
      if (result.status === 'not-found') {
        return { ...current, rtPath: null, rtVerified: false, rtTitle: null, rtYear: null, rtScores: null };
      }
      return { ...current, rtScores: { critics: null, audience: null, fetchedAt: fetchStartedAt } };
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node C:/Git/UserScripts/.tmp/rtsh-logic-test.mjs`
Expected: `task 1 assertions passed`

- [ ] **Step 7: Syntax-check the userscript**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0

- [ ] **Step 8: Commit (userscript only; never commit `.tmp/`)**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add score hydration decision helpers"
```

---

### Task 2: Tile tracker, maintenance, and write machinery

**Files:**
- Modify: `trakt_improved.user.js` (inside the `initExternalLinks` IIFE, in the `---- Score hydration ----` block Task 1 created)
- Test: `.tmp/rtsh-tracker-test.mjs` (new; not committed)

**Interfaces:**
- Consumes: `RT_TILE_KINDS` (Task 1), `warn` (existing logger, signature `warn(...args)`).
- Produces: module state `trackedTiles` (Map: tile node -> `{ lastWritten }`), `trackedPageKey` (string | null), plus `valueNode(item)`, `tileKind(item) -> 'critics' | 'audience' | null`, `readTileText(vp) -> string`, `writeTileText(item, text)`, `maintainTracker(pageKey)`, `trackTakenTiles(taken)`. Task 3 calls `maintainTracker`, `trackTakenTiles`, `tileKind`, `writeTileText`, and iterates `trackedTiles`.

- [ ] **Step 1: Write the failing tracker test**

Create `.tmp/rtsh-tracker-test.mjs`:

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

const RT_TILE_KINDS = { '0 0 145 140': 'critics', '0 0 80 80': 'audience' };
const NodeStub = { TEXT_NODE: 3 };

function makeHarness(warns) {
  return new Function('warn', 'Node', 'RT_TILE_KINDS', `
    const trackedTiles = new Map();
    let trackedPageKey = null;
    ${extract('valueNode')}
    ${extract('tileKind')}
    ${extract('readTileText')}
    ${extract('writeTileText')}
    ${extract('maintainTracker')}
    ${extract('trackTakenTiles')}
    return { trackedTiles, tileKind, writeTileText, maintainTracker, trackTakenTiles, pageKey: () => trackedPageKey };
  `)((...a) => warns.push(a.join(' ')), NodeStub, RT_TILE_KINDS);
}

// Fake tile: .rating-item with an svg (viewBox) and a value p holding one text node.
function fakeTile(viewBox, text) {
  const vp = {
    childNodes: [{ nodeType: 3, data: text }],
    get firstChild() { return this.childNodes[0]; },
    get textContent() { return this.childNodes.map(n => n.data).join(''); },
    set textContent(v) { this.childNodes = [{ nodeType: 3, data: v }]; },
  };
  const svg = { getAttribute: attr => (attr === 'viewBox' ? viewBox : null) };
  return {
    isConnected: true,
    vp,
    svg,
    hasValueNode: true,
    querySelector(sel) {
      if (sel === '.rating-value p') return this.hasValueNode ? this.vp : null;
      if (sel === 'svg') return this.svg;
      return null;
    },
  };
}

// tileKind derives from the current viewBox
{
  const h = makeHarness([]);
  assert.equal(h.tileKind(fakeTile('0 0 145 140', '-')), 'critics');
  assert.equal(h.tileKind(fakeTile('0 0 80 80', '-')), 'audience');
  assert.equal(h.tileKind(fakeTile('0 0 24 24', '-')), null, 'non-RT viewBox');
}

// writeTileText: data write path, compare guard, lastWritten stamp
{
  const h = makeHarness([]);
  const tile = fakeTile('0 0 145 140', '-');
  h.trackedTiles.set(tile, { lastWritten: null });
  h.writeTileText(tile, '86%');
  assert.equal(tile.vp.textContent, '86%');
  assert.equal(tile.vp.childNodes.length, 1, 'mutated in place, not replaced');
  assert.equal(h.trackedTiles.get(tile).lastWritten, '86%', 'write stamps lastWritten');
  h.trackedTiles.get(tile).lastWritten = null;
  h.writeTileText(tile, '86%');
  assert.equal(h.trackedTiles.get(tile).lastWritten, null, 'compare guard: identical write is a no-op (no stamp)');
}

// writeTileText: textContent fallback on non-single-text-node drift
{
  const h = makeHarness([]);
  const tile = fakeTile('0 0 145 140', '-');
  tile.vp.childNodes = [{ nodeType: 3, data: '-' }, { nodeType: 1, data: '' }];
  h.trackedTiles.set(tile, { lastWritten: null });
  h.writeTileText(tile, '86%');
  assert.equal(tile.vp.textContent, '86%', 'fallback writes through textContent');
}

// trackTakenTiles: insert-if-absent + foreign-text normalization
{
  const h = makeHarness([]);
  const tile = fakeTile('0 0 145 140', '-');
  h.trackTakenTiles([tile]);
  assert.equal(h.trackedTiles.get(tile).lastWritten, null, 'new record starts null');
  h.writeTileText(tile, '86%');
  h.trackTakenTiles([tile]);
  assert.equal(h.trackedTiles.get(tile).lastWritten, '86%', 're-take preserves the record (insert-if-absent)');
  assert.equal(tile.vp.textContent, '86%', 'own lastWritten text survives a re-take');
  tile.vp.childNodes = [{ nodeType: 3, data: '55%' }];
  h.trackTakenTiles([tile]);
  assert.equal(tile.vp.textContent, '-', 'foreign score text is normalized to "-"');
}

// maintainTracker same-key drops: disconnected, valueless (warned), non-RT viewBox, foreign text
{
  const warns = [];
  const h = makeHarness(warns);
  h.maintainTracker('movie:a');

  const gone = fakeTile('0 0 145 140', '-');
  gone.isConnected = false;
  const valueless = fakeTile('0 0 145 140', '-');
  valueless.hasValueNode = false;
  const alien = fakeTile('0 0 24 24', '-');
  const reclaimed = fakeTile('0 0 80 80', '73%');
  const kept = fakeTile('0 0 80 80', '-');
  for (const t of [gone, valueless, alien, reclaimed, kept]) h.trackedTiles.set(t, { lastWritten: null });

  h.maintainTracker('movie:a');
  assert.equal(h.trackedTiles.has(gone), false, 'disconnected dropped');
  assert.equal(h.trackedTiles.has(valueless), false, 'valueless dropped');
  assert.equal(warns.length, 1, 'valueless drop warns');
  assert.equal(h.trackedTiles.has(alien), false, 'non-RT viewBox dropped');
  assert.equal(h.trackedTiles.has(reclaimed), false, 'foreign text dropped (app reclaim)');
  assert.equal(h.trackedTiles.has(kept), true, 'dash tile with null lastWritten kept');
}

// maintainTracker page-key change: guarded reset then clear
{
  const h = makeHarness([]);
  h.maintainTracker('movie:a');
  const scripted = fakeTile('0 0 145 140', '-');
  const repatched = fakeTile('0 0 80 80', '-');
  h.trackedTiles.set(scripted, { lastWritten: null });
  h.trackedTiles.set(repatched, { lastWritten: null });
  h.writeTileText(scripted, '86%');
  h.writeTileText(repatched, '91%');
  repatched.vp.childNodes = [{ nodeType: 3, data: '40%' }];

  h.maintainTracker('movie:b');
  assert.equal(scripted.vp.textContent, '-', 'script-authored text reset to "-"');
  assert.equal(repatched.vp.textContent, '40%', 'app-repatched text left alone');
  assert.equal(h.trackedTiles.size, 0, 'tracker cleared on page-key change');
  assert.equal(h.pageKey(), 'movie:b');
}

console.log('task 2 assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node C:/Git/UserScripts/.tmp/rtsh-tracker-test.mjs`
Expected: FAIL with `function valueNode not found`

- [ ] **Step 3: Implement the tracker machinery**

In `trakt_improved.user.js`, find the end of Task 1's insertion (unique anchor):

```javascript
      return { ...current, rtScores: { critics: null, audience: null, fetchedAt: fetchStartedAt } };
    }
```

Insert immediately AFTER it:

```javascript
    // Taken-over dead RT tiles tracked for hydration, keyed by tile node.
    // lastWritten is the exact string the script last wrote into the tile's
    // value node (null until the first write); it is the authorship signal
    // the maintenance drops and the takeover normalization key on. A Map,
    // not a WeakMap: the per-pass sweep must iterate it.
    const trackedTiles = new Map();
    let trackedPageKey = null;

    function valueNode(item) {
      return item.querySelector('.rating-value p');
    }

    function tileKind(item) {
      const svg = item.querySelector('svg');
      return svg ? RT_TILE_KINDS[svg.getAttribute('viewBox')] ?? null : null;
    }

    function readTileText(vp) {
      return vp.textContent.trim();
    }

    // Pinned write mechanism: every probed value node holds exactly one text
    // node, so mutate its data in place -- a characterData mutation the body
    // observer (childList only) never fires on, and one that keeps Svelte's
    // bound text node attached so app repatches stay visible to reads. The
    // textContent fallback (childList, observed once per change thanks to
    // the compare guard) covers markup drift at the accepted cost of
    // detaching the binding for that tile.
    function writeTileText(item, text) {
      const vp = valueNode(item);
      if (!vp) return;
      if (readTileText(vp) === text) return;
      if (vp.childNodes.length === 1 && vp.firstChild.nodeType === Node.TEXT_NODE) {
        vp.firstChild.data = text;
      } else {
        vp.textContent = text;
      }
      const record = trackedTiles.get(item);
      if (record) {
        record.lastWritten = text;
      }
    }

    // Per-pass tracker maintenance; runs before the takeover call and before
    // any writer. On a page-key change: reset the script's own text (guarded
    // by lastWritten; app-repatched text is left alone) and forget everything
    // (Svelte reuses row nodes across SPA navigations). Same key: drop
    // disconnected tiles, tiles the app reclaimed (foreign text), tiles that
    // stopped being RT tiles (viewBox left the pair), and tiles whose value
    // node vanished (markup drift degrades to unhydrated, never throws).
    function maintainTracker(pageKey) {
      if (pageKey !== trackedPageKey) {
        for (const [item, record] of trackedTiles) {
          if (!item.isConnected || record.lastWritten === null) continue;
          const vp = valueNode(item);
          if (vp && readTileText(vp) === record.lastWritten) {
            writeTileText(item, '-');
          }
        }
        trackedTiles.clear();
        trackedPageKey = pageKey;
        return;
      }
      for (const [item, record] of trackedTiles) {
        if (!item.isConnected) {
          trackedTiles.delete(item);
          continue;
        }
        const vp = valueNode(item);
        if (!vp) {
          warn('Tracked RT tile lost its value node; dropping it from hydration');
          trackedTiles.delete(item);
          continue;
        }
        if (!tileKind(item)) {
          trackedTiles.delete(item);
          continue;
        }
        const text = readTileText(vp);
        if (text !== '-' && text !== record.lastWritten) {
          trackedTiles.delete(item);
        }
      }
    }

    // Insert-if-absent accumulation plus the takeover normalization: foreign
    // score text on a just-taken tile is reset to "-" (on a cross-title
    // re-take the page-key clear has already emptied the tracker, so any
    // surviving score text is foreign by definition); the node's own
    // lastWritten text survives a same-title re-take.
    function trackTakenTiles(taken) {
      for (const item of taken) {
        if (!trackedTiles.has(item)) {
          trackedTiles.set(item, { lastWritten: null });
        }
        const vp = valueNode(item);
        if (!vp) continue;
        const text = readTileText(vp);
        if (text !== '-' && text !== trackedTiles.get(item).lastWritten) {
          writeTileText(item, '-');
        }
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node C:/Git/UserScripts/.tmp/rtsh-tracker-test.mjs`
Expected: `task 2 assertions passed`

- [ ] **Step 5: Re-run the Task 1 test and syntax check (regression)**

Run: `node C:/Git/UserScripts/.tmp/rtsh-logic-test.mjs`
Expected: `task 1 assertions passed`
Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add hydration tile tracker and write machinery"
```

---

### Task 3: Hydration fetch, render, and scan integration

**Files:**
- Modify: `trakt_improved.user.js` (the hydration block, `takeOverDeadRtTiles`, `scan`, and two shipped comments)
- Test: `.tmp/rtsh-hydrate-test.mjs` (new; not committed)

**Interfaces:**
- Consumes: everything Tasks 1-2 produced, plus existing `fetchRtPage(rtPath)` (four-state result), `cacheGet(key)`, `cachePut(key, entry)`, `queueScan()`, `warn`.
- Produces: `hydrationInFlight` (Set of keys), `hydrateScores(key, rtPath)`, `hydrateTiles(key)`; `takeOverDeadRtTiles` now returns the array of `.rating-item` nodes it processed this pass. `scan` wires the fixed order: `maintainTracker(key)`, then `takeOverDeadRtTiles`, then `trackTakenTiles`, then `hydrateTiles(key)`.

- [ ] **Step 1: Write the failing hydrate test**

Create `.tmp/rtsh-hydrate-test.mjs`:

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

function makeHydrator({ entry, result }) {
  const calls = { puts: [], scans: 0, warns: [], fetches: 0 };
  let resolveFetch;
  const fetchGate = new Promise(r => { resolveFetch = r; });
  const harness = new Function('fetchRtPage', 'cacheGet', 'cachePut', 'queueScan', 'warn', 'mergeHydration', 'Date', `
    const hydrationInFlight = new Set();
    ${extract('hydrateScores')}
    return { hydrateScores, hydrationInFlight };
  `)(
    async () => { calls.fetches += 1; await fetchGate; return result; },
    () => entry,
    (key, e) => calls.puts.push([key, e]),
    () => { calls.scans += 1; },
    (...a) => calls.warns.push(a.join(' ')),
    // real mergeHydration extracted so the merge path is exercised end to end
    new Function(`${extract('mergeHydration')} return mergeHydration;`)(),
    Date,
  );
  return { harness, calls, release: () => resolveFetch() };
}

const entry = { imdb: 'tt1', tmdb: 2, rtPath: 'm/x', rtVerified: 'auto', rtTitle: null, rtYear: null, rtScores: null, fetchedAt: Date.now() };

// ok completion: merge-put + queueScan, in-flight dedup during the window
{
  const { harness, calls, release } = makeHydrator({ entry, result: { status: 'ok', data: { critics: 86, audience: 91 } } });
  harness.hydrateScores('movie:x', 'm/x');
  harness.hydrateScores('movie:x', 'm/x');
  assert.equal(calls.fetches, 1, 'in-flight dedup: one fetch despite two calls');
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.puts.length, 1, 'one cache write');
  assert.deepEqual(calls.puts[0][1].rtScores.critics, 86);
  assert.equal(calls.scans, 1, 'completion queues a scan');
  assert.equal(harness.hydrationInFlight.size, 0, 'in-flight cleared');
}

// not-found completion: five-field blank + demotion warn carrying path, key, reason
{
  const { harness, calls, release } = makeHydrator({ entry, result: { status: 'not-found' } });
  harness.hydrateScores('movie:x', 'm/x');
  release();
  await new Promise(r => setTimeout(r, 0));
  const put = calls.puts[0][1];
  assert.equal(put.rtPath, null);
  assert.equal(put.rtVerified, false);
  assert.equal(put.rtTitle, null);
  assert.equal(put.rtYear, null);
  assert.equal(put.rtScores, null);
  assert.equal(calls.warns.length, 1, 'demotion warns');
  const w = calls.warns[0];
  assert.ok(w.includes('m/x') && w.includes('movie:x') && w.includes('not-found'), 'warn carries path, key, reason token');
}

// error completion: failure stamp, no warn
{
  const { harness, calls, release } = makeHydrator({ entry, result: { status: 'error' } });
  harness.hydrateScores('movie:x', 'm/x');
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls.puts[0][1].rtScores.critics, null);
  assert.equal(typeof calls.puts[0][1].rtScores.fetchedAt, 'number');
  assert.equal(calls.warns.length, 0, 'transient failure does not warn');
}

// mid-flight discard: entry path changed while fetch ran
{
  const { harness, calls, release } = makeHydrator({ entry: { ...entry, rtPath: 'm/other' }, result: { status: 'ok', data: { critics: 1, audience: 2 } } });
  harness.hydrateScores('movie:x', 'm/x');
  release();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.puts.length, 0, 'stale result discarded');
  assert.equal(calls.scans, 0, 'no scan queued for a discarded result');
}

console.log('task 3 assertions passed');
```

Note: the file uses top-level `await`; `.mjs` supports it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node C:/Git/UserScripts/.tmp/rtsh-hydrate-test.mjs`
Expected: FAIL with `function hydrateScores not found`

- [ ] **Step 3: Implement `hydrateScores` and `hydrateTiles`**

Find the end of Task 2's insertion (unique anchor):

```javascript
        if (text !== '-' && text !== trackedTiles.get(item).lastWritten) {
          writeTileText(item, '-');
        }
      }
    }
```

Insert immediately AFTER it:

```javascript
    const hydrationInFlight = new Set();

    // Fire-and-forget score refresh, mirroring resolveIds: dedup while in
    // flight, merge-write on completion, queueScan so the scores reach the
    // DOM without waiting for an app-driven mutation. fetchRtPage never
    // throws (four-state result), so the catch mirrors resolveIds' shape
    // purely defensively.
    function hydrateScores(key, rtPath) {
      if (hydrationInFlight.has(key)) return;
      hydrationInFlight.add(key);
      (async () => {
        const fetchStartedAt = Date.now();
        const result = await fetchRtPage(rtPath);
        const merged = mergeHydration(cacheGet(key), rtPath, result, fetchStartedAt);
        if (!merged) return;
        if (result.status === 'not-found') {
          warn(`RT path ${rtPath} dead for ${key}; demoting to title search (not-found)`);
        }
        cachePut(key, merged);
        queueScan();
      })().catch(e => {
        warn(`Score hydration failed for ${key}`, e);
      }).finally(() => hydrationInFlight.delete(key));
    }

    // Render pass over the tracked set plus the throttled refetch. Kind is
    // derived from each tile's CURRENT svg viewBox at write time, never
    // snapshotted: node reuse can shift a tracked node's tile identity under
    // an unchanged page key, and a snapshot would hydrate a repatched node
    // from a stale kind. renderPlan returning null means leave the text
    // alone (unknown verdict or failure stamp).
    function hydrateTiles(key) {
      if (trackedTiles.size === 0) return;
      const entry = cacheGet(key);
      for (const [item] of trackedTiles) {
        const kind = tileKind(item);
        if (!kind) continue;
        const target = renderPlan(entry, kind);
        if (target !== null) {
          writeTileText(item, target);
        }
      }
      if (hydrationFetchDue(entry, Date.now())) {
        hydrateScores(key, entry.rtPath);
      }
    }
```

- [ ] **Step 4: Make `takeOverDeadRtTiles` return its processed tiles**

Find (unique anchor):

```javascript
    function takeOverDeadRtTiles(row, url) {
      for (const item of row.querySelectorAll(`rating:not(.${CHIP_CLASS}) .rating-item:not(.has-valid-rating)`)) {
        const svg = item.querySelector('svg');
        const anchor = item.closest('a');
        if (!svg || !anchor || !RT_TILE_VIEWBOXES.has(svg.getAttribute('viewBox'))) continue;
        anchor.classList.remove('trakt-no-link');
        anchor.classList.add('trakt-link');
        if (anchor.getAttribute('target') !== '_blank') anchor.target = '_blank';
        if (anchor.getAttribute('rel') !== 'noopener') anchor.rel = 'noopener';
        syncHref(anchor, url);
        if (svg.style.filter) svg.style.filter = '';
        item.classList.add('has-valid-rating');
      }
    }
```

Replace with:

```javascript
    function takeOverDeadRtTiles(row, url) {
      const taken = [];
      for (const item of row.querySelectorAll(`rating:not(.${CHIP_CLASS}) .rating-item:not(.has-valid-rating)`)) {
        const svg = item.querySelector('svg');
        const anchor = item.closest('a');
        if (!svg || !anchor || !RT_TILE_VIEWBOXES.has(svg.getAttribute('viewBox'))) continue;
        anchor.classList.remove('trakt-no-link');
        anchor.classList.add('trakt-link');
        if (anchor.getAttribute('target') !== '_blank') anchor.target = '_blank';
        if (anchor.getAttribute('rel') !== 'noopener') anchor.rel = 'noopener';
        syncHref(anchor, url);
        if (svg.style.filter) svg.style.filter = '';
        item.classList.add('has-valid-rating');
        taken.push(item);
      }
      return taken;
    }
```

- [ ] **Step 5: Wire the fixed order into `scan`**

Find (unique anchor):

```javascript
      const key = `${page.type}:${page.slug}`;
      const entry = cacheGet(key);
```

Replace with:

```javascript
      const key = `${page.type}:${page.slug}`;
      maintainTracker(key);
      const entry = cacheGet(key);
```

Then find (unique anchor):

```javascript
      takeOverDeadRtTiles(row, rt);
```

Replace with:

```javascript
      trackTakenTiles(takeOverDeadRtTiles(row, rt));
      hydrateTiles(key);
```

- [ ] **Step 6: Update the two shipped invariant comments**

The spec's consumers walk requires both updates when this slice lands.

Find (unique anchor):

```javascript
    // { critics, audience, fetchedAt } (integers 0-100 or null) exactly on
    // match verdicts.
```

Replace with:

```javascript
    // { critics, audience, fetchedAt } (integers 0-100 or null): match-only
    // at resolution time, refreshed verdict-agnostically by score hydration.
```

Find (unique anchor):

```javascript
    // has-valid-rating (it lives in a cross-origin sheet, so it is invisible
    // to cssRules walks). All writes are class/attribute/style-level, so the
    // body observer does not refire, and Svelte re-renders that restore the
    // dead form are simply re-taken on the next scan.
```

Replace with:

```javascript
    // has-valid-rating (it lives in a cross-origin sheet, so it is invisible
    // to cssRules walks). This function's writes are class/attribute/style
    // level, and the hydration pass that follows writes tile text through
    // characterData mutations, so the body observer does not refire either
    // way, and Svelte re-renders that restore the dead form are simply
    // re-taken on the next scan.
```

- [ ] **Step 7: Run all three tests and the syntax check**

Run: `node C:/Git/UserScripts/.tmp/rtsh-hydrate-test.mjs`
Expected: `task 3 assertions passed`
Run: `node C:/Git/UserScripts/.tmp/rtsh-logic-test.mjs`
Expected: `task 1 assertions passed`
Run: `node C:/Git/UserScripts/.tmp/rtsh-tracker-test.mjs`
Expected: `task 2 assertions passed`
Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): hydrate taken-over rt tiles from cached scores"
```

---

### Task 4: Version bump and final verification sweep

**Files:**
- Modify: `trakt_improved.user.js:4` (`@version` header)

**Interfaces:**
- Consumes: nothing new. Produces: version 1.33, the auto-update signal for installed copies.

- [ ] **Step 1: Bump the version header**

Find (unique anchor):

```javascript
// @version      1.32
```

Replace with:

```javascript
// @version      1.33
```

- [ ] **Step 2: Re-run every test and the syntax check**

Run: `node C:/Git/UserScripts/.tmp/rtsh-logic-test.mjs`
Expected: `task 1 assertions passed`
Run: `node C:/Git/UserScripts/.tmp/rtsh-tracker-test.mjs`
Expected: `task 2 assertions passed`
Run: `node C:/Git/UserScripts/.tmp/rtsh-hydrate-test.mjs`
Expected: `task 3 assertions passed`
Run: `node C:/Git/UserScripts/.tmp/rtb-logic-test.mjs` (the MVP's regression test, if still present in `.tmp/`)
Expected: passes; if the file is absent, note that and move on (it is ephemeral scratch)
Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: exit 0

- [ ] **Step 3: Verify no stray non-ASCII or line-ending damage**

Run: `git -C C:/Git/UserScripts diff --stat HEAD~3..HEAD -- trakt_improved.user.js`
Expected: additions concentrated in the external-links IIFE; no whole-file rewrite (a whole-file line count change means line endings were converted; stop and fix before committing).

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "chore(trakt): bump trakt improved to 1.33"
```

---

## Out of plan scope (handled by the handover pipeline after implementation)

- Live e2e verification per `## Verification plan (score hydration)` (injected namespaced build, gate-matrix bands (a)-(k), tracker bands, observer-loop guard, and settling the one provisional live-claim: dead-form markup on a show page).
- Docs/backlog updates (FEATURES.md strike-through, FEATURES_HISTORY.md entry, walk-and-remove sweep).
- Plan file removal after landing.
