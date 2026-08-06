# Manage-Lists Row Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Script-owned truth for the Anticipated/Uninterested rows in the app's Manage lists drawer: correct their display from the script's membership engine and intercept their clicks into the existing `performToggle` write path.

**Architecture:** All code lives inside the existing `initQuickListToggles` IIFE in `trakt_improved.user.js` (it shares `QUICK_LIST_NAMES`, `quickLists`, `slugKeyOf`, `performToggle`, `warnedTargets`, `pendingContext`, `summaryContext`). A capture-phase click listener records the drawer's item context; a drawer renderer joins the feature's scan callback and corrects owned rows (attribute-only, compare-then-write); a document-level capture listener set suppresses the full event sequence on owned rows and fires the script's own write. A per-drawer-node MutationObserver (attribute filter) makes re-assertion self-triggering.

**Tech Stack:** Vanilla JS userscript (Tampermonkey), no build, no framework. Logic tests are standalone Node scripts under `.tmp/`.

## Global Constraints

- Governing spec: `.claude/features/manage-lists-row-takeover.md` (hardened; live-probed 2026-08-07). The spec is authoritative on behavior; this plan is authoritative on mechanics.
- Scan callbacks run per animation frame off one shared childList body observer: every DOM write in a scan callback MUST be compare-then-write (idempotent). Attribute-only writes do not retrigger the body observer.
- The menu row match string is "Manage lists" followed by U+2026 (horizontal ellipsis). NEVER write the ellipsis as a literal or a `\u2026` escape in an Edit tool call (escape sequences can arrive silently decoded); build it as `'Manage lists' + String.fromCharCode(8230)`.
- Probe outcomes already decided: the greyed-state clearing sub-step and the fill-normalization sub-step are NOT implemented (dropped per spec fallbacks); the marker is the single attribute `data-mlrt-item`.
- Never use em-dashes, en-dashes, or emoji in any code, comment, or commit message.
- Commit subjects: Conventional Commits, subject-only, max 72 chars, no body, no Co-Authored-By trailer.
- Keep the plan file (`.claude/plans/2026-08-07-manage-lists-row-takeover.md`) and `.tmp/` out of every commit; commit only `trakt_improved.user.js`.
- `trakt_improved.user.js` is CRLF. Use the Edit tool for all edits (it preserves line endings); never rewrite the whole file.
- Match surrounding code style: 2-space indent, single quotes, semicolons, comment density like neighboring IIFEs.

---

### Task 1: Pure label helpers plus logic test

**Files:**
- Modify: `trakt_improved.user.js` (inside `initQuickListToggles`, after the `TOAST_DISMISS_MS` constant)
- Test: `.tmp/mlrt-logic-test.mjs` (new; NOT committed)

**Interfaces:**
- Produces: `DRAWER_CONTEXT_FRESH_MS` (number, 15000), `WARN_SETTLE_MS` (number, 2000), `MARKER_ATTR` (string `'data-mlrt-item'`), `MENU_ROW_TEXT` (string, `'Manage lists' + String.fromCharCode(8230)`), `DRAWER_LABEL_RE` (RegExp), `parseDrawerLabel(label) -> { verb, title } | null`, `wantedDrawerLabel(label, member) -> string`. Tasks 2-5 consume these exact names.

- [ ] **Step 1: Insert the constants and pure helpers**

In `trakt_improved.user.js`, find the unique anchor:

```js
    const TOAST_ID = 'qlt-toast';
    const TOAST_DISMISS_MS = 4000;
```

Immediately AFTER those two lines, insert:

