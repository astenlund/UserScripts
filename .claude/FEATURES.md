# Features

Product-level feature ideas captured during brainstorming. Each entry
points at a standalone file under `.claude/features/<slug>.md` with the
full design sketch. Check this index before proposing new feature
directions in the same territory.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `QUICK_WINS.md`, `BUGS.md`, `PATTERNS.md`). Each
entry here is a short paragraph summary plus a `**Requires:**` line, and
optionally a `**Slices:**` block (formal MVP plus continuations; see
`## Slicing` below). For features that are partially done without a
formal slice breakdown, describe the partial progress in the entry's
own prose — there is no separate marker convention for "partially
shipped". The detailed design lives in the linked file. When a feature
(or a slice of a sliced feature) ships, append its entry to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); do not keep an
`## Implemented` section inline.

## Requires lines

**Every feature index entry carries a `**Requires:**` line** declaring
the upstream gates that block the feature. The line is comma-separated;
long lines may wrap across multiple physical lines and `/nightshift:ready` joins
them before parsing. Each item is one of three forms:

- A markdown link to a feature, quick win, or bug entry tracked in one
  of the four indexes. The reference is a current blocker; under the
  walk-and-remove convention below, a satisfied dependency is edited
  out of the line at the moment it ships, so `/nightshift:ready` treats every
  in-backlog reference as actively blocking.
- Bare text. Names an external primitive (SDK feature, infrastructure
  capability, project-level invariant, library, hardware) that the user
  confirms case by case. `/nightshift:ready` flags these as `external`.
- The literal word `none.` if there are no upstream gates.

A missing `Requires:` line is a structural error: every entry must say
something. Silence is not the same as `none.`; it indicates the
dependency review hasn't been done. The `/nightshift:ready` command parses these
lines to compute the unblocked work set.

Downstream relationships (this feature **enables** what) are not
encoded structurally. They can be derived by walking the upstream graph
in reverse, and over-codifying them creates a second source of truth
that drifts. Mention downstream relationships in design prose where
they aid understanding.

**Carve-outs:** sections like `## Working hypotheses`, `## Staging`,
`## Future directions (not yet designed)`, `## Author tooling`, and
`## Exploring` describe pre-feature material (orienting prose,
shipping order, shallow placeholders, workflow notes, exploratory
brainstorms) rather than ready-to-implement entries. Items in those
sections do not carry `Requires:` lines (or, in `## Exploring`'s
case, may carry them as historical artifacts only) and `/nightshift:ready`
ignores them. Working hypotheses / Staging / Future directions
(not yet designed) / Author tooling are bulleted rather than `###`
headings, so the `###`-only candidate filter handles them naturally;
`## Exploring` holds `###` entries but is excluded by name in the
`/nightshift:ready` filter.

Concrete entry shape inside the index. The example mixes a feature
link, a quick-win link, and a bare external primitive to show all
three forms; a real entry only includes whatever it actually depends
on:

```markdown
### [<Feature name>](features/slug.md)

<Short paragraph summary.>

**Requires:** [other-feature](features/other-feature.md), [shared
helper extraction](../QUICK_WINS.md#shared-helper-extraction), some
external primitive.
```

