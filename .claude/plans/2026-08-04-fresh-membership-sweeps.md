# Fresh Membership Sweeps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the list-membership engine's sweeps immune to Trakt's intermittently-stale server cache (marker-nonce busting) and make idle tabs sweep promptly when another tab bumps an invalidation marker (storage-event trigger).

**Architecture:** Both changes live inside the existing `initListMembership` closure in `trakt_improved.user.js` (the only file). Part A threads a per-`fetchAll` nonce into the sweep GETs as a `marker` query param, with a per-tab latch that disables busting if the server ever rejects the param (400/422). Part B registers one `storage` listener that debounces foreign marker bumps through a `WRITE_SETTLE_MS` timer into the engine's established forced-refresh idiom.

**Tech Stack:** Plain ES6+ userscript JavaScript, no build, no test framework. Verification per task is `node --check` (syntax) plus grep assertions; live e2e verification runs at the session level after implementation (spec section "Verification plan"), not inside this plan.

**Spec:** `.claude/features/fresh-membership-sweeps.md` (hardened; read it before deviating from any detail here).

## Global Constraints

- Edit only `C:/Git/UserScripts/trakt_improved.user.js`.
- Never use em-dashes, en-dashes, or emoji in code or comments; prose comments use `--` or plain hyphens.
- Comments state constraints the code cannot show, in the file's existing detailed-rationale style; no narration of what the next line does.
- Match surrounding indentation exactly (4 spaces at function-body depth inside the engine closure; the file uses 2-space steps).
- Commit subjects: Conventional Commits, max 72 chars, subject-only, no body, no Co-Authored-By trailer.
- Do NOT commit the plan file or any `.claude/` file in these commits; stage only `trakt_improved.user.js`.
- The file is CRLF; the Edit tool handles this transparently, but any scripted matching must strip `\r` from a matching copy only (never write a stripped copy back).
- Work on the current branch (master) directly; do not create worktrees or branches. Verify after each commit that it landed on master with `git log --oneline -1`.

---

### Task 1: Part A, marker-nonce busting with rejection latch

**Files:**
- Modify: `C:/Git/UserScripts/trakt_improved.user.js` (the `---- API sweep fetchers ----` region of `initListMembership`)

**Interfaces:**
- Consumes: existing `apiUrl`, `apiGet`, `warn`, `PAGE_LIMIT`.
- Produces: `mintNonce()` and module-level `bustingDisabled` inside the engine closure; `fetchPage(auth, path, page, nonce)` gains a fourth parameter. No consumer outside this task uses them (Task 2 is independent).

- [ ] **Step 1: Add the latch, nonce mint, and rejection detector above `fetchPage`**

Find this exact text (unique; it is `fetchPage`'s opening plus its two predecessors' close -- verify with a count first):

```js
    async function fetchPage(auth, path, page) {
      const url = apiUrl(path);
      url.searchParams.set('page', page);
      url.searchParams.set('limit', PAGE_LIMIT);
      const response = await apiGet(auth, url);
      const body = await response.json();
```

Replace with:

```js
    // Cache-busting nonce for sweep GETs, mirroring the app's own
    // marker= mechanism against the same server-side cache (the app
    // mints a per-page-load token; per-sweep uniqueness is all the
    // busting needs). bustingDisabled is the per-tab latch for the
    // server ever rejecting the param: 400/422 on a busted GET flips
    // it and every later sweep this session runs marker-less,
    // degrading to pre-1.29 behavior instead of a permanent sweep
    // outage. In-memory on purpose: a server-side fix heals on the
    // next page load. 401/403/404/429/5xx/network failures are NOT
    // param rejections and keep their existing stale-keep + backoff
    // routing untouched.
    let bustingDisabled = false;

    function mintNonce() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function noteBustingRejected(e) {
      const message = String(e && e.message);
      if (!bustingDisabled && (message.startsWith('HTTP 400 ') || message.startsWith('HTTP 422 '))) {
        bustingDisabled = true;
        warn('Server rejected the sweep cache-busting param; running marker-less until next page load', e);
      }
    }

    async function fetchPage(auth, path, page, nonce) {
      const url = apiUrl(path);
      url.searchParams.set('page', page);
      url.searchParams.set('limit', PAGE_LIMIT);
      if (nonce) {
        url.searchParams.set('marker', nonce);
      }
      let response;
      try {
        response = await apiGet(auth, url);
      } catch (e) {
        if (nonce) {
          noteBustingRejected(e);
        }
        throw e;
      }
      const body = await response.json();
```

- [ ] **Step 2: Thread the nonce through `fetchAll`**

Find this exact text (unique):

```js
    async function fetchAll(auth, path) {
      const items = [];
      for (let page = 1; ; page++) {
        const { batch, pageCount } = await fetchPage(auth, path, page);
```

Replace with:

```js
    async function fetchAll(auth, path) {
      // One nonce per collection: a single mint site per call, not a
      // cross-page consistency mechanism (each page URL is its own
      // cache key either way; torn reads across pages match today's
      // marker-less behavior and the next sweep owns healing them).
      const nonce = bustingDisabled ? null : mintNonce();
      const items = [];
      for (let page = 1; ; page++) {
        const { batch, pageCount } = await fetchPage(auth, path, page, nonce);
```

- [ ] **Step 3: Bust `fetchWatchedProgress` with its own nonce**

