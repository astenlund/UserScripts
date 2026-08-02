# Stale-Membership Corrector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the post-write corrector sweep in trakt_improved.user.js from reverting confirmed quick-list toggle writes when Trakt's server cache serves pre-write list items.

**Architecture:** A tab-local confirmed-write ledger inside the list-membership engine defends body-judged-successful quick-toggle writes for a 30s trust window: the sweep reconciles fetched `listed` data against the ledger at commit time (patching contradictions pre-commit and scheduling escalating re-sweeps), while two foreign-write signals (page fetch hook, invalidation-marker movement) drop the ledger so the design never knowingly fights another writer. A modest settle bump (`WRITE_SETTLE_MS = 2000`) delays the write-triggered forced sweep.

**Tech Stack:** Vanilla JavaScript userscript (Tampermonkey), no build, no test framework. Syntax gate: `node --check`.

**Spec:** The entry "Write-triggered membership refresh can read server-cache-stale list items" in `.claude/QUICK_WINS.md` (hardened 2026-08-03). Consult it for rationale; this plan is the mechanical execution.

## Global Constraints

- Single file changes only: `C:/Git/UserScripts/trakt_improved.user.js` (this repo has no build step; the file must stay directly runnable).
- Never use em-dashes, en-dashes, or emoji in any generated text, including comments and commit messages. Use `--` in prose comments if needed.
- JavaScript: `const`/`let` only, never `var`. Match the file's existing comment density and style (block comments above functions explaining constraints, not narration).
- After each task, run `node --check C:/Git/UserScripts/trakt_improved.user.js` (the only automated gate; there is no test suite) and commit with the exact message given in the task. One commit per task, subject-only, no body, no Co-Authored-By trailer.
- Do NOT stage or commit `.claude/plans/2026-08-03-stale-membership-corrector.md`, `.claude/QUICK_WINS.md`, or anything under `.tmp/` in any task of this plan. Stage exactly `trakt_improved.user.js`.
- Do NOT bump `@version` in Tasks 1-6; Task 7 owns the single bump to 1.26.
- All edit anchors below are verbatim text from the current file and are unique unless stated otherwise. If an anchor fails to match, STOP and report; do not improvise a similar edit.

---

### Task 1: WRITE_SETTLE_MS and the write-triggered settle bump

**Files:**
- Modify: `trakt_improved.user.js` (list-membership engine IIFE: constants near `CACHE_TTL_MS`, and `quickLists.refreshMembership`)

**Interfaces:**
- Consumes: existing `MUTATION_SETTLE_MS` (script scope, stays 1000, untouched), `sweepStartedAt`, `pendingForcedRefresh`, `forceRefresh`, `queueRefresh`.
- Produces: engine-scoped `const WRITE_SETTLE_MS = 2000` used by later tasks' comments only; no signature changes.

- [ ] **Step 1: Add the constant**

Find (unique):

```javascript
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const PAGE_LIMIT = 1000;
```

Replace with:

```javascript
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const PAGE_LIMIT = 1000;
    // Settle window for the write-triggered corrector: longer than
    // notifyMutation's MUTATION_SETTLE_MS because the observed server
    // staleness already reached ~2s post-write. No settle value is
    // sufficient alone (the lag is unbounded); the confirmed-write
    // ledger below is the actual defense, this just cheapens the case
    // where the forced sweep is the first post-write sweep.
    const WRITE_SETTLE_MS = 2000;
```

- [ ] **Step 2: Swap both uses in the write-triggered flavor**

Find (unique, the whole comment plus function):

