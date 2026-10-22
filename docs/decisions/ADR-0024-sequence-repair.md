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
more than 2 pre-actions, the attempt ends `REPAIR_EXHAUSTED` with that reason.

A repair that reports an **empty** list clears the row's pre-actions. That is how a later version
that drops the modal is healed. A report without the field (any caller that predates this ADR)
leaves them as they are.

### 3. How §9 counts it

A sequence is **one repair** (one proposal, one attempt, one `repair_count`) and the step is **one
step**. That decision moves the gate number, so it is made visible instead of silent:

- Step metric rows gain `pre_action_count` (1–2, absent when none ran). It is set on a first pass
  that ran recorded pre-actions, and on a `REPAIRED_PASS` that ran the repair's own.
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

- The 10.0.13 → 12.2.1 modal case is expressible in **one** attempt. The modal's controls are in the
  repair context first (ADR-0023), and "Change Visualization" is behind them in the same capture.
- Steps repaired this way replay **first-pass valid** with no model call, as the persistence half of
  the issue asks. `pre_action_count` stays on those rows, so the report can still separate them.
- The gate number is not re-measured by this ADR. The next matrix run is.

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
- **Whether models use `pre_actions` when they should.** Not measured until the next live run.
