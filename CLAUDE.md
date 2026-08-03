# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commit Conventions

This repo does not use the floating "CLAUDE" commit convention. Changes to CLAUDE.md and `.claude/*` files are committed as regular Conventional Commits, and may share a commit with related changes when they belong to the same logical change.

## Repository Overview

This is a collection of userscripts (Greasemonkey/Tampermonkey scripts) that enhance various websites. Each script is a standalone JavaScript file with userscript metadata headers.

## Common Development Tasks

### Creating a New Userscript

When creating a new userscript, follow this template structure:

```javascript
// ==UserScript==
// @name         Script Name
// @namespace    fork-scripts
// @version      0.1
// @description  try to take over the world!
// @author       Andreas Stenlund
// @match        https://example.com/*
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/filename.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/filename.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';
    
    // Your code here
})();
```

### Script Categories and Patterns

**Search Focuser Scripts** (search_focuser_*.user.js):
- Automatically focus search boxes and handle ESC key
- Use the established pattern with `focusSearch()` and `focusKey()` functions

**Keyboard Navigation Scripts**:
- Add keyboard shortcuts to websites
- Use modern ES6+ syntax with arrow functions
- Wrap in IIFE pattern

**Integration Scripts**:
- Add cross-site functionality (e.g., adding links between services)
- May assume jQuery is available on target sites

## Code Architecture

### No Build Process
- Scripts are edited directly and committed as-is
- No compilation, bundling, or transpilation needed
- No npm dependencies or package.json

### Script Distribution
- Scripts are distributed via GitHub raw URLs
- Users install by clicking the raw file link in their userscript manager
- The `@downloadURL` metadata enables auto-updates

### Code Patterns
- Each script is completely self-contained
- No shared utilities or common code between scripts
- Mix of old-style JavaScript and ES6+ depending on script age
- Most scripts use vanilla JavaScript, some assume jQuery on target site
- Scripts that observe `document.body` with `childList: true, subtree: true` and mutate the DOM from the callback must make those writes idempotent: compare current state to target and return early. A childList observer fires on any node add or remove, including an `innerHTML` write that reproduces byte-identical markup, so an unconditional write retriggers the callback that made it and loops every frame. Attribute-only writes (class toggles, inline styles) do not fire it.

## trakt_improved.user.js

One shared body observer requeues every feature's scan callback per animation frame, so the idempotence rule above applies to every scan callback in this file.

### e2e testing

- The installed Tampermonkey copy keeps running in the tab you inject into: both instances share the localStorage caches (version stamps make them ping-pong as each instance refreshes), both fetch hooks see the same writes, and either can toggle fade classes. Disable the installed script for the run if possible; when it is not (extension pages are unreachable from browser tooling), inject a namespaced build instead: rename the feature's localStorage keys, CSS class/style-id string constants, and DOM marker attributes (e.g. `-e2e` key suffixes, `tff2-*` class and style id, `data-qlt2-*` attrs) so the two instances cannot fight over classes or ping-pong cache versions (the rename must cover every key carrying a version stamp: two builds whose `CACHE_VERSION` values differ under one storage key re-normalize each other's cache to null on every load). Marker attributes are the third rename axis and missing it is not cosmetic: the menu-row template filter selects `li`s lacking *its own* entry attribute, so a renamed instance treats the other instance's injected row as a valid template and clones it, and the clone inherits the other's marker; probes that identify an instance's rows must require its own attribute AND the absence of the other's. The installed copy then doubles as a live regression oracle on surfaces where both are active. As a last resort, verify server-side effects via the API rather than UI state.
- Synthetic `anchor.click()` on an in-DOM `a[href]` performs SPA navigation without a page reload (the app intercepts link clicks), so an injected instance survives route changes; a temporary appended anchor works for routes with no on-page link.
- Page CSP blocks fetches to localhost. Inject code through the browser tooling instead of loading it over HTTP.
- app.trakt.tv card grids are virtualized: cards hydrate only near the viewport and only after real scroll events. Synthetic (untrusted) clicks do not open or close the app's menus; the summary-actions underlay is the one dismissal surface that accepts them. Menus also do not survive tool-call boundaries: the popup and summary-actions menus dismiss when a browser-tooling eval or screenshot runs between trusted clicks (focus/visibility loss from the tooling call), so a screenshot-probe-click sequence spread across separate tool calls cannot hold a menu open. Menus DO survive within a single browser_batch call (verified for the summary actions menu, including open-menu-then-click-row chains and interleaved evals/screenshots), so chain every trusted click a menu interaction needs into one batch, with coordinates taken from a screenshot in an earlier call; outside a batch, verify write paths flow-level instead, driving the feature's entry function through the window handle described below, and reserve real-click probes for what only the UI can prove (row placement, icon state, native styling).
- Since the popup scroll shield shipped (Trakt Improved 1.24), wheel and scroll events are swallowed at window capture while a popup menu is rendered and at least partially in the viewport, so scroll-driven card hydration pauses during that window; close any open popup before e2e steps that rely on real scrolls to hydrate. Related trap for geometry probes: the popup container (`.trakt-popup-menu-container`) is a zero-height positioning anchor on list-page surfaces and during the card popup's open animation; the inner `ul` carries the menu's real geometry, so measure the `ul`, never the container.
- Injected e2e builds live in `.tmp/` as a trimmed bundle: shared plumbing plus only the feature IIFEs under test, with non-behavioral text removed until the whole script fits a single browser-tooling eval call. Page-context probes cannot reach closure state, so the build must also publish the surface under test on a window handle (e.g. `pageWindow.__tff2 = quickLists`). The `.user.js` sources are CRLF with no `.gitattributes` to normalize them, so a Node build script that matches multi-line anchors against them must strip `\r` from a copy used for matching only: single-line substring matches succeed despite the `\r`, so the failure appears solely on multi-line anchors and reads as "anchor not found", masquerading as wrong anchor text. Never write the stripped copy back; that rewrites every line ending in the file.
- The claude-in-chrome network tracker sees at most the OPTIONS preflights of the app's cross-origin apiz calls and misses most GETs and POSTs entirely (observed 2026-08-03: a completed authenticated GET logged only as its preflight, a userscript write POST not at all), so an absent request in read_network_requests is never evidence the request was not sent. Verify server-side effects with an authenticated API read instead.
- App-side caching (verified 2026-08-03 while closing the quick-toggle bug): the app's apiz GETs carry a per-page-load `marker=` cache-busting token; the `trakt-marker:invalidate:*` localStorage keys feed that token only at page load, and the app registers no storage listener, so neither bumping a marker key nor dispatching a synthetic StorageEvent invalidates an already-open tab. Panels like Manage lists render from a client-side query cache and fire no request on reopen, though the app self-converges within roughly 30s (an open panel was observed refetching and flipping to post-write state). Userscript writes are therefore invisible to the app's own UI for up to ~30s (a reload converges it immediately); verify script writes via the script's surfaces or API reads, never via the app's cached panels.
- Since fresh membership sweeps shipped (Trakt Improved 1.29), every membership sweep GET carries a `marker=` nonce (URL-matching probes must expect it), and a foreign `trakt-marker:invalidate:*` bump produces TWO sweeps on a tab actively running scans (the immediate scan-driven one plus the 2s-settled storage-triggered one) but exactly ONE on an idle tab; sweep-counting probes must expect this asymmetry.
- A tab that loses visibility (any tooling call that focuses elsewhere) has its timers clamped, first to roughly one per second and later to one per minute, so an in-page observation log built by a timer under-samples or stops while the feature's own timers still fire, just late. Never infer "the timer never ran" from a gap in such a log; poll the state directly inside each eval call instead.