```javascript
    // Write-triggered flavor: waits the same settle window notifyMutation
    // uses (the server needs time to reflect the write before a refetch,
    // or the sweep reads pre-write state and stamps it fresh), rides the
    // pending flag when the in-flight sweep cannot be trusted to have seen
    // the write, and bypasses the backoff via forceRefresh. A sweep counts
    // as covering the write only when it started AFTER the settle window
    // closed: one that started inside the window may still have fetched
    // pre-write state (one click, one sweep otherwise). Menu-open flavor:
    // staleness-gated, respects backoff.
    quickLists.refreshMembership = ({ writeTriggered = false } = {}) => {
      if (!writeTriggered) {
        if (membershipStale()) queueRefresh();
        return;
      }
      const settledAt = Date.now();
      setTimeout(() => {
        if (refreshInFlight) {
          if (sweepStartedAt < settledAt + MUTATION_SETTLE_MS) pendingForcedRefresh = true;
        } else {
          forceRefresh = true;
          queueRefresh();
        }
      }, MUTATION_SETTLE_MS);
    };
```

Replace with:

```javascript
    // Write-triggered flavor: waits a longer settle window than
    // notifyMutation's (the server needs time to reflect the write before
    // a refetch, or the sweep reads pre-write state and stamps it fresh),
    // rides the pending flag when the in-flight sweep cannot be trusted to
    // have seen the write, and bypasses the backoff via forceRefresh. A
    // sweep counts as covering the write only when it started AFTER the
    // settle window closed: one that started inside the window may still
    // have fetched pre-write state (one click, one sweep otherwise), which
    // with the widened window guarantees a post-settle sweep exists.
    // Menu-open flavor: staleness-gated, respects backoff.
    quickLists.refreshMembership = ({ writeTriggered = false } = {}) => {
      if (!writeTriggered) {
        if (membershipStale()) queueRefresh();
        return;
      }
      const settledAt = Date.now();
      setTimeout(() => {
        if (refreshInFlight) {
          if (sweepStartedAt < settledAt + WRITE_SETTLE_MS) pendingForcedRefresh = true;
        } else {
          forceRefresh = true;
          queueRefresh();
        }
      }, WRITE_SETTLE_MS);
    };
```

- [ ] **Step 3: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): widen write-triggered settle to 2s"
```

---

### Task 2: Extract patchTargetMembership with the guard inside

**Files:**
- Modify: `trakt_improved.user.js` (list-membership engine IIFE: `quickLists.applyListToggle`)

**Interfaces:**
- Produces: engine-scoped `function patchTargetMembership(target, slugKey, add) -> boolean` where `target` is a non-null listed target `{id, slugs, fadeSlugs, key}`; returns `true` iff exact membership (`slugs`) changed, and touches NEITHER array when it returns `false`. Task 5's reconciliation depends on exactly this contract.

- [ ] **Step 1: Replace applyListToggle's inline logic with the helper**

Find (unique, the whole comment plus function):

```javascript
    // Optimistic patch, not a sweep: mutates the target in place,
    // rebuilds the derived sets so the quick-category fade flips in the
    // same frame as the toggle icon, persists WITHOUT touching fetchedAt
    // (stamping a patch fresh would park an unreconciled write behind
    // the full TTL; the untouched timestamp is what lets an interrupted
    // session heal), and queues a rescan. counts is no longer touched:
    // quick lists are carved out of it. Deliberately approximate in the
    // removal direction: fadeSlugs has set semantics and cannot record
    // whether a surviving season/episode entry of the same show still
    // justifies membership, so that rare removal transiently un-fades
    // until the post-write forced sweep restores authoritative data.
    quickLists.applyListToggle = (name, slugKey, add) => {
      const listed = cache.listed;
      const target = listed && listed.targets[name];
      if (!target) return;
      const exact = new Set(target.slugs);
      if (add === exact.has(slugKey)) return;
      const fadeSet = new Set(target.fadeSlugs);
      if (add) {
        exact.add(slugKey);
        fadeSet.add(slugKey);
      } else {
        exact.delete(slugKey);
        fadeSet.delete(slugKey);
      }
      target.slugs = [...exact];
      target.fadeSlugs = [...fadeSet];
      sets = buildSets(cache);
      persistCache();
      queueScan();
    };
