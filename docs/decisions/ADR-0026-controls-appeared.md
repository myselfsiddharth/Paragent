---
title: "ADR-0026: a step that reveals something is checked by what appeared, not by whether its control stayed visible"
doc_type: adr
status: review
owner: B3
created: 2026-10-22
updated: 2026-10-22
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0026 — `controls-appeared`

**Status:** review · **Trigger:** [#224](https://github.com/myselfsiddharth/Paragent/issues/224), from the live
10.0.13 probe in [ADR-0024](ADR-0024-sequence-repair.md). Option chosen by the founder on
2026-10-22: "new controls appear". Answers [ADR-0022](ADR-0022-postcondition-anchoring.md)'s
open question for click steps. Gate task re-recorded as **r3**.

## Context

Step 2 of the gate task ("Open the visualization picker") compiled to "the clicked control is
still visible": `element-visible`, `locator_ref: action_target`, `visible: true`. That is true on
9.5.21, where the toggle stays on screen. On 10.0.13 the toggle **disappears** when the picker
opens. Verified live: after choosing TestData and clicking "Change Visualization", the Stat card
is visible and the button is gone. So the check was false while the step did its job. Because
assertions are frozen under repair, no repair could pass it.

The check described a side effect of one version's layout, not the step's purpose.

## Decision

### Recorder: count what appeared

Each step records **`controls_appeared`**: how many controls (role + accessible name) were visible
after the action that were not visible before it.

- Both sets come from `contextExpression("interactive")`, the capture the privacy boundary already
  reviews, through `visibleControlKeys()` (`src/shared/controls.ts`). No new attribute is read and
  no value is read.
- Two settings differ from the repair context:
  - **The dialog-first filtering is off.** It drops what sits behind a modal, so closing a modal
    would otherwise count as the whole page appearing.
  - **The cap is 10,000,** because a count is about the page, not the repair payload's 120-element
    budget.
- The "before" set waits for the page to **hold still**: two reads 300 ms apart that agree, within
  2 s. Otherwise controls still rendering from the previous step would be credited to this one.
- **Only the count is persisted,** and only for click-like steps, the only ones the compiler reads.
  The keys stay in memory, so no name enters the trajectory.
- A failed capture records nothing. "Could not tell" is never 0.

### Compiler: assert the step revealed something

For a click-like step that did not change the URL, whose control **stayed visible** when recorded
and that **revealed at least one control**, the compiler emits:

```json
{ "type": "controls-appeared", "strength": "weak", "expected": { "count": 1 } }
```

This replaces "the control is still visible". There is no target and no page text, so pool
eligibility is unchanged (7/12).

- **Rename-proof.** It is a count, so a renamed or restyled control cannot break it, and it does
  not tie a step's check to the next step's names. The rejected "next step's target appears" did
  both.
- **Weak, honestly.** A wrong menu opening also passes. What it rules out is a click that did
  nothing, which "the control stayed visible" never could.
- Steps whose recording saw nothing appear keep their previous check, and so do fills (#210 is
  their path) and the ADR-0007 "control disappeared" case.

### Runner

`attemptStep` snapshots the visible controls **after the pre-actions and right before the step's
own action** (ADR-0024), using the same "hold still" settling as the recorder. The count is
therefore of what *the step's own action* revealed.

Snapshotting before the pre-actions, as the first version of this PR did, was wrong. A pre-action
that closed a modal made the whole editor "appear", and a no-op own action passed (caught in
review, with a test).

`evaluateAssertion` polls until `expected.count` new controls are visible or `timeout_ms` passes. A
read that fails mid-transition (a frame reload) is retried rather than reported. A missing snapshot
fails the check and says so; it never passes blind.

### Found on the way: a URL recorded mid-redirect

The first r3 recording caught Save's URL mid-redirect. Grafana routes to `/d/{uid}/{slug}`, then
rewrites it to add `?orgId=1`. Through ADR-0022's state-bearing rule, the compiler then required
`orgId` to be absent there, and step 10 failed every replay on 9.5.21. r2 had recorded the final
URL by luck of timing. Fixed in two places:

- **Compiler, the class fix:** `settleTransientUrls()`. Nothing acts between a step's post_state
  and the next step's pre_state, so when the two share a path and differ, the first was a transient
  and the settled URL replaces it, whatever the recorder's timing. A different path is a real
  navigation and is left alone.
- **Recorder:** `settleUrl` now waits for the URL to stop moving (300 ms quiet) after it first
  changes.

## Contract changes (additive)

- `contracts/trajectory.schema.json`: step `controls_appeared` (integer, ≥ 0, optional).
- `contracts/assertion.schema.json`: type `controls-appeared`.

## Measured (2026-10-22)

- **r3 vs r2:** actions identical in all 12 rows. Assertions differ **only** at steps 2 and 8 (Open
  the save-dashboard drawer), both now `controls-appeared`. The recording saw 27 and 7 controls
  appear, and 0 for every fill. Pool eligibility: 7/12, unchanged.
- **9.5.21, stub repair, 3 runs:** 12/12 every run, 0 repairs. Wall time per run went from about
  1.3 s to 2.3 s: the settling before the two snapshots.
- **10.0.13, scripted step-2 repairs, with the snapshot after the pre-action:**

  | Proposal | Step 2 |
  | --- | --- |
  | TestData, then **Change Visualization** (the right control) | `REPAIRED_PASS`, 2/2. Steps 3–5 PASS; the run then stops at step 6, a renamed field the scripted client does not answer |
  | TestData, then an **inert** control (the panel-title text field) | **fails**: "expected at least 1 new control(s) after the action, saw 0" |
  | TestData, then **"Search or jump to..."** (a wrong control that opens a different surface) | passes: the known weakness, see below |

  With r2, no repair could pass step 2.

## Alternatives rejected

- **"The next step's target appears."** Strongest, but it makes step N fail a frozen check whenever
  churn renames step N+1's control. That turns a repairable failure into one no repair can fix.
- **Downgrade the old check** so its failure doesn't count against replay validity. That needs no
  re-record, but it is weaker than either and arguably games §9.

## Consequences

- The gate program is **r3** (`artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r3.bundle.json`).
  r1 and r2 and their bundles are left untouched, because earlier ADRs cite measurements on them.
  Gate numbers from r2 and r3 are not comparable at steps 2 and 8.
- Step 2 on 10.0.13 → 12.2.1 is now passable, given a repair model that composes the sequence.
  ADR-0025 measured which ones do.

## Open questions / what I could not verify

- **A click that only changes state in place** (a toggle, a checkbox) reveals no controls and keeps
  the old check. If such a control disappears on a later version, the same problem returns for that
  step. None in the gate task.
- **A wrong control that opens some other surface passes.** Measured above: "Search or jump to..."
  opens Grafana's search overlay. That is what "weak" means here, and why the step is labelled weak
  rather than strong. The check rules out a click that did nothing, not a click that did the wrong
  thing.
- **Count threshold 1** is chosen, not measured. A page that adds an unrelated control (a toast
  with a button) at the same moment would pass a no-op. Not observed on the gate task.
- **Cost.** Each snapshot is a full capture, and the poll repeats it every 250 ms until it passes or
  times out. That is acceptable for the two steps that use it. A count-only in-page observer would
  be cheaper if more steps adopt the check.
- 10.4.19 → 12.2.1 are not probed with r3, and 13.0.3's step 1 is #226.
