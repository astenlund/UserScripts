# Trakt Improved: One-click Anticipated / Uninterested list toggles

Design spec for a new feature in `trakt_improved.user.js`.

Status: signed off 2026-07-27 20:05, content: 86ac9e3d

## Problem

Adding an item to the personal lists "Anticipated" or "Uninterested" currently requires opening a card's popup menu, clicking "Manage lists...", waiting for the dialog, ticking a checkbox, and closing. These two lists are used constantly; they deserve one-click entries in the menus themselves.

## What

Two new menu entries, **Anticipated** and **Uninterested** (in that order), injected into both of the app's item menus:

1. **Card popup menu**: the portal component appended to `<body>` as `.trakt-popup-menu-container` when any card's three-dot button (`aria-label="Pop up menu for ..."`) is clicked. Shared by discover grids, swimlanes, search results, and list views. Entries go directly after the native Watchlist entry (above Track/Manage lists). Native menu contents vary contextually (e.g. unreleased shows lack Track); if no Watchlist entry is present, entries go first. Rows are identified by label text, containers by selector, matching the app's structure (a row carries no stable class of its own).
2. **Summary-page actions menu**: the *different*, inline component on movie/show detail pages: a `div.trakt-summary-actions` containing `<li>` items (Manage lists, Share, Set as cover image, History, Drop show, Report), rendered inside the actions slider when the detail page's three-dot button is expanded. Entries go at the top, above Manage lists.

Each entry is a **toggle with visible state**: the icon renders outline when the item is not in the list and filled when it is; clicking adds or removes accordingly. Icon and action can never disagree: the click handler acts on the membership state captured when the entry was rendered, not a live re-read, so a sweep committing while the menu is open cannot flip the click into the opposite operation behind the rendered icon (and the body-judged idempotent writes make acting on a stale snapshot converge on exactly the end state the icon promised). When a sweep commits while entries are injected, the feature's scan callback re-renders their icon and captured state together; this matters mostly for the long-lived summary-menu entries. Re-rendering must be idempotent (skip when the entry already shows the target state): the shared body observer watches childList mutations, so an unguarded per-scan icon swap would requeue the scan it ran in and loop every animation frame.

**Scope: movies and shows only.** Season, episode, and person menus keep the native contents.

## Target lists

Resolved by **display name** ("Anticipated", "Uninterested") against `/users/me/lists`, not by slug: the user's Uninterested list has a UUID-suffixed slug (`uninterested-61febd75-...`), and names are what the user thinks in. The two names live in one module-level constant beside the script's shared helpers, because two features consume it: the fade feature's sweep builds the membership sets from the names, and the toggles feature renders and writes against them. If a name resolves to no list, or to more than one list (Trakt allows duplicate display names), that entry is skipped and a warning logged once; the other entry still works. Fail closed on ambiguity: writing to an arbitrarily-picked list is worse than a missing menu entry.

Reference (current reality, informational only): Anticipated = list id 3511203, Uninterested = list id 32134789.

## Architecture

New feature IIFE (working name: quick list toggles) following the script's established feature-section pattern, plus a small extension to the existing fade-filters feature, which already owns the all-lists sweep.

### Membership data: piggyback on the fade sweep

The fade feature's `refresh()` already fetches every personal list's items via `fetchListedItems()` (which flattens all lists). It is restructured to keep per-list identity and record, in the `listed` cache category (cache key `trakt-fade-cache`, `CACHE_VERSION` bumped 2 -> 3 to force a one-time refetch):

- `slugs`: the merged mapped-slug list (existing behavior, unchanged semantics).
- `counts`: map of mapped slug -> number of lists containing at least one item mapping to it (per-list dedup). Drives correct unfade on removal.
- `targets`: for each configured list name: `{ id, slugs }` where `slugs` holds **exact** membership only (items whose own type is show/movie, keyed `show:<slug>` / `movie:<slug>`). A season of a show sitting in a list does not count as the show being a member; the toggle operates on the show/movie itself.

"Mapped slug" means the existing `itemSlug()` mapping: shows/movies contribute their own slug, seasons/episodes map to the parent show, persons ignored.