Find this exact text (unique -- the `specials` line only occurs here):

```js
      const url = apiUrl('/users/me/watched/shows');
      url.searchParams.set('extended', 'min');
      url.searchParams.set('season_numbers', 'true');
      url.searchParams.set('specials', 'true');
      const response = await apiGet(auth, url);
      const body = await response.json();
```

Replace with:

```js
      const url = apiUrl('/users/me/watched/shows');
      url.searchParams.set('extended', 'min');
      url.searchParams.set('season_numbers', 'true');
      url.searchParams.set('specials', 'true');
      const nonce = bustingDisabled ? null : mintNonce();
      if (nonce) {
        url.searchParams.set('marker', nonce);
      }
      let response;
      try {
        response = await apiGet(auth, url);
      } catch (e) {
        if (nonce) {
          noteBustingRejected(e);
        }
        throw e;
      }
      const body = await response.json();
```

- [ ] **Step 4: Verify syntax and busting scope**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output (clean parse).

Run: `grep -c "set('marker'" C:/Git/UserScripts/trakt_improved.user.js || true`
Expected: `2` (fetchPage and fetchWatchedProgress only; the five un-busted `apiGet` call sites -- external links, the three list-counts reads, truncate -- must NOT gain the param).

Run: `grep -n "mintNonce\|bustingDisabled\|noteBustingRejected" C:/Git/UserScripts/trakt_improved.user.js`
Expected: roughly a dozen lines (declarations, uses, comment mentions); the assertion that matters is that every hit sits inside the engine closure, between the `---- API sweep fetchers ----` comment and `splitWatchedShows`.

- [ ] **Step 5: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): bust membership sweep reads with marker nonce"
git -C C:/Git/UserScripts log --oneline -1
```

Expected: the new commit on master.

---

### Task 2: Part B, storage-event sweep trigger

**Files:**
- Modify: `C:/Git/UserScripts/trakt_improved.user.js` (the sweep-scheduling region of `initListMembership`)

**Interfaces:**
- Consumes: existing `MARKER_PREFIX`, `WRITE_SETTLE_MS`, `refreshInFlight`, `pendingForcedRefresh`, `forceRefresh`, `queueRefresh` (hoisted function declaration, callable before its definition site).
- Produces: nothing consumed elsewhere; one listener plus one timer handle local to the engine closure.

- [ ] **Step 1: Register the listener after the mutation-hook callback**

Find this exact text (the three-line body is unique; the other `mutationCallbacks.push` in the file has a different body):

```js
    mutationCallbacks.push(() => {
      forceRefresh = true;
    });
```

Replace with:

```js
    mutationCallbacks.push(() => {
      forceRefresh = true;
    });

    // Cross-tab prompt trigger: another tab's marker bump (script
    // quick-toggle via SELF_MARKER_KEY, or the app's own listed:* /
    // watchlisted:* / mark_as_watched:* bumps on native actions)
    // sweeps this tab without waiting for a DOM-mutation scan, which
    // an idle tab may never run. Storage events fire only in tabs
    // that did not perform the write, so every matching event is
    // foreign by construction (a null key, as from localStorage
    // .clear(), fails the prefix test). The single debounced timer
    // waits WRITE_SETTLE_MS before sweeping: the writer bumps the
    // instant its POST resolves, and a zero-delay read could commit
    // pre-write server state as fresh with no ledger entry here to
    // correct it. The in-flight branch mirrors scheduleSuspectResweep;
    // the scan-driven markersChanged() check stays as catch-up for
    // bumps that landed while no listener was alive.
    let foreignBumpTimer = 0;
    window.addEventListener('storage', e => {
      if (!e.key || !e.key.startsWith(MARKER_PREFIX)) return;
      clearTimeout(foreignBumpTimer);
      foreignBumpTimer = setTimeout(() => {
        foreignBumpTimer = 0;
        if (refreshInFlight) {
          pendingForcedRefresh = true;
        } else {
          forceRefresh = true;
          queueRefresh();
        }
      }, WRITE_SETTLE_MS);
    });
```

- [ ] **Step 2: Verify syntax and listener uniqueness**

Run: `node --check C:/Git/UserScripts/trakt_improved.user.js`
Expected: no output.

Run: `grep -c "addEventListener('storage'" C:/Git/UserScripts/trakt_improved.user.js || true`
Expected: `1`.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "feat(trakt): sweep on foreign marker bumps via storage events"
git -C C:/Git/UserScripts log --oneline -1
```

Expected: the new commit on master.

---

### Task 3: Version bump

**Files:**
- Modify: `C:/Git/UserScripts/trakt_improved.user.js` (metadata header)

**Interfaces:**
- Consumes: nothing. Produces: the 1.29 release marker Tampermonkey needs to pick up the update.

- [ ] **Step 1: Bump the version**

Find this exact text (unique):

```js
// @version      1.28
```

Replace with:

```js
// @version      1.29
```

- [ ] **Step 2: Verify**

Run: `grep -n "@version" C:/Git/UserScripts/trakt_improved.user.js`
Expected: exactly one line, showing `1.29`.

- [ ] **Step 3: Commit**

```bash
git -C C:/Git/UserScripts add trakt_improved.user.js
git -C C:/Git/UserScripts commit -m "chore(trakt): bump version to 1.29"
git -C C:/Git/UserScripts log --oneline -1
```

Expected: the new commit on master.
