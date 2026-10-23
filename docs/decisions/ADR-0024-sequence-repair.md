---
title: "ADR-0024: a repair may insert up to two actions before a step's own"
doc_type: adr
status: review
owner: B3
created: 2026-10-22
updated: 2026-10-22
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0024 — Sequence repair

**Status:** review · **Trigger:** [#213](https://github.com/myselfsiddharth/Paragent/issues/213), from the
re-run after [ADR-0022](ADR-0022-postcondition-anchoring.md) ([gate-result-2026-10-17](../gate/gate-result-2026-10-17.md),
re-run section). Option chosen by the founder on 2026-10-22: an atomic sequence, rather than inserted
steps or staying single-action. Builds on [ADR-0023](ADR-0023-dialog-first-context.md). Affects
[ADR-0013](ADR-0013-cache-program-entity.md) (`steps_total`) and [ADR-0021](ADR-0021-first-live-replay-corrections.md) (repair).

## Context

After ADR-0022, every remaining failure on 7 of 8 pins is churn that **adds** an action:

- **10.0.13 → 12.2.1, step 2.** A new "Select data source" modal must be answered before "Change
  Visualization".
- **13.0.3, step 1.** "Add new panel" became an "Add" menu, then a "Visualization" item.

Repair found the right control in both cases. It could return only one action
(`RepairProposal.corrected_action`), and write-back stored one action per step. Two attempts that
happened to perform both actions kept only the last, so the next replay met the modal again. Task
success stayed at 6/48.

The issue's requirement: the gate number must not silently depend on how this is decided.

## Decision

### 1. A step is pre-actions, then its own action, then one check

`CompiledStep` and `CacheRow` gain `pre_actions?: CompiledAction[]`, at most **2**
(`MAX_PRE_ACTIONS`). Replay runs them in order, then `compiled_action`. The step's frozen assertion is
checked **once, after `compiled_action`**, and `locator_ref: action_target` (ADR-0022) means that
action's target.

- **No post-condition is invented.** An inserted action has none of its own. Synthesizing one
  without a recording was the open question that made the "inserted steps" option expensive.
- **`steps_total` is unchanged** (ADR-0013). A program is still the steps that were recorded.
- **The step's own action stays last.** This is in the prompt, and it is the only shape under which
  the recorded post-condition still describes the step.

### 2. A repair proposes the remainder of the step

`RepairProposal` gains `pre_actions`. The model's structured output gains an optional
`pre_actions` (an array of the same action schema, or null), and the system prompt explains it.
`sanitizeProposal()` is shared by the Anthropic, Voyager and delegated clients. It drops the
**whole proposal** when the list is malformed, contains an action that touches an assertion, or is
longer than 2. This is the posture `sanitizeProposedAction` already takes.

When a step fails, its recorded pre-actions that ran before the failure stay, because they already
acted on the page. The retry runs only the proposal's actions. A passing repair is persisted as the
kept pre-actions, then the proposal's pre-actions, then its corrected action. If that adds up to
more than 2 pre-actions, that attempt is spent with that reason, and the next attempt (if any)
proceeds. The model is not told how many recorded pre-actions are kept.

A repair that reports an **empty** list clears the row's pre-actions. That is how a later version
that drops the modal is healed. A report without the field (any caller that predates this ADR)
leaves them as they are.

### 3. How §9 counts it

A sequence is **one repair** (one proposal, one attempt, one `repair_count`) and the step is **one
step**. That decision moves the gate number, so it is made visible instead of silent:

- Step metric rows gain `pre_action_count` (1–2, absent when none ran). It is set on a first pass
  that ran recorded pre-actions, and on a `REPAIRED_PASS` to the kept recorded ones plus the
  repair's own, the same count the rewritten row records.
- The §9 report gains `repair_shape`, beside `truncation` and `cost_provenance`: how many repaired
  steps inserted an action, and how many first-pass-valid steps ran inserted actions.

### 4. Privacy boundary

Each pre-action's locators are classified for the pool exactly like `compiled_action`'s. Unsafe
locators are stripped, and the tenant row keeps them marked. A pre-action that had locators and
keeps none makes the row **pool-ineligible**, because a sequence missing an action replays a
different task. There is no topology fallback for a pre-action: a step's `flow_topology` describes
its own action. The fail-closed pool checks in `finalize()` and `writeCacheRow()` now walk every
locator on the row. Canaries: `tests/canary/repair-rewrite.test.ts`. The egress payload is
**unchanged**.

## Contract changes

- `contracts/cache-row.schema.json`: `pre_actions` (max 2, items as `compiled_action`), and
  `repair_provenance.pre_action_count`.
- `contracts/metrics.schema.json`: step `pre_action_count`.

All of these are additive and optional. Rows and bundles written before this ADR replay exactly as
before.

## Alternatives rejected

- **Inserted steps, each with its own post-condition.** It has to synthesize a post-condition with
  no recording behind it, changes `steps_total`, and turns "how many steps did the task have" into a
  number that churn edits.
- **Stay single-action.** Defensible, but it puts 7 of 8 pins out of scope for a reason that is the
  shape of a repair, not the thesis under test.
- **Unbounded sequences.** At that point a "repair" is a re-recording under a step's name, and §9
  would be counting re-recordings as repairs.

## Consequences

- Steps repaired this way replay **first-pass valid** with no model call, as the persistence half of
  the issue asks. `pre_action_count` stays on those rows, so the report can still separate them.
- The gate number is not re-measured by this ADR. The next matrix run is.

### Measured live on Grafana 10.0.13, step 2 (2026-10-22)

- **The mechanism works.** A sequence repair ("Paragent TestData Tags TestData", then "Change
  Visualization") executed both actions, and the picker opened (the Stat card was visible).
- **Step 2 still fails, on its post-condition.** The check compiled from 9.5.21 is "the clicked
  control is still visible". On 10.0.13 the toggle **disappears** when the picker opens, so the check
  is false while the step did exactly the right thing. Assertions are frozen under repair, so no
  repair can pass this step. This is ADR-0022's open question ("a `locator_ref` check is exactly as
  strong as the copied-locator check it replaces") showing up live. It needs a post-condition that
  proves the step's outcome (the #210 family), not a repair change.
- **Qwen (Voyager) uses `pre_actions` but picks the wrong option.** With the original prompt it
  ignored the field. With the explicit dialog rule now in the prompt it uses the field every time
  (2/2), but it closes the dialog instead of choosing a data source. Closing leaves the editor on
  10.0.13. The payload gives the model no task intent, and the card's "default" tag is not part of
  its accessible name (ADR-0023). Telling it what the task is for would mean adding something such
  as `task_key` to the egress payload. That is a boundary change, and it is left for a decision.
- **Two attempts can collide.** Attempt 1's pre-action closed the modal and its corrected action
  then failed the check, so attempt 2's identical pre-action had nothing to click. This is the
  failed-attempt rule below, observed.
- **Found and fixed on the way:** captured names were raw `textContent`, so the model was shown
  names no locator could match (fixed in ADR-0023's capture).

## Open questions / what I could not verify

- **The 13.0.3 menu case is probably not fixed by this.** "Visualization" exists only after "Add" is
  clicked, so a one-shot proposal would have to name an element it was never shown, which the
  prompt forbids. Fixing it needs repair to **accumulate across attempts**: attempt 1 clicks "Add",
  attempt 2 sees the menu and clicks "Visualization", and both are persisted. That is a different
  rule about what a failed attempt leaves behind, and it is left for a decision rather than folded
  in here.
- **Actions from failed attempts are not persisted.** If attempt 2 passes only because attempt 1's
  action changed the page, the stored sequence lacks it, and the next replay repairs again. This is
  measured, not hidden: it shows up as another repair.
- **A stored pre-action that fails.** The egress still reports the step's own action as the one
  that failed, and a dialog that appears only on some runs makes the row gain and lose its
  pre-action on alternate runs. The fix is skippable pre-actions plus a `failed_action` field in
  the egress: [#228](https://github.com/myselfsiddharth/Paragent/issues/228).
- **Task intent in the egress.** It is needed for any repair that has to *choose* (a data source,
  an audience) rather than find. It is not decided here.
