---
status: exploring
---

# Live markup contract check

Captured 2026-10-17 while fixing the checkbox redesign of the Manage
lists drawer (Trakt Improved 1.51), from the user's question: when
Trakt changes its markup again, a single "run the contract check"
request should report which of the script's markup assumptions broke,
instead of each breakage surfacing as a user report. The user wants
live checks against the real app, not unit tests on fixture snapshots:
the jsdom fixtures pin the script's logic to markup observed on one
date and keep passing after the app changes.

## Raw sketch

An inventory of every markup contract the script relies on, one entry
per surface: the page to visit, the state the surface needs (popup
menu open, summary actions menu open, Manage lists drawer open, filter
pane open), and the expected shape (selectors, required child nodes,
attribute carriers). An agent walks the inventory in the user's
signed-in Chrome, reaching each state with trusted clicks, and reports
pass or fail per contract with the observed shape on failure.

The 2026-10-17 incident broke three script features on two app
surfaces and shows three failure classes to cover:

- A selector that still matches, but a different node. The drawer's
  row icon changed from a bookmark to a checkbox, and on checked rows
  the takeover's generic `path` lookup matched the new checkmark
  instead of the bookmark, so the rows stayed owned and were painted
  inconsistently without any warning. This is the failure the user
  reported: a remove that landed server-side while the row kept
  looking checked.
- A selector that no longer matches, with a warning. Unchecked drawer
  rows have no `path` at all, so they failed the takeover's markup
  check and raised `drawer-markup` once.
- A selector that no longer matches, silently. The summary actions
  menu moved its rows into a `ul` group, and both the summary-menu
  quick-list entries and the scroll shield's summary-menu guard skip
  without a warning when the rows they expect are absent.

Complementary, cheaper canary: a once-per-page warning at every
fail-closed skip site, so the console names the broken surface even
before a contract check runs.

Questions to settle before this firms up:

- Form: an agent runbook (inventory plus probe snippets the agent
  runs through browser tooling) or a probe bundle injected in one
  eval per surface.
- Source of truth: how the inventory stays in sync with the selectors
  in `trakt_improved.user.js` without becoming a second copy that
  drifts.
- Reaching states: menus and the drawer open only on trusted clicks
  (see the AGENTS.md e2e notes), so the check is agent-driven, not a
  command the user runs alone; which fixed test items and pages give
  stable states (an item with known list membership, a list page with
  cards).
- Write safety: the check must never click a row that writes; probing
  owned drawer rows and quick-list entries reads only.
- Installed-copy interference: the installed script mutates the
  surfaces it owns (injected entries, drawer corrections), so probes
  must tell app markup from script additions.