```js

    // --- Manage-lists drawer takeover ---
    // Spec: .claude/features/manage-lists-row-takeover.md. The drawer
    // misreports quick-list membership after script writes (its query
    // cache has no drivable invalidation channel), so the script owns
    // the two quick-list rows outright: display corrected from the
    // membership engine, clicks intercepted into performToggle. Every
    // other row stays fully native.
    const DRAWER_CONTEXT_FRESH_MS = 15000;
    const WARN_SETTLE_MS = 2000;
    const MARKER_ATTR = 'data-mlrt-item';
    // Both menu surfaces render the row with a trailing U+2026 ellipsis
    // (live-probed 2026-08-07); built from a char code so the source
    // stays ASCII-safe.
    const MENU_ROW_TEXT = 'Manage lists' + String.fromCharCode(8230);

    // --- mlrt pure helpers (extracted by .tmp/mlrt-logic-test.mjs) ---
    // Greedy title group tolerates quotes in titles: the regex anchors
    // on the LAST " to |" from " before the list name.
    const DRAWER_LABEL_RE = /^(Add|Remove) "(.*)" (?:to|from) /;

    function parseDrawerLabel(label) {
      const match = (label || '').match(DRAWER_LABEL_RE);
      return match ? { verb: match[1], title: match[2] } : null;
    }

    // Preserves the app's exact label format; only the verb and
    // preposition flip with membership.
    function wantedDrawerLabel(label, member) {
      return label.replace(DRAWER_LABEL_RE, (m, verb, title) => (member ? 'Remove' : 'Add') + ' "' + title + '" ' + (member ? 'from' : 'to') + ' ');
    }
    // --- end mlrt pure helpers ---
```

- [ ] **Step 2: Write the logic test**

Create `.tmp/mlrt-logic-test.mjs` with exactly:

```js
// Logic test for the manage-lists drawer takeover pure helpers.
// Extracts the marked block from trakt_improved.user.js (strip \r from
// the matching copy only; the source is CRLF and multi-line anchors
// fail against raw bytes).
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../trakt_improved.user.js', import.meta.url), 'utf8').replace(/\r/g, '');
const START = '// --- mlrt pure helpers (extracted by .tmp/mlrt-logic-test.mjs) ---';
const END = '// --- end mlrt pure helpers ---';
const a = src.indexOf(START);
const b = src.indexOf(END);
if (a === -1 || b === -1 || b <= a) {
  console.error('FAIL: helper block anchors not found');
  process.exit(1);
}
const block = src.slice(a + START.length, b);
const api = new Function(block + '\nreturn { DRAWER_LABEL_RE, parseDrawerLabel, wantedDrawerLabel };')();

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error('FAIL ' + name + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  } else {
    console.log('ok ' + name);
  }
}

check('parse add', api.parseDrawerLabel('Add "Severance" to Anticipated'), { verb: 'Add', title: 'Severance' });
check('parse remove', api.parseDrawerLabel('Remove "Severance" from Uninterested'), { verb: 'Remove', title: 'Severance' });
check('parse watchlist variant', api.parseDrawerLabel('Add "Severance" to your Watchlist'), { verb: 'Add', title: 'Severance' });
check('parse quoted title', api.parseDrawerLabel('Add "The "Signal" Problem" to Anticipated'), { verb: 'Add', title: 'The "Signal" Problem' });
check('parse garbage', api.parseDrawerLabel('Watch now'), null);
check('parse empty', api.parseDrawerLabel(''), null);
check('want member', api.wantedDrawerLabel('Add "Severance" to Anticipated', true), 'Remove "Severance" from Anticipated');
check('want nonmember', api.wantedDrawerLabel('Remove "Severance" from Anticipated', false), 'Add "Severance" to Anticipated');
check('want idempotent', api.wantedDrawerLabel('Remove "Severance" from Anticipated', true), 'Remove "Severance" from Anticipated');
check('want quoted title', api.wantedDrawerLabel('Add "The "Signal" Problem" to Uninterested', true), 'Remove "The "Signal" Problem" from Uninterested');

if (failures > 0) process.exit(1);
console.log('all mlrt logic tests passed');
```

- [ ] **Step 3: Run the test**