**Refresh reachability.** Today `refresh()` has a single call site inside the fade feature's scan, which is gated to `/discover` paths (`fadingActive()`); off `/discover` the sweep never runs and a mutation-forced refresh flag sits unconsumed. That gate is correct for fade styling but wrong for membership data, which the toggles feature needs on every page (the summary menu lives on `/movies/<slug>` and `/shows/<slug>` by definition). The restructure therefore exposes the sweep as a shared, pathname-independent entry point (working name `refreshMembership()`); the fade scan keeps calling the underlying refresh under its own gate, and the toggles feature calls the shared entry point (a) whenever a scan finds injected entries present or a menu opening, and the membership data is absent or stale (staleness-gated, non-forced), so cold caches heal without a `/discover` visit (a cold menu-open renders without entries; they appear from the next open) and long-lived summary entries heal from app-driven or cross-tab changes without waiting for a rebuild, and (b) after every write, success or failure, as the authoritative corrector described under Writes.

**refreshMembership() contract.** The corrector is only a corrector if it actually runs and reads post-write state, so the entry point is not a bare alias for `refresh()`:

- **Settle delay**: a write-triggered call waits the script's existing mutation settle window (the same delay `notifyMutation()` applies, and for the same documented reason: give the server time to reflect the write before refetching). An immediate refetch can read pre-write list state and stamp it fresh, which would both undo a correct optimistic update and block the TTL-gated menu-open heal for the full TTL.
- **Queued re-run, never dropped**: `refresh()` is single-flight with a plain early return. A write-triggered call that arrives while a sweep is in flight must not be silently dropped (the in-flight sweep's GETs may predate the write and would clobber the optimistic state when it commits): it sets a pending flag, and when the running sweep settles, a fresh sweep runs.
- **Backoff bypass**: write-triggered calls bypass the failure backoff, like the existing mutation-forced path does for the same reason (user actions are rare and deserve promptness). Menu-open calls respect the backoff.
- **One click, one sweep**: a toggle's step 6 fires both `notifyMutation()` (for other consumers) and the write-triggered refresh, and on `/discover` the notify path independently forces the fade scan's own refresh. These coalesce rather than double-sweep: a sweep counts as covering the write only when it started AFTER the settle window closed (one that started inside the window may still have fetched pre-write state, and queues a re-run instead), and whichever sweep runs consumes the mutation-forced flag, so a second full all-lists walk is not launched for the same click.
- **Full staleness condition**: the menu-open trigger fires not on TTL age alone but on the same condition set the fade scan uses: data absent, TTL-stale, the mutation-forced flag set (an app-driven change such as a native Manage-lists tick, otherwise unconsumed off `/discover`), or the cross-tab invalidation markers changed. Without the last two, a membership change made through the app's own UI (or another tab) leaves toggle icons wrong for the full TTL on exactly the pages this feature targets.
- **Failure re-arm**: the existing sweep consumes its triggers optimistically: it clears the forced flag before fetching and commits the marker snapshot even when every fetch failed. Left as-is, a failed write-triggered sweep would disarm every trigger except raw TTL age, so an unreconciled write after a correlated outage (the POST timeout and the corrector failure sharing one network blip) would sit wrong for the full TTL. The write-triggered flavor therefore re-arms its forced condition when its sweep fails; the retry rides the next trigger (menu open, scan, backoff expiry) once the failure backoff allows. This is also what makes the checklist's "reconciling refresh fires once back online" true.

The fade feature exposes a narrow interface to the new feature (module-level shared object; both features live in the same script IIFE):

- `membershipState()` -> `'absent' | 'stale' | 'fresh'`: whether the listed category has data and whether it is current. `'stale'` covers the full staleness condition above (TTL age, mutation-forced flag, changed cross-tab markers), not TTL alone. Drives the menu-open refresh trigger; `getListTarget` alone cannot, because its null must mean something else (next bullet).
- `getListTarget(name)` -> `{ id, has(slugKey) }` when the name resolved to exactly one list; `null` when data exists but the name resolved to zero or multiple lists (entry skipped + warn once, per Target lists). When `membershipState()` is `'absent'`, targets are not consulted at all; the two no-entry states (no data yet vs unresolvable name) are distinguishable because the spec requires different handling for them.
- `applyListToggle(name, slugKey, add)` -> optimistic update (below).
- `refreshMembership(options)` -> the shared sweep entry point, callable from any page, honoring the contract above (the write-triggered flavor takes the settle delay, queued re-run, and backoff bypass; the menu-open flavor is TTL-gated).

### Menu injection

A MutationObserver on `document.body` watches for either menu appearing (the script's existing body observer infrastructure):

- **Card popup**: the popup is portaled, so item identity is captured beforehand by a document-level capture-phase click listener on the three-dot buttons: from the clicked button, `closest('.trakt-card')`, then the poster link. An eligible link has a bare two-segment `/movies/<slug>` or `/shows/<slug>` pathname AND no `season` or `episode` query parameter: this app encodes card granularity in query params on an otherwise bare pathname (season cards carry `?season=N`, episode cards `?episode=N`, as the fade feature's `cardTarget()` documents), so the query check, not path depth, is what excludes season/episode cards; person cards fail the pathname check. The context (type, slug, title from the button's `aria-label`, timestamp) is held briefly; when the popup container appears, entries are injected only if the context is fresh (a short staleness window guards against orphaned contexts).
- **Summary menu**: identity from `location.pathname`, same bare-path rule (detail URLs keep season selection in the query string, so show pages stay bare; episode pages have deeper paths and are excluded). Title for user-facing text comes from the page's visible title heading, falling back to the slug. Because SPA navigation can move between detail pages without rebuilding the menu DOM, each injected entry records the slug it was built for; whenever the observer sees the menu, entries whose recorded slug differs from the current pathname are torn down and injection re-runs for the current identity.

Entries are clones of a native `<li>` from the same menu (same technique as the fade feature's Fade section, which clones the app's Display section so native styling applies and no Svelte listeners survive the clone). Each clone gets its own inline SVG icon (outline/filled variant per membership state), label text, and click handler.

**Per-open lifecycle, not inject-once.** The SPA can reuse the portaled popup container across opens for different cards (the script's list-truncate feature defends against exactly this), so a permanent injected-once marker would leave stale entries bound to the previous card's identity. Injected entries carry a data attribute that marks them for *teardown*: on every three-dot capture click, previously injected entries are removed and this feature's height override (below) is reverted, and injection runs fresh for the new context. Teardown restores everything the injection changed; a surviving override on a reused container would misbehave on a later menu that receives no injection. The same attribute prevents double-injection within a single open.

**Menu height is this feature's problem.** The list-truncate feature also watches popup-button clicks, but it arms only for list-page kebab menus and never touches item-card popups, so there is no interference in either direction and no existing height override to reuse (its `growMenu` helper is private to that IIFE). The portaled popup container constrains its height, so after injecting, this feature must raise the container's `max-height` by the injected entries' height itself (recording the prior inline value for the teardown restore), or the added rows render clipped. The inline summary actions menu has no such constraint (it grows naturally in the actions slider), so no height work applies there; the no-clipping checklist item exists to verify that assumption.

No token or no membership data yet (first run before the sweep completes): entries are not injected, the toggles feature warns once, and the menu-open triggers `refreshMembership()` as described above. The shared sweep's own no-token warning keeps its existing backoff-gated cadence; the once-only claim applies to the toggles feature's warning, not the sweep's.

### Writes

Click handler, in order:

1. Decide add vs remove from the membership state the entry was rendered with (see What: icon and action always agree). If a write for the same list+item is already in flight, ignore the click (per-key guard, cleared when the write settles): rapid toggle races otherwise let the server end up opposite the last click.
2. Apply the optimistic update (`applyListToggle`): icon flips, fade syncs, cache persists (details below).
3. Close the menu, matching native behavior.
4. `POST /users/me/lists/{id}/items` (add) or `/users/me/lists/{id}/items/remove`, body `{ movies: [{ ids: { slug } }] }` or `{ shows: [...] }`, via the script's existing authed `fetch` pattern (Bearer token + `trakt-api-version` + `trakt-api-key` from the OAuth ride-along). If the token has vanished between render and click (`readAuth()` null at write time), the write is a transport failure: no request is sent, and step 7's revert-and-toast path runs (reconciliation then follows the first successful sweep after login).
5. Judge the result by the response body, not status alone (the truncate feature's remove call sets the precedent): these endpoints return 2xx even when the item was rejected, reporting per-type `added`/`existing`/`deleted` counts and a `not_found` section. **Add** succeeds when the item landed (`added` + `existing` >= 1 for our type); a 2xx whose `not_found` carries our item is a failure. **Remove** succeeds on any 2xx: `deleted` 0 with our item in `not_found` means it was not in the list, and that end state is exactly what the user asked for.
6. When the write settles, on **every** outcome, call `notifyMutation()` (the sandbox fetch bypasses the script's page-fetch hook, and other mutation consumers such as the list-counts feature must hear about the write; on failure the server may have applied it anyway, which is exactly when a stale count hurts most; the truncate feature's precedent notifies on every settled POST) and the write-triggered `refreshMembership()`, which per its contract waits the settle window, queues behind any in-flight sweep, and bypasses the backoff, so authoritative post-write data replaces the optimistic state on any page. Also bump a script-owned key under the app's invalidation-marker prefix: `markersChanged()` prefix-scans all keys under it, so the bump trips other open tabs' full staleness condition, which our sandbox-fetch write (invisible to their page-fetch hooks) otherwise never would. The bump must be invisible to the writing tab itself: record the bumped value into this tab's committed marker snapshot (in-memory and persisted) at bump time, because otherwise the tab's own next scan sees a changed marker and launches an immediate pre-settle sweep, exactly the pre-write read the settle delay exists to prevent. That invisibility must also survive a concurrently committing sweep: the sweep commits the snapshot it captured at its start (deliberately, so an app action landing mid-refresh still triggers a follow-up), which would erase a bump recorded mid-sweep and make it self-visible again. The commit therefore merges the tab's own current bump value into whatever snapshot it commits, but never over a NEWER captured value (values are timestamps; compare numerically): both tabs write the same key, and committing an older own value over a foreign newer one would leave the committed snapshot permanently behind localStorage and loop the sweep. Capture-at-start semantics stay intact for every other marker key.
7. On failure, transport or rejection, additionally: revert the optimistic update and show the toast. A network error or timeout after the POST was sent is indeterminate (the server may have applied it), so step 6's reconciliation against server truth is the correct cleanup; the revert covers the determinate window until that refresh lands.

### Optimistic fade sync (both directions)

`applyListToggle` updates the in-memory and persisted cache immediately, patches the derived membership Sets the fade renderer actually reads (the renderer never consults the cache directly; today those Sets are rebuilt only inside the sweep, so the optimistic path must rebuild or patch them itself), then queues a rescan:

- **Add**: insert slug into the target's exact set, increment `counts[slug]`, ensure slug is in the merged `slugs` -> card fades instantly.
- **Remove**: remove from the exact set, decrement `counts[slug]`; only when the count reaches zero does the slug leave the merged set -> items still on other personal lists stay faded.

The optimistic persist is a patch, not a sweep: it never stamps the record's `fetchedAt`. That choice is what makes interrupted sessions heal: if the browser closes before the corrector lands, the record still ages out on its original timestamp and the next TTL-gated trigger refetches. Stamping it fresh would park an unreconciled write behind the full TTL. For the same reason, a post-write `refreshMembership()` that itself fails needs no handler beyond the contract's failure re-arm: the sweep's existing failure path keeps stale data and records backoff, the optimistic state stays visible, and the re-armed forced condition retries on the next trigger once the backoff allows (without the re-arm, the failed sweep would have consumed every trigger but TTL age).

The instant fade/unfade is feedback only where fading is active: `/discover` pages with the Listed fade toggle on. On swimlanes, search results, and list views the fade feature deliberately does not style cards, so a successful toggle's visible confirmation there is the entry's state on the next menu open (failures always toast). This asymmetry is accepted; extending fade styling beyond `/discover` is a separate feature, not this slice.

The optimistic model is deliberately approximate (e.g. a show and its own season both sitting in the same target list can mis-decrement): the post-write `refreshMembership()` call, riding its settle-delay-and-queue contract, replaces it with authoritative data shortly after every write on whatever page the user is on, so approximations only need to look right, not be right.

### Error surface

A small script-drawn toast (fixed position, auto-dismiss after a few seconds, styled for both themes via the existing `tff-light` root class): "Couldn't add \<title\> to \<list\>" / "Couldn't remove ...". The title comes from the captured menu context (card path: the three-dot button's `aria-label`; summary path: the page title heading, slug fallback); the template degrades to the list name alone if no title was captured. One toast element: a failure arriving while one is showing replaces the message and restarts the dismiss timer (concurrent failures are possible since the in-flight guard is per list+item, but rare enough that stacking is not worth building). Details to the console. Two failure classes, same handling (revert + toast + reconcile refresh, per Writes step 7): transport failures (network error, timeout, non-2xx) and item rejection (2xx with our item in `not_found` on add).

## Not in scope (explicit anti-goals)

- **Season/episode/person toggles**: these lists hold whole shows and movies in practice, and supporting the other card types would triple the identity-capture surface for marginal use.
- **Configurable list names via UI**: the module-level constant serves a single user; a settings surface is unrelated churn. Edited in-source.
- **Membership state fresher than the sweep** (TTL 15 min + mutation-and-write-triggered refreshes); per-menu-open fetches were considered and rejected because the Uninterested list alone exceeds 1000 items, so refetching on every menu open costs visible latency and rate-limit headroom for data the sweep already delivers.
- **Consolidating list identification with the truncate feature**: `initListTruncate` targets the same Uninterested list via a hardcoded slug constant while this feature resolves by display name. The divergence is accepted; reworking the truncate feature is unrelated churn for this slice. Revisit if either mechanism breaks (e.g. the list is recreated under a new slug, which breaks truncate but not name resolution).

## Testing

Manual checklist (no automated tests in this repo):

- Card popup on discover grid: entries appear for movie and show cards, after Watchlist; absent on season cards (`?season=`), episode cards (`?episode=`, e.g. Continue Watching), and person cards.
- Summary page (movie and show): entries appear above Manage lists, fully visible (no clipping); absent on episode pages.
- Cold cache off `/discover` (e.g. fresh cache version, first visit is a detail page): first menu open shows no entries and triggers the sweep; entries appear on a later open without visiting `/discover`.
- Toggle add on `/discover` (Listed fade on): icon fills, card fades immediately, item appears in the list on trakt.tv. On a non-discover surface (swimlane, search, list view): no fade, state confirmed via reopen.
- Toggle remove: icon outlines, card unfades immediately; an item also on another personal list stays faded.
- Reopening the popup on a different card shows that card's entries and state (container-reuse teardown), and native menus opened after an injected one render normally (height override reverted).
- SPA navigation between two detail pages (no reload) rebinds the summary-menu entries to the new page's identity and state.
- Rapid double-click on an entry produces one write (in-flight guard).
- State persists across menu close/reopen and page reload.
- Failure path (devtools offline): toast appears, state reverts, and a reconciling refresh fires once back online or on next trigger.
- Native menu unaffected for logged-out state: no entries, one warning from the toggles feature (the shared sweep's own backoff-gated warning may repeat).
- A sweep committing while a menu is open updates the entries' icons, and clicking still performs what the icon showed.
- Light and dark themes; no double-injection on rapid open/close.
- Version bumped; existing fade behavior unchanged after the cache version bump (one-time refetch).

## Hardening

- revise-spec graduated 2026-07-27 21:52 at c61fbee, scope: whole file, content: dc8a0b49
- handover completed 2026-07-28 02:28 at cc44920, scope: whole file, content: 6630d14c