**When a feature is implemented**, move its index entry to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); drop its `Requires:` line
in the move (history entries don't need them). The feature file stays
in place as a historical design record.

**Then walk every other `**Requires:**` line in `FEATURES.md` and
`BUGS.md`** and remove references to the just-shipped feature: if it
was the only item on the line, set the line to `Requires: none.`. This
keeps `Requires:` lines as a literal record of what is *currently*
blocking and means `/nightshift:ready` never needs to consult the history file.

**Partially-implemented features** have two routes. If the shipped
and remaining work is scoped clearly enough to name a named MVP plus
named continuations, use the formal `**Slices:**` block described in
`## Slicing` below — `/nightshift:ready` then expands per-slice work units and
downstream features can reference specific slices via the
`[Feature: slice-name]` link suffix. If the shipped work is real but
not yet sliceable (e.g., one layer landed, remaining layers are a
wishlist not a planned breakdown), describe the partial progress in
the entry's own prose without any special markers. `/nightshift:ready` treats
such entries as the `**Requires:**` line dictates; partial progress
is editorial context for the reader, not a machine-readable signal.

## Slicing

Features that bundle multiple shippable layers under one design split
into a named **MVP** plus one or more **continuations**. The MVP is
the smallest surface that unblocks downstream features whose
`Requires:` line points at this feature; continuations layer
extensions on top.

A sliced feature entry carries a `**Slices:**` block listing each
slice (MVP first, then continuations) with one or two sentences on
what each delivers. The entry's `**Requires:**` line reflects the
*next-to-ship* slice (initially MVP).

After MVP ships, the MVP entry moves to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); the MVP bullet in the
parent's `**Slices:**` block is struck through with a pointer to the
history file; the parent entry stays in its themed section; the
top-level `**Requires:**` line advances to the next-to-ship slice's
gates; and every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`
that referenced the just-shipped slice (bare-link defaults to MVP) is
edited to drop the now-satisfied reference. When later continuations
have independent gates (they can ship in any order rather than
sequentially), each slice bullet may carry an inline `**Requires:**`
annotation for documentation. Example shape post-MVP:

````
**Slices:**

- ~~MVP — floating-reference core.~~ (Shipped — see FEATURES_HISTORY.md.)
- **Re-anchor events.** Manual UI re-anchor + `AnchorEvent` plumbing.
- **Late-join replay.** `GetSessionHistory` pull endpoint.
- **`RepertoireChordSource`.** Drop-in replacement consuming chart repertoire.
  **Requires:** [chart-repertoire](features/chart-repertoire.md).

**Requires:** none.
````

Downstream features that need a specific continuation (not just the
MVP) encode the slice name in the link's display text:

```
[feature-title: continuation name](features/slug.md)
```

A link without a `: slice-name` suffix resolves to the MVP — the
default unblock point.

As each slice ships, append a line to `FEATURES_HISTORY.md`:

```
- [Feature title: slice name](features/slug.md): brief note.
```

The parent entry stays in its themed section until the **last** slice
ships, at which point it graduates with the final history line.

`/nightshift:ready` reads the top-level `**Requires:**` line and any inline
`**Requires:**` annotations on slice bullets, then reports each
unshipped slice as a separate work unit (`[Feature title: slice
name]`). A slice is "unshipped" when its bullet in the `**Slices:**`
block is *not* struck through — the strikethrough is the live
slice-status indicator that `/nightshift:ready` reads. The **first unshipped
slice** (top-most non-struck bullet) uses the top-level line as its
gates; other unshipped slices use their inline annotation if present,
or have no extra gates if no annotation. All non-MVP slices
**implicitly depend on MVP being struck through**, regardless of
top-level or inline gates — a continuation is never reported as Ready
while MVP is unshipped. A slice may declare an inline `**Requires:**`
pointing at another slice of the same feature via the suffixed-link
form, useful when one continuation builds directly on another;
resolve the reference by checking whether the target slice's bullet
is struck through. As each slice ships, append its entry to
`FEATURES_HISTORY.md`, strike through its bullet in the parent's
`**Slices:**` block, advance the top-level `**Requires:**` to the
new next-to-ship slice's gates, and walk every other `**Requires:**`
line in `FEATURES.md` / `BUGS.md` to drop now-satisfied references.

## External links

### [RT page bridge](features/rt-page-bridge.md)

Fetch the resolved Rotten Tomatoes page (GM_xmlhttpRequest, new
`@connect www.rottentomatoes.com`) and use it two ways: verify at
resolution time that the Wikidata-bridged RT path actually matches
the title (two-signal verdict: year gate with +-1 tolerance and a
normalized-title gate; demotion to title search only when both
signals disagree or RT reports the path dead, single-signal
disagreement records `uncertain` for a click-time
confirm), and hydrate the "-" values on taken-over dead RT tiles
with real critic/audience scores. Probed 2026-08-04: RT movie pages
serve JSON-LD (name, dateCreated) plus a scorecard JSON
(criticsScore/audienceScore) to a plain fetch. Cache entry widens
(CACHE_VERSION bump); full consumer walk in the feature file.

**Slices:**

- **MVP -- link verification.** Verify rtPath in `resolveIds` under
  the two-signal match rule (demote only when year and title both
  disagree, or on an RT-reported dead path), cache the verdict enum
  plus, on auto-match only, `rtScores` from the same fetch (and RT
  title/year on uncertain, feeding the confirm slice); intermediate
  outcomes stay direct and logged. No rendering changes.
- **Click-time confirm.** One-time popup on plain left-click of an
  uncertain RT anchor: open (user-verified) or not-it (demote to
  search); user rulings carry forward across TTL refetches of the
  same path.
- **Score hydration.** Render tracked taken-over tiles' scores via a
  closure-state tile tracker (identity-deduped, isConnected-filtered,
  cleared on page-key change), 24h staleness refetch with in-flight
  dedup and a fetchedAt stamp written even on failure, idempotent
  text writes.

**Requires:** none.

## Quick lists

### [Manage-lists row takeover](features/manage-lists-row-takeover.md)

Script-owned truth for the Anticipated/Uninterested rows inside the
app's Manage lists drawer, which misreports quick-list membership
after script writes until the user's next native action or a reload.
Live-probed 2026-08-05: the drawer is a body-level singleton whose
rows Svelte patches in place (foreign attributes survive toggles,
refetches, and close/reopen), membership display is exactly two
attributes (label verb, bookmark fill), and a capture-phase listener
fully suppresses the app's row handler. Design: attribute-only
corrections from the membership engine plus click interception into
`performToggle`, gated by a fail-closed title cross-check; removes
are one-click; all other rows stay native. Full design and
verification plan in the feature file.

**Requires:** none.

## Exploring

Pre-dependency-analysis brainstorms live here. An entry is a draft
feature whose breakout file carries `status: exploring` in its
frontmatter; the design is being firmed up and a `**Requires:**` line
isn't expected yet. `/nightshift:ready` excludes this section from the readiness
set on purpose. When a draft firms up enough to declare its upstream
gates, move it out of `## Exploring` into the appropriate themed `##`
section, add the `**Requires:**` line, and drop the `status: exploring`
frontmatter on the breakout file.

No entries at the moment.

## History

Implemented features are archived in
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md), loaded on demand only
(not at session start) so the active backlog above stays scannable.
When a feature (or slice) ships, append its entry there rather than
to this file, AND walk every other `**Requires:**` line in
`FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it
was the only one, set the line to `Requires: none.`). The active
`Requires:` lines describe what is *currently* blocking, so `/nightshift:ready`
never has to consult the history file — the dependency graph settles
as features ship.