## Backlogs and indexes

Four repo-local indexes live under `.claude/`. A `SessionStart` hook in `.claude/settings.json` injects a directive so Claude reads them on the first turn of every session; any task the user raises may already be queued, designed, diagnosed, or covered by an existing pattern:

- `.claude/QUICK_WINS.md`: refactors ready to land when time allows. Shipped entries are appended to `.claude/QUICK_WINS_HISTORY.md` (described below).
- `.claude/FEATURES.md`: product-level feature ideas, with one file per feature under `.claude/features/`. Shipped entries are appended to `.claude/FEATURES_HISTORY.md` (described below). When sibling feature files start duplicating shared concerns (machinery, patterns, conventions), promote an umbrella file that hosts the shared content and trim the siblings to deltas; cross-references through an umbrella scale better than pairwise cross-references.
- `.claude/BUGS.md`: known bugs awaiting fix, with one file per bug under `.claude/bugs/` when more than a few lines of description is needed. Fixed entries are appended to `.claude/BUGS_HISTORY.md` (described below).
- `.claude/PATTERNS.md`: cross-cutting design patterns that span multiple features, with one file per pattern under `.claude/patterns/`. Complementary to the umbrella-promotion heuristic above: umbrellas cluster children of one family; patterns cluster concerns that span families. A pattern graduates here when the same structure would otherwise be re-described in two or more feature files.

Four locations sit alongside the indexes that are not read at session start; consult them when relevant work is in flight:

- `.claude/plans/<date>-<slug>.md`: implementation plans produced by the writing-plans workflow. **Ephemeral**: a plan exists while the implementation is in flight and is deleted once the work lands. The code, tests, and commits are the durable record. Plans are purely mechanical step-by-step instructions for the agent doing the work. There is no "implemented plans" archive.
- `.claude/QUICK_WINS_HISTORY.md`: archive of shipped quick wins, split out from `QUICK_WINS.md` so the active backlog stays scannable on session start. Append entries here as soon as the quick win lands; the file itself is consulted only when something pulls it in (a pattern-doc cross-reference, an archaeological lookup, a negative-knowledge sweep). Negative-knowledge entries (approaches attempted and reverted) are first-class promotion candidates into the relevant `.claude/patterns/<slug>.md` Cautionary tales sections.
- `.claude/FEATURES_HISTORY.md`: archive of shipped features and shipped slices, split out from `FEATURES.md` so the active backlog stays scannable on session start. Append entries here as soon as a feature or slice lands.
- `.claude/BUGS_HISTORY.md`: archive of fixed bugs, split out from `BUGS.md`. Append entries here as soon as a bug is fixed.

**Walk-and-remove convention.** When a feature, slice, quick win, or bug-fix ships, the same change set that appends its entry to the relevant history archive ALSO walks every other `**Requires:**` line in `FEATURES.md` / `BUGS.md` and drops references to the just-shipped item; if the dropped reference was the only one on the line, the line becomes `Requires: none.`. Active `Requires:` lines therefore describe what is *currently* blocking, and `/nightshift:ready` never has to consult the history archives to resolve dependencies — the dependency graph settles as work ships.

Brainstorming output lives in feature files (or in patterns when cross-cutting / in bugs when diagnostic) rather than as separate dated specs. Pre-feature exploratory brainstorms land as draft features with `status: exploring` frontmatter and an entry in `FEATURES.md`'s `## Exploring` section; `/nightshift:ready` skips them. They graduate to a themed `##` section with a `**Requires:**` line once the design firms up.

The `/nightshift:ready` command parses each entry's `**Requires:**` line in `FEATURES.md` and `BUGS.md` and reports the unblocked work set. Run it when picking what to work on next.