---
title: "ADR-0025: the repair model is told the task's goal, the same text the fresh baseline gets"
doc_type: adr
status: review
owner: B3
created: 2026-10-22
updated: 2026-10-22
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0025 — Repair task goal

**Status:** review · **Trigger:** [#225](https://github.com/myselfsiddharth/Paragent/issues/225), from the live
10.0.13 probe in [ADR-0024](ADR-0024-sequence-repair.md). Option chosen by the founder on
2026-10-22: send the fresh baseline's goal. Extends the egress allowlist of
[ADR-0012](ADR-0012-repair-context-budget.md).

## Context

Some repairs have to **choose**, not just find: which data source, which audience, which plan.
On Grafana 10.0.13 a "Select data source" dialog opens in front of the panel editor. The repair
model put the dialog's action first (ADR-0024), but **closed** the dialog instead of choosing
TestData. Closing leaves the editor.

Nothing in the repair payload said what the task was for. The **fresh baseline**, the other side
of the §9 cost ratio, is given the task's goal in prose (`experiments/gate-v1/fresh-baseline.ts`).
So the two sides of the ratio were not equally informed. The comparison was tilted toward fresh
for a reason that is a design parameter, not the thesis.

## Decision

- **`ReplayRunnerOptions.taskGoal`** puts the text on every `RepairContext` as `task_goal`.
  `serializeRepairContext()` carries it **verbatim and only when set**. It is the one free-prose
  field in the payload.
- **The same text as the fresh baseline.** `DEFAULT_TASK_GOAL` moves to
  `experiments/gate-v1/task-goal.ts`, imported by both drivers. `gate:matrix --gate-task-goal`
  uses it, and `--task-goal <text>` overrides it. It is not on by default, because the matrix's
  default program is not the gate task.
- **It must never carry a binding.** `ReplayRunner.run` refuses, before step 0, a goal that
  contains any bound string value of 4+ characters (`TaskGoalCarriesParamError`). The error names
  the param, never the value. Shorter values ("5") occur in ordinary prose.
- **The prompt** says to use the goal to choose between options, never as a source of element
  names.
- **Comparability.** Run rows gain `repair_task_goal: true` when a repair ran with one
  (`metrics.schema.json`). Self-heal rates with and without it are not comparable, for the same
  reason `repair_context_level` is recorded.

## Measured (2026-10-22)

The exact production request (prompt, schema, and the payload captured live at 10.0.13 step 2,
with the dialog's 8 controls first) was replayed offline against Voyager models, at temperature 0
with 3 runs each unless noted.

| Model | With goal | Without goal |
| --- | --- | --- |
| qwen3-235b-a22b-instruct-2507 (the gate's current model) | pre `toggle-viz-picker` (the failed locator, not on the page), then Change Visualization; 3/3 live | pre "Close dialog", then Change Visualization (2/2, ADR-0024) |
| glm-5-3 | **pre TestData, then Change Visualization**, 3/3 | pre "Close dialog", then Change Visualization, 3/3 |
| qwen35-397b-a17b | **pre TestData, then Change Visualization**, 3/3 | no usable reply (empty content), 3/3 |
| deepseek-v4-1-flash, gpt-oss-120b (1 run each) | pre "Close dialog", then Change Visualization | not run |

The glm-5-3 ablation is the cleanest result. With the same model and payload, the goal decides
"choose TestData" versus "close the dialog". With the gate's current model it does not help:
qwen3-235b proposes the failed locator as a pre-action, which the prompt forbids. Five prompt and
schema variants were tried against it offline: a clarified wording, `reasoning` first,
`pre_actions` before `corrected_action`, a separate `open_dialog` section, and a single ordered
`actions` list. None produced the two-action sequence. With the dialog in its own section it did
choose TestData, but as the only action.

## Alternatives rejected

- **`task_key` only.** The slug (`create-stat-dashboard-from-testdata`) carries the data source by
  accident of naming. It would still leave repair less informed than fresh.
- **No intent.** That keeps choice-type repairs out of scope, and keeps the §9 sides unequally
  informed.

## Consequences

- Repair and fresh are now equally informed in any run that passes `--gate-task-goal`. Earlier
  rows are marked by the absence of `repair_task_goal`.
- **Step 2 on 10.0.13 still does not pass**, for two separate reasons:
  - The check compiled from 9.5.21 is false there (#224).
  - With qwen3-235b, the proposal is still wrong.

## Open questions / what I could not verify

- **Which repair model the gate uses.** Two models available on the same gateway compose the
  correct sequence with the goal, and the current one does not. Changing it changes both sides of
  §9 (the fresh baseline must use the same provider and model). That is a founder decision, not
  made here.
- **Step-level intent.** The trajectory records each step's intent ("Open the visualization
  picker"), but compiled steps drop it. It did not change qwen3-235b's answer offline. Whether it
  helps the models that do compose is not measured.
- Live end-to-end with glm-5-3 or qwen35-397b is not run. Only the offline replay of the captured
  payload is.