Run: `node C:/Git/UserScripts/.tmp/mlrt-logic-test.mjs`
Expected: every line starts with `ok`, final line `all mlrt logic tests passed`, exit code 0. If the anchors are not found, Step 1 was not applied correctly; fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add drawer takeover label helpers and constants"
```

---

### Task 2: Drawer context capture

**Files:**
- Modify: `trakt_improved.user.js` (inside `initQuickListToggles`)

**Interfaces:**
- Consumes: `MENU_ROW_TEXT`, `DRAWER_CONTEXT_FRESH_MS` (Task 1); existing `summaryContext()`, `pendingContext`, `ENTRY_ATTR`, `queueScan()`.
- Produces: module-level `let drawerContext` (`{ type, slug, title } | null`), `captureDrawerContext(row)`, `popupDrawerContext(row)`. Tasks 3-5 consume `drawerContext`.

- [ ] **Step 1: Add the drawerContext state**

Find the unique anchor:

```js
    let pendingContext = null;
```

Replace with:

```js
    let pendingContext = null;
    // Drawer item context: which item the Manage-lists drawer shows.
    // Captured at the moment a "Manage lists" menu row is clicked (the
    // only observed open paths); null means every drawer row stays
    // fully native (fail closed).
    let drawerContext = null;
```

- [ ] **Step 2: Add the capture listener and context sources**

Find the unique anchor (end of the existing kebab capture listener):

```js
      teardownPopupEntries();
      pendingContext = cardContext(button);
    }, true);
```

Replace with:

```js
      teardownPopupEntries();
      pendingContext = cardContext(button);
    }, true);

    // Drawer context capture (capture phase is load-bearing: the card
    // path reads sibling injected entries that the app tears down when
    // the popup closes, so the read must precede the app's handler).
    // Either outcome queues a scan so the corrections a new context
    // enables, and the unwinds a cleared one requires, never wait on
    // ambient churn.
    document.addEventListener('click', e => {
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest('.trakt-popup-menu-container li, div.trakt-summary-actions li');
      if (!row || row.textContent.trim() !== MENU_ROW_TEXT) return;
      drawerContext = captureDrawerContext(row);
      queueScan();
    }, true);

    // A context whose title fell back to the slug can never pass the
    // drawer title cross-check (a slug is not a display title), so it
    // is recorded as no context rather than reading as valid while
    // silently disabling the feature. Accepted narrow false negative:
    // an item whose display title literally equals its slug.
    function captureDrawerContext(row) {
      const context = row.closest('div.trakt-summary-actions') ? summaryContext() : popupDrawerContext(row);
      if (!context || context.title === context.slug) return null;
      return { type: context.type, slug: context.slug, title: context.title };
    }

    // Card path: sibling injected entries already record card identity;
    // fall back to pendingContext within DRAWER_CONTEXT_FRESH_MS (menu
    // dwell routinely exceeds the sub-frame CONTEXT_FRESH_MS; the title
    // cross-check stays the correctness guard, freshness only bounds
    // heuristic reuse).
    function popupDrawerContext(row) {
      const menu = row.closest('ul');
      const entry = menu && menu.querySelector('[' + ENTRY_ATTR + ']');
      if (entry) {
        return {
          type: entry.getAttribute('data-qlt-type'),
          slug: entry.getAttribute('data-qlt-slug'),
          title: entry.getAttribute('data-qlt-title'),
        };
      }
      if (pendingContext && Date.now() - pendingContext.at <= DRAWER_CONTEXT_FRESH_MS) {
        return pendingContext;
      }
      return null;
    }
```

- [ ] **Step 3: Sanity-run the logic test (regression only)**

Run: `node C:/Git/UserScripts/.tmp/mlrt-logic-test.mjs`
Expected: still all `ok`, exit 0 (the helper block is untouched; this catches accidental anchor damage).

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): capture manage-lists drawer item context"
```

---

### Task 3: Ownership predicate and warn gate