```

Replace with:

```javascript
    // Shared membership patch for the optimistic toggle and the sweep's
    // commit-time reconciliation. The exact-membership guard lives INSIDE
    // and short-circuits BEFORE either set is touched: fadeSlugs is a
    // strict superset of slugs (a season entry contributes its parent
    // show), so patching fadeSlugs on a no-op would strip a legitimately
    // season-backed fade from otherwise-agreeing data. Deliberately
    // approximate in the removal direction: fadeSlugs has set semantics
    // and cannot record whether a surviving season/episode entry of the
    // same show still justifies membership, so that rare removal
    // transiently un-fades until a later sweep restores authoritative
    // data. Returns whether exact membership changed.
    function patchTargetMembership(target, slugKey, add) {
      const exact = new Set(target.slugs);
      if (add === exact.has(slugKey)) return false;
      const fadeSet = new Set(target.fadeSlugs);
      if (add) {
        exact.add(slugKey);
        fadeSet.add(slugKey);
      } else {
        exact.delete(slugKey);
        fadeSet.delete(slugKey);
      }
      target.slugs = [...exact];
      target.fadeSlugs = [...fadeSet];
      return true;
    }

    // Optimistic patch, not a sweep: mutates the target in place,
    // rebuilds the derived sets so the quick-category fade flips in the
    // same frame as the toggle icon, persists WITHOUT touching fetchedAt
    // (stamping a patch fresh would park an unreconciled write behind
    // the full TTL; the untouched timestamp is what lets an interrupted
    // session heal), and queues a rescan. counts is no longer touched:
    // quick lists are carved out of it.
    quickLists.applyListToggle = (name, slugKey, add) => {
      const listed = cache.listed;
      const target = listed && listed.targets[name];
      if (!target) return;
      if (!patchTargetMembership(target, slugKey, add)) return;
      sets = buildSets(cache);
      persistCache();
      queueScan();
    };
```

- [ ] **Step 2: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "refactor(trakt): extract patchTargetMembership helper"
```

---

### Task 3: Confirmed-write ledger core

**Files:**
- Modify: `trakt_improved.user.js` (list-membership engine IIFE: sweep-scheduling state block, and the consumer-surface block where `quickLists.bumpInvalidationMarker` is defined)

**Interfaces:**
- Consumes: `currentMarkers()` (existing, engine scope).
- Produces (all engine scope unless exposed): `WRITE_TRUST_WINDOW_MS = 30_000`; `SUSPECT_RETRY_BASE_MS = 5000`; `confirmedWrites` Map keyed `` `${name}:${slugKey}` `` with value `{name, slugKey, add, confirmedAt, markers}` (`markers` is the note-time `currentMarkers()` snapshot; the key is an opaque dedup handle, never parsed); `nextRetryDelay` (number, ms); `retryTimer` (timer handle, 0 when idle); `cancelRetryTimer()`; exposed `quickLists.noteConfirmedWrite(name, slugKey, add)` and `quickLists.dropConfirmedWrites()`. Tasks 4-6 use these exact names.

- [ ] **Step 1: Add ledger state next to the sweep-scheduling flags**

Find (unique):

```javascript
    let pendingForcedRefresh = false;
    let sweepStartedAt = 0;
```

Replace with:

```javascript
    let pendingForcedRefresh = false;
    let sweepStartedAt = 0;

    // Confirmed-write ledger: the script's own body-judged-successful
    // quick-toggle writes, defended against server-cache-stale corrector
    // reads until the trust window closes. Tab-local and non-persisted on
    // purpose: cross-tab clobbering is out of scope (see BUGS.md), and a
    // reload inside the window is left to self-healing. Entries leave by
    // agreement, expiry, or a foreign-write drop; past the window server
    // truth wins unconditionally.
    const WRITE_TRUST_WINDOW_MS = 30 * 1000;
    const SUSPECT_RETRY_BASE_MS = 5 * 1000;
    const confirmedWrites = new Map();
    let nextRetryDelay = SUSPECT_RETRY_BASE_MS;
    let retryTimer = 0;

    function cancelRetryTimer() {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = 0;
      }
    }
```

