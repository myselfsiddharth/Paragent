---
title: "ADR-0023: the repair context captures an open dialog first"
doc_type: adr
status: review
owner: B3
created: 2026-10-22
updated: 2026-10-22
confidence: HIGH
supersedes: null
sources_verified: true
---

# ADR-0023 — Dialog-first page context

**Status:** review · **Trigger:** [#212](https://github.com/myselfsiddharth/Paragent/issues/212), from the
first live gate matrix ([gate-result-2026-10-17](../gate/gate-result-2026-10-17.md)).
Amends the `interactive` and `tree` levels of [ADR-0012](ADR-0012-repair-context-budget.md), as
[ADR-0021](ADR-0021-first-live-replay-corrections.md) §1 did before it.

## Context

On Grafana 10.0.13 a **"Select data source" modal** opens with the panel editor. It intercepts
clicks, so a correct repair of step 2 still timed out.

The repair model never saw the modal. `contextExpression()` (`src/shared/page-context.ts`)
collects elements in document order and stops at 120. The editor's option panes filled the cap,
and the modal is rendered at the end of the DOM. Measured live on 10.0.13 at step 2, with the
old capture: 120 elements, **none of them a data-source choice**.

## Decision

When a dialog is open (`[role=dialog]`, `[role=alertdialog]`, `[aria-modal=true]`, or
`dialog[open]`), the frontmost one is captured **first**.

- **Open** means rendered and exposed. It must pass the visibility predicate, have non-zero opacity,
  and not sit under `aria-hidden="true"`. A closed modal kept in the DOM would otherwise be taken as
  open and, if modal, drop the whole real page.
- **Frontmost:** a declared modal outranks any non-modal dialog, so a popover or banner rendered
  after a modal does not displace it. Within a kind, the last in document order wins.

- Each of its elements carries `in_dialog: true`. Absent means "not in a dialog", so the shape of a
  capture with no dialog open is unchanged.
- **Declared modal** (`aria-modal="true"`, or a `<dialog>` matching `:modal`): the elements before
  it in document order are inert and are **dropped**. Elements *after* it and outside it are kept,
  because that is where a menu or listbox the dialog opened is portaled, on top of it.
- **Not declared modal:** they are listed after the dialog's, still under the same cap. Grafana
  10.0.13's modal is in this case. It does not set `aria-modal`, so demoting rather than dropping
  is what makes the fix work there.
- The repair and fresh-baseline system prompts each gain one sentence that explains the flag.

Same allowlist and the same no-values rule apply. The attributes newly read are `aria-modal` and
`aria-hidden` (below). Both are structural ARIA and are added to `CONTEXT_ATTRIBUTE_ALLOWLIST`.
That list was documentation only; a unit test now asserts that every attribute the capture reads
is on it.

Measured live on 10.0.13 at step 2, with the new capture: 120 elements, the first 8 flagged
`in_dialog`, including the TestData source and "-- Mixed --".

### Content-derived names follow the accessible-name rules

Found by the first live probe of sequence repair on 10.0.13 (#213). The data-source card was
captured as `"Paragent TestData defaultTestData"` (raw `textContent`). Its accessible name is
`"Paragent TestData Tags TestData"`: the tag list's `aria-label` stands in for its content, and
block-level children are space-separated. The model proposed the name it was shown, and no locator
matched it.

A name read from content now follows the rules Playwright's role engine applies:

- A labelled child contributes its `aria-label`.
- An `aria-hidden` or undisplayed child contributes nothing.
- A child that is not `display: inline` is space-separated.

The same rule applies to `aria-labelledby` and `<label>` text. No new source of text is read. It is
the same text nodes and `aria-label`, assembled correctly. `aria-hidden` joins the allowlist. A test
asserts that every captured name in the fixture resolves back to exactly its element.

The cost is that content an `aria-label` replaces is no longer shown. The card's "default" tag is
gone, because the accessible name says "Tags". The model can only target what a locator can match,
so it is shown only that.

## Alternatives rejected

- **Raise the cap.** It moves the cliff without removing it. The next page with more option panes
  hides the dialog again, and the payload grows on every page.
- **Drop the background whenever any dialog is open.** This is wrong for a non-modal dialog such as a
  popover, whose background stays actionable. It is also the case Grafana is in.

## Consequences

- `repair_context_level: interactive` rows from before and after this ADR are **not comparable**
  on pages with an open dialog. On other pages the order and flags are unchanged, but
  **content-derived names are not**: `<div>A</div><div>B</div>` inside a button was `"AB"` and is
  now `"A B"`, and every name is trimmed. Rows from before and after this ADR are not comparable on
  any page where such a name was captured.
- It does not fix step 2 on its own. Choosing the data source is an *inserted* action, which a
  single-action repair cannot supply ([#213](https://github.com/myselfsiddharth/Paragent/issues/213)).
  This ADR makes that repair possible to ground. #213 makes it possible to express.

## Open questions / what I could not verify

- **Several dialogs open at once.** Only the frontmost is promoted; one behind it is listed as
  background. Nothing in the gate matrix opens two.
- **The name rules are a hand port** of the accessible-name algorithm. Known gaps: `::before` and
  `::after` content, a `visibility: visible` descendant inside a hidden subtree, shadow DOM, and
  embedded controls. Each one is a name the model can be shown and no locator can match. Taking
  names from the browser's accessibility engine would close this whole class:
  [#227](https://github.com/myselfsiddharth/Paragent/issues/227).
- **An off-canvas drawer** moved off screen with a transform still counts as open.
- **A dialog that is not marked as one** (no role, no `aria-modal`, no `<dialog>`) is invisible to
  this rule. Grafana 10.0.13's data-source modal is marked. The other pins' dialogs were not
  checked.