**Files:**
- Modify: `trakt_improved.user.js` (inside `initQuickListToggles`)

**Interfaces:**
- Consumes: `drawerContext` (Task 2), `DRAWER_LABEL_RE`/`parseDrawerLabel` (Task 1), existing `QUICK_LIST_NAMES`, `quickLists.getListTarget`, `quickLists.membershipState`, `slugKeyOf`, `warnedTargets`, `warn`, `queueScan`.
- Produces: `classifyDrawerRow(row)` returning one of `{ state: 'foreign' }`, `{ state: 'failed', reason: 'no-context' | 'drawer-markup' | 'drawer-title-mismatch' | 'drawer-ownership-lost' }`, `{ state: 'owned', name, member }`; `noteGatedWarn(row, reason, detail)`; `warnDrawerOnce(key, detail)`; module-level `warnCandidates` WeakMap. Tasks 4-5 consume `classifyDrawerRow`, `warnDrawerOnce`, `warnCandidates`.

- [ ] **Step 1: Add the warn-candidate state**

Find the unique anchor:

```js
    const warnedTargets = new Set();
```

Replace with:

```js
    const warnedTargets = new Set();
    // Persistence-gate candidates for the drawer's render-facing warn
    // keys, keyed by row node (rows die with the drawer, taking their
    // candidates along).
    const warnCandidates = new WeakMap();
```

- [ ] **Step 2: Add the predicate and gate functions**

Find the unique anchor (the closing of `popupDrawerContext` from Task 2):

```js
      if (pendingContext && Date.now() - pendingContext.at <= DRAWER_CONTEXT_FRESH_MS) {
        return pendingContext;
      }
      return null;
    }
```

Replace with:

```js
      if (pendingContext && Date.now() - pendingContext.at <= DRAWER_CONTEXT_FRESH_MS) {
        return pendingContext;
      }
      return null;
    }

    // Ownership predicate: one helper decides both rendering and
    // interception. A row is owned only when every condition holds;
    // any doubt means native behavior. Failure reasons carry the warn
    // key (one key per reason); the warn RAISE sites differ: markup and
    // title-mismatch raise from the renderer through the persistence
    // gate, ownership-lost raises only at its one-shot sites (the
    // unwind and the click safety net), so a cold start with absent
    // data never warns.
    function classifyDrawerRow(row) {
      if (!row.closest('div.trakt-drawer')) return { state: 'foreign' };
      const nameEl = row.querySelector('p');
      const name = nameEl ? nameEl.textContent.trim() : null;
      if (!name || !QUICK_LIST_NAMES.includes(name)) return { state: 'foreign' };
      const parsed = parseDrawerLabel(row.getAttribute('label'));
      if (!parsed || !row.querySelector('path')) return { state: 'failed', reason: 'drawer-markup' };
      if (!drawerContext) return { state: 'failed', reason: 'no-context' };
      if (parsed.title !== drawerContext.title) return { state: 'failed', reason: 'drawer-title-mismatch' };
      const target = quickLists.getListTarget(name);
      if (!target || quickLists.membershipState() === 'absent') {
        return { state: 'failed', reason: 'drawer-ownership-lost' };
      }
      return { state: 'owned', name, member: target.has(slugKeyOf(drawerContext.type, drawerContext.slug)) };
    }

    // Persistence gate: the drawer renders through healthy transients
    // that mimic the render-facing failures (item-switch label lag,
    // pre-resolution renders) and warnedTargets keys are page-lifetime,
    // so a candidate matures only when the same row still shows the
    // same failure WARN_SETTLE_MS after first seen. Registering a
    // candidate schedules its own re-check scan, so delivery never
    // depends on ambient churn reaching an idle page. The greyed and
    // spinner re-arm arms are dropped (probe 2026-08-07: no carrier
    // identified; spinner unrecorded), so the no-carrier residual in
    // the spec applies: a transient outliving the gate burns the key.
    function noteGatedWarn(row, reason, detail) {
      const seen = warnCandidates.get(row);
      if (!seen || seen.reason !== reason) {
        warnCandidates.set(row, { reason, firstSeen: Date.now() });
        setTimeout(queueScan, WARN_SETTLE_MS);
        return;
      }
      if (Date.now() - seen.firstSeen < WARN_SETTLE_MS) return;
      warnDrawerOnce(reason, detail);
    }

    function warnDrawerOnce(key, detail) {
      if (warnedTargets.has(key)) return;
      warnedTargets.add(key);
      warn('Manage-lists drawer: ' + detail);
    }
```