- [ ] **Step 2: Expose the two surfaces next to bumpInvalidationMarker**

Find (unique, the end of `bumpInvalidationMarker` plus the comment that follows it):

```javascript
      selfMarkerValue = value;
      if (committedMarkers && typeof committedMarkers === 'object') {
        committedMarkers[SELF_MARKER_KEY] = value;
        writeJson(MARKER_SNAPSHOT_KEY, committedMarkers);
      }
    };

    // Write-triggered flavor: waits a longer settle window than
```

Replace with:

```javascript
      selfMarkerValue = value;
      if (committedMarkers && typeof committedMarkers === 'object') {
        committedMarkers[SELF_MARKER_KEY] = value;
        writeJson(MARKER_SNAPSHOT_KEY, committedMarkers);
      }
    };

    // Ledger writer for the toggles feature: called only on body-judged
    // success, AFTER bumpInvalidationMarker (the captured snapshot must
    // include this write's own bump, or the entry would read itself as
    // foreign). Latest write to the same item wins. A new write resets
    // the retry ladder but leaves a pending retry timer alone: the
    // write's own write-triggered sweep already covers promptness.
    quickLists.noteConfirmedWrite = (name, slugKey, add) => {
      confirmedWrites.set(`${name}:${slugKey}`, { name, slugKey, add, confirmedAt: Date.now(), markers: currentMarkers() });
      nextRetryDelay = SUSPECT_RETRY_BASE_MS;
    };

    // Foreign-write surrender: neither drop signal says what changed, so
    // the whole ledger yields. Deliberately coarse: it may abandon
    // protection for an unrelated pending write, trading a rare transient
    // revert for never knowingly fighting another writer.
    quickLists.dropConfirmedWrites = () => {
      confirmedWrites.clear();
      cancelRetryTimer();
    };

    // Write-triggered flavor: waits a longer settle window than
```