- [ ] **Step 3: Sanity-run the logic test**

Run: `node C:/Git/UserScripts/.tmp/mlrt-logic-test.mjs`
Expected: all `ok`, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): drawer ownership predicate and gated warn keys"
```

---

### Task 4: Drawer renderer, unwind, and attribute observer

**Files:**
- Modify: `trakt_improved.user.js` (inside `initQuickListToggles`)

**Interfaces:**
- Consumes: `classifyDrawerRow`, `warnCandidates`, `warnDrawerOnce`, `noteGatedWarn` (Task 3), `wantedDrawerLabel`, `MARKER_ATTR` (Task 1), `drawerContext` (Task 2), existing `quickLists.membershipState`, `quickLists.refreshMembership`, `slugKeyOf`, `queueScan`, `scanCallbacks`.
- Produces: `renderDrawer()`, `correctDrawerRow(row, verdict)`, `unwindDrawerRow(row, verdict)`, module-level `drawerObserved` WeakSet; `renderDrawer` registered in the feature's scan callback.

- [ ] **Step 1: Add the observed-drawer state**

Find the unique anchor (from Task 3's Step 1 result):

```js
    const warnCandidates = new WeakMap();
```

Replace with:

```js
    const warnCandidates = new WeakMap();
    // Drawer nodes carrying this feature's attribute observer (the
    // rating-labels instrumented WeakSet idiom): the drawer unmounts on
    // dismissal in the current app version, so each open's fresh node
    // gets a fresh observer, and a destroyed node takes its observer
    // with it.
    const drawerObserved = new WeakSet();
```

- [ ] **Step 2: Add the renderer functions**

Find the unique anchor (the closing of `warnDrawerOnce` from Task 3):

```js
    function warnDrawerOnce(key, detail) {
      if (warnedTargets.has(key)) return;
      warnedTargets.add(key);
      warn('Manage-lists drawer: ' + detail);
    }