- [ ] **Step 3: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): add confirmed-write ledger core"
```

---

### Task 4: Foreign-write drop signals

**Files:**
- Modify: `trakt_improved.user.js` (shared-plumbing fetch hook, and `quickLists.bumpInvalidationMarker` in the engine)

**Interfaces:**
- Consumes: `quickLists.dropConfirmedWrites()` (Task 3), `SELF_MARKER_KEY`, `selfMarkerValue`.
- Produces: no new names; behavioral wiring only.

- [ ] **Step 1: Drop the ledger on same-tab native writes in the fetch hook**

Find (unique):

```javascript
        result.then(response => {
          if (response.ok) {
            notifyMutation();
          }
        }, () => {
```

Replace with:

```javascript
        result.then(response => {
          if (response.ok) {
            notifyMutation();
            // A successful native write is the one same-tab signal the
            // membership engine's confirmed-write ledger must yield to;
            // script writes ride the sandbox fetch and never pass here.
            // The response arrives in real time, so it is always later
            // than any ledgered write. quickLists is initialized long
            // before any response can arrive (the IIFE runs to completion
            // synchronously), but the method is feature-owned, so guard.
            if (quickLists.dropConfirmedWrites) quickLists.dropConfirmedWrites();
          }
        }, () => {
```

- [ ] **Step 2: Pre-bump foreign-value read in bumpInvalidationMarker**

Find (unique):

```javascript
    quickLists.bumpInvalidationMarker = () => {
      const value = String(Date.now());
      try {
        localStorage.setItem(SELF_MARKER_KEY, value);
      } catch {
```

Replace with:

```javascript
    quickLists.bumpInvalidationMarker = () => {
      const value = String(Date.now());
      try {
        // Both tabs write this key, and overwriting it is the one act
        // that can erase the evidence of a foreign bump before the
        // ledger's per-entry snapshot comparison sees it. Read first and
        // surrender the ledger when the live value is not this tab's
        // own; the only residual blind spot is a foreign bump landing
        // inside this read-then-write instant.
        if (localStorage.getItem(SELF_MARKER_KEY) !== selfMarkerValue) {
          quickLists.dropConfirmedWrites();
        }
        localStorage.setItem(SELF_MARKER_KEY, value);
      } catch {
```

Note: on the very first bump of a session `selfMarkerValue` is `null` and a stale value from an earlier session reads as foreign; the drop is a harmless no-op there because `noteConfirmedWrite` always runs after the bump (Task 6's call order), so the ledger is empty at that point for the write being processed.

- [ ] **Step 3: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): drop ledger on foreign write signals"
```

---

### Task 5: Commit-time reconciliation and escalating re-sweep

**Files:**
- Modify: `trakt_improved.user.js` (engine: helpers before `refresh()`, and the `listed.status === 'fulfilled'` branch inside `refresh()`)

**Interfaces:**
- Consumes: `confirmedWrites`, `WRITE_TRUST_WINDOW_MS`, `nextRetryDelay`, `retryTimer`, `cancelRetryTimer()`, `patchTargetMembership` (Task 2), `currentMarkers()`, `SELF_MARKER_KEY`, `selfMarkerValue`, `refreshInFlight`, `pendingForcedRefresh`, `forceRefresh`, `queueRefresh`, `warn`.
- Produces: engine-scoped `reconcileConfirmedWrites(targets, now) -> boolean` (true when the sweep is suspect), `foreignMarkersMoved(snapshot) -> boolean`, `scheduleSuspectResweep()`. No exposed surfaces.

- [ ] **Step 1: Add the three helpers directly above refresh()**

Find (unique, the comment above `refresh()`):

```javascript
    // Single-flight, atomic per category: a category's record is replaced only
    // when every fetch it depends on succeeded; otherwise it keeps its stale
    // record wholesale and the backoff gates the next attempt.
    async function refresh() {
```

Replace with:

```javascript
    // Foreign movement relative to a ledger entry's note-time snapshot.
    // Compared per entry, never against the engine's committed snapshot:
    // an unabsorbed bump that predates the write must not read as
    // foreign to it. This tab's own later bumps are exempted via
    // selfMarkerValue; every other difference is another writer and wins.
    function foreignMarkersMoved(snapshot) {
      const current = currentMarkers();
      const keys = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
      for (const key of keys) {
        if (current[key] === snapshot[key]) continue;
        if (key === SELF_MARKER_KEY && current[key] === selfMarkerValue) continue;
        return true;
      }
      return false;
    }

    // Commit-time reconciliation: runs against the fetched listed record
    // BEFORE it becomes cache, so every post-confirmation fetch/write
    // interleaving is covered at the single commit point. Expiry first
    // (with diagnostics: a still-contradicted expiry means the server
    // never caught up and the stale-read bug recurred for that item; a
    // missing target means the entry expired unverifiable), then the
    // foreign-marker drop, then patch-or-agree via the shared helper,
    // whose true return IS the contradiction signal. Suspect commits are
    // not failures: no lastFailureAt, no backoff, no rearm.
    function reconcileConfirmedWrites(targets, now) {
      let suspect = false;
      for (const [key, entry] of confirmedWrites) {
        const target = targets[entry.name];
        if (now - entry.confirmedAt > WRITE_TRUST_WINDOW_MS) {
          if (!target) {
            warn(`Confirmed ${entry.add ? 'add' : 'remove'} of ${entry.slugKey} expired unverifiable; list "${entry.name}" never re-resolved`);
          } else if (target.slugs.includes(entry.slugKey) !== entry.add) {
            warn(`Confirmed ${entry.add ? 'add' : 'remove'} of ${entry.slugKey} expired still contradicted; the server never caught up`);
          }
          confirmedWrites.delete(key);
          continue;
        }
        if (foreignMarkersMoved(entry.markers)) {
          confirmedWrites.delete(key);
          continue;
        }
        if (!target) continue;
        if (patchTargetMembership(target, entry.slugKey, entry.add)) {
          suspect = true;
        } else {
          confirmedWrites.delete(key);
        }
      }
      if (confirmedWrites.size === 0) cancelRetryTimer();
      return suspect;
    }

    // One pending retry at a time; the ladder (5s, 10s, 20s) advances
    // only when a retry is actually scheduled, so the two early sweeps
    // one write can produce advance it at most once. The trust window
    // terminates the loop: a retry firing past it prunes the entry and
    // commits server truth.
    function scheduleSuspectResweep() {
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        if (refreshInFlight) {
          pendingForcedRefresh = true;
        } else {
          forceRefresh = true;
          queueRefresh();
        }
      }, nextRetryDelay);
      nextRetryDelay *= 2;
    }

    // Single-flight, atomic per category: a category's record is replaced only
    // when every fetch it depends on succeeded; otherwise it keeps its stale
    // record wholesale and the backoff gates the next attempt.
    async function refresh() {
```

- [ ] **Step 2: Wire reconciliation into the listed commit**

Find (unique):

```javascript
        if (listed.status === 'fulfilled') {
          cache.listed = Object.assign({}, listed.value, { fetchedAt: now });
          changed = true;
        } else {
```

Replace with:

```javascript
        if (listed.status === 'fulfilled') {
          const suspect = reconcileConfirmedWrites(listed.value.targets, now);
          cache.listed = Object.assign({}, listed.value, { fetchedAt: now });
          changed = true;
          if (suspect) scheduleSuspectResweep();
        } else {
```

Note: `reconcileConfirmedWrites` mutates `listed.value.targets` in place; the `Object.assign` commit is shallow, so patched targets ride into `cache.listed` and from there into `buildSets`/`persistCache` further down the existing function. That is the intended mechanism, not an accident; do not deep-clone.

- [ ] **Step 3: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): reconcile confirmed writes at sweep commit"
```

---

### Task 6: Note confirmed writes in performToggle

**Files:**
- Modify: `trakt_improved.user.js` (quick-list toggles feature: `performToggle`)

**Interfaces:**
- Consumes: `quickLists.noteConfirmedWrite(name, slugKey, add)` (Task 3); locals `ok`, `name`, `slugKey`, `add` already in scope at the insertion point.

- [ ] **Step 1: Insert the gated call between the bump and the forced refresh**

Find (unique):

```javascript
      notifyMutation();
      quickLists.bumpInvalidationMarker();
      quickLists.refreshMembership({ writeTriggered: true });
```

Replace with:

```javascript
      notifyMutation();
      quickLists.bumpInvalidationMarker();
      // Only body-judged success enters the ledger (the block around it
      // runs on every settled outcome); after the bump, so the entry's
      // marker snapshot includes this write's own bump.
      if (ok) {
        quickLists.noteConfirmedWrite(name, slugKey, add);
      }
      quickLists.refreshMembership({ writeTriggered: true });
```

- [ ] **Step 2: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): note confirmed quick-toggle writes"
```

---

### Task 7: Version bump

**Files:**
- Modify: `trakt_improved.user.js` (metadata header)

- [ ] **Step 1: Bump @version**

Find (unique):

```javascript
// @version      1.25
```

Replace with:

```javascript
// @version      1.26
```

- [ ] **Step 2: Syntax check**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "chore(trakt): bump trakt improved to 1.26"
```

---

## Post-plan verification (owned by the handover pipeline, not by plan tasks)

E2e verification (two-direction simulated cache lag via a wrapped `fetchListedData` in a namespaced injected build, plus the live probe for the `(live-claim: provisional)` marker) and the landing walk (history archive, BUGS.md mirror note, title-citation updates in the four citing files) are specified in the QUICK_WINS.md entry's "Verification and landing" bullet and run as handover steps 6-8 after code review. They are deliberately not plan tasks.