```

Replace with:

```js
    function warnDrawerOnce(key, detail) {
      if (warnedTargets.has(key)) return;
      warnedTargets.add(key);
      warn('Manage-lists drawer: ' + detail);
    }

    // Drawer renderer. Corrections are attribute-only compare-then-write
    // (invisible to the shared childList body observer; the guard also
    // terminates the attribute observer's own bounce after one round).
    // Re-assertion is self-triggering: the per-node observer queues a
    // scan on any app patch to a row label or bookmark fill, whatever
    // transport delivered it, so a patch is re-asserted within a frame.
    function renderDrawer() {
      const drawer = document.querySelector('div.trakt-drawer');
      if (!drawer) return;
      if (!drawerObserved.has(drawer)) {
        drawerObserved.add(drawer);
        new MutationObserver(queueScan).observe(drawer, { subtree: true, attributes: true, attributeFilter: ['label', 'fill'] });
      }
      // Menu-open heal precedent: an open drawer heals stale or absent
      // membership data without a /discover visit; staleness-gated, so
      // per-frame calls are safe.
      if (quickLists.membershipState() !== 'fresh') quickLists.refreshMembership();
      for (const row of drawer.querySelectorAll('ul li')) {
        const verdict = classifyDrawerRow(row);
        if (verdict.state === 'foreign') continue;
        if (verdict.state === 'owned') {
          warnCandidates.delete(row);
          // Marker stamped on ownership, not on correction: the key
          // stays current on rows whose app state already agrees, so a
          // key mismatch always means an item change.
          const key = slugKeyOf(drawerContext.type, drawerContext.slug);
          if (row.getAttribute(MARKER_ATTR) !== key) row.setAttribute(MARKER_ATTR, key);
          correctDrawerRow(row, verdict);
          continue;
        }
        unwindDrawerRow(row, verdict);
      }
    }

    // data-variant and row order are never touched; the label rewrite
    // preserves the app's exact format.
    function correctDrawerRow(row, verdict) {
      const label = row.getAttribute('label') || '';
      const wanted = wantedDrawerLabel(label, verdict.member);
      if (label !== wanted) row.setAttribute('label', wanted);
      const path = row.querySelector('path');
      const fill = verdict.member ? 'currentColor' : 'transparent';
      if (path && path.getAttribute('fill') !== fill) path.setAttribute('fill', fill);
    }

    // Unwind: drop the marker, write nothing. Restoring pre-correction
    // attributes was designed and rejected (the app's current belief is
    // unobservable at unwind time: a patch converged onto engine truth
    // is value-indistinguishable from the script's own correction), and
    // the resulting mismatch windows are bounded and self-healing (see
    // the spec's unwind rationale). Warn only on a genuine same-item
    // ownership loss; stale residue and capture misses drop silently
    // (a title mismatch already warns through its own gated key in the
    // renderer classification).
    function unwindDrawerRow(row, verdict) {
      if (verdict.reason === 'drawer-markup') {
        noteGatedWarn(row, 'drawer-markup', 'quick-list row markup drifted; rows stay native');
      } else if (verdict.reason === 'drawer-title-mismatch') {
        noteGatedWarn(row, 'drawer-title-mismatch', 'row title does not match the captured item; rows stay native');
      }
      const marker = row.getAttribute(MARKER_ATTR);
      if (!marker) return;
      row.removeAttribute(MARKER_ATTR);
      const contextKey = drawerContext ? slugKeyOf(drawerContext.type, drawerContext.slug) : null;
      if (marker === contextKey && verdict.reason === 'drawer-ownership-lost') {
        warnDrawerOnce('drawer-ownership-lost', 'list de-resolved under corrected rows; rows returned to native');
      }
    }
```

- [ ] **Step 3: Register the renderer in the scan callback**

Find the unique anchor:

```js
    scanCallbacks.push(() => {
      renderPopup();
      renderSummary();
    });
```

Replace with:

```js
    scanCallbacks.push(() => {
      renderPopup();
      renderSummary();
      renderDrawer();
    });
```

- [ ] **Step 4: Sanity-run the logic test**

Run: `node C:/Git/UserScripts/.tmp/mlrt-logic-test.mjs`
Expected: all `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): correct drawer quick-list rows from engine truth"
```

---

### Task 5: Click interception

**Files:**
- Modify: `trakt_improved.user.js` (inside `initQuickListToggles`)

**Interfaces:**
- Consumes: `classifyDrawerRow`, `warnDrawerOnce` (Task 3), `parseDrawerLabel`, `MARKER_ATTR` (Task 1), `drawerContext` (Task 2), existing `performToggle`, `slugKeyOf`.
- Produces: `onDrawerEvent(e)` plus seven document-level capture-phase listener registrations. Nothing downstream consumes these; `performToggle`'s existing machinery (in-flight dedup, optimistic flip, invalidation-marker bump, write-triggered sweep, toast plus revert) is reused unchanged.

- [ ] **Step 1: Add the interception listeners**

Find the unique anchor (Task 4's renderer registration):

```js
    scanCallbacks.push(() => {
      renderPopup();
      renderSummary();
      renderDrawer();
    });
```

Replace with:

```js
    // Full-sequence suppression on owned drawer rows (the kebab-listener
    // pattern): which single event the app's delegated handler consumes
    // was never isolated, and suppressing the whole sequence removes the
    // question. keyup is included because the ARIA button convention
    // activates Space on keyup and a cancelled keydown does not suppress
    // the corresponding keyup; keypress is subsumed by the cancelled
    // keydown. Only click (and first, non-repeat keydown of Enter or
    // Space) fires the write, with add derived from the rendered label
    // verb at event time: the exact captured-state semantics of
    // onEntryClick, so the action always matches what the row displayed.
    // The drawer stays open after a write (native row behavior); the
    // app's confirm modal never appears for owned rows because its
    // handler never runs. Non-owned rows keep native behavior including
    // the confirm flow.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown', 'keyup']) {
      document.addEventListener(type, onDrawerEvent, true);
    }

    function onDrawerEvent(e) {
      if (!(e.target instanceof Element)) return;
      const drawer = e.target.closest('div.trakt-drawer');
      if (!drawer) return;
      const row = e.target.closest('div.trakt-drawer ul li');
      if (!row) return;
      if ((e.type === 'keydown' || e.type === 'keyup') && e.key !== 'Enter' && e.key !== ' ') return;
      const verdict = classifyDrawerRow(row);
      const marker = row.getAttribute(MARKER_ATTR);
      const contextKey = drawerContext ? slugKeyOf(drawerContext.type, drawerContext.slug) : null;
      // Safety net for the one-scan race between de-resolution and
      // unwind: a marked row in the same-item ownership-loss state must
      // not fall through to the app while showing script truth. A
      // marker for a different item, or a row showing a different
      // title, does not suppress; those rows are native.
      const lapsed = marker !== null && marker === contextKey
        && verdict.state === 'failed' && verdict.reason === 'drawer-ownership-lost';
      if (verdict.state !== 'owned' && !lapsed) return;
      e.preventDefault();
      e.stopPropagation();
      if (lapsed) {
        if (e.type === 'click') {
          warnDrawerOnce('drawer-ownership-lost', 'list de-resolved under corrected rows; click suppressed');
        }
        return;
      }
      if (e.type !== 'click' && !(e.type === 'keydown' && !e.repeat)) return;
      const parsed = parseDrawerLabel(row.getAttribute('label'));
      if (!parsed) return;
      performToggle({
        name: verdict.name,
        type: drawerContext.type,
        slug: drawerContext.slug,
        title: drawerContext.title,
        add: parsed.verb === 'Add',
      });
    }

    scanCallbacks.push(() => {
      renderPopup();
      renderSummary();
      renderDrawer();
    });
```

- [ ] **Step 2: Sanity-run the logic test**

Run: `node C:/Git/UserScripts/.tmp/mlrt-logic-test.mjs`
Expected: all `ok`, exit 0.

- [ ] **Step 3: Static sanity check of the whole file**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0 (the userscript is a plain script; `node --check` parses it).

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): intercept owned drawer row clicks into performToggle"
```

---

### Task 6: Version bump

**Files:**
- Modify: `trakt_improved.user.js` (metadata header)

**Interfaces:**
- Consumes: nothing. Produces: release-ready header (Tampermonkey updates only on version increase).

- [ ] **Step 1: Bump the version**

Find the unique anchor:

```js
// @version      1.34
```

Replace with:

```js
// @version      1.35
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "chore(trakt): bump Trakt Improved to 1.35"
```

---

## Deferred to the pipeline's e2e step (NOT part of this plan)

The spec's Verification plan (correction per entry point, interception with API-read confirmation, keyboard, fail-closed variants, ownership loss across two page loads, markup drift, reconciliation via simulated patch, first-open state, non-owned-row confirm flow) runs in the handover pipeline's verify-end-to-end step with a namespaced injected build, per the repo's e2e constraints. Live-probe notes that bind that step: menu rows require trusted clicks in the current app version, the drawer unmounts on dismissal, and the menu row string carries a trailing U+2026.
