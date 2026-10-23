---
title: "ADR-0027: the gate runs on glm-5-3, and its runs repair until the task finishes or time runs out"
doc_type: adr
status: review
owner: B3
created: 2026-10-22
updated: 2026-10-22
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0027 — Gate model and repair cap

**Status:** review · **Decided by the founder, 2026-10-22:** switch the gate's model, and run without a
repair cap ("time budget only"). Follows [ADR-0025](ADR-0025-repair-task-goal.md)'s measurement.
Amends the setup in [gate-result-2026-10-17](../gate/gate-result-2026-10-17.md) and runner
invariant 3 (`docs/gate/runner.md`).

## 1. Model: `glm-5-3` on Voyager, for both sides of §9

`DEFAULT_VOYAGER_MODEL` changes from `qwen3-235b-a22b-instruct-2507` to **`glm-5-3`**. The repair
client and the fresh-baseline client share that one constant, so the two sides of the §9 ratio
cannot drift apart. The provider, temperature (0), prompts and schemas are unchanged.

**Why.** On Grafana 10.0.13, step 2 needs a two-action repair: choose the data source, then the
step's own click (ADR-0024).

- qwen3-235b never produced that, across five prompt and schema variants (ADR-0025).
- glm-5-3 produced it 3/3 offline on the captured payload. It then passed step 2 live through the
  gate driver: r3 + `--gate-task-goal`, `REPAIRED_PASS` with one inserted action.
- qwen35-397b also produced it 3/3 offline. It was not run live, so glm-5-3 is the one with
  end-to-end evidence.

**Fresh baseline, re-measured on the new model** (`gate:baseline --provider voyager --runs 8 --version
9.5.21`, r3 program, the same `DEFAULT_TASK_GOAL` the matrix passes):

| | qwen3-235b (2026-10-17) | glm-5-3 (2026-10-22) |
| --- | --- | --- |
| Usable runs | 8 attempted, 5 measured | 8 / 8 |
| Completed the task | 1 of 5 measured (4 capped at 30 turns) | **2 of 8** (6 capped at 30 turns) |
| mean `cost_fresh`, input tokens | 475,262 | **323,388** (min 208,088, max 386,746) |
| mean `cost_fresh`, output tokens | 1,038 | 3,371 |
| mean wall-clock | 207 s | 187 s |

Most fresh attempts on both models hit the turn cap. So `mean(cost_fresh)` is a **lower bound** on
the cost of completing the task fresh, and the repair-vs-fresh ratio stays biased *against*
Paragent, as the 2026-10-17 memo says. The baseline file is regenerable and gitignored, like the
first one.

**Consequences:**

- Every §9 number from before this ADR was measured on qwen3-235b. None of them is comparable with
  numbers after it. Rows carry `model_id`, and the matrix already warns if the repair model and the
  fresh baseline's model differ.
- A one-off run on qwen3-235b is still available with `--repair-model` / `--model`.

## 2. Repair cap: none in the gate matrix; the run's time budget bounds it

`gate:matrix` now runs **uncapped** by default (`--max-repairs-per-run none`; a number restores a
cap). A run repairs until the task finishes or its `wall_clock_budget_ms` (ADR-0011, 300 s) is spent.

**The §9 bar does not move.** `success_with_le_2_repairs` is computed separately and fixed at 2
whatever the cap is (runner invariant 3, pinned by `tests/integration/repair-invariants.test.ts`). The
cap only decided how far a run got. At 2, it cost two things:

1. **Steps past the second repair were never attempted.** On 10.0.13 runs stopped at step 6, so
   steps 7–11 had no step-validity data at all.
2. **Repair cost was understated.** A run that stops early spends less than one that finishes,
   while `cost_fresh` is the cost of a fresh attempt at the whole task.

**One guard, which is not a cap.** When the model proposes exactly the sequence it already tried
and failed on the current step, the step ends `REPAIR_EXHAUSTED` without executing it. The same
actions on the same page cannot pass a check they just failed. At temperature 0 this is the common
case, and it would otherwise spend the whole time budget learning nothing. The proposal's cost
is still counted.

**Recording.** Run rows gain `repair_cap`: the cap in force, `null` when uncapped, absent on rows
from before this ADR (cap 2). `matrix-run.json` records it too. `ReplayRunner`'s own default stays
2 for other callers.

## Alternatives rejected

- **Raise the cap to 6.** It keeps a limit nobody can derive. The time budget already bounds a
  run, and the §9 bar is unaffected either way.
- **Keep the model and keep tuning prompts.** Five variants did not get qwen3-235b to compose the
  sequence, and the same prompt and payload work on glm-5-3 and qwen35-397b.

## Open questions / what I could not verify

- **glm-5-3 across the whole matrix.** Only 9.5.21 (fresh) and 10.0.13 (repair, one live run) are
  measured. The next full matrix run is the measurement.
- **Whether 300 s is enough uncapped.** A glm-5-3 proposal took about 12 s live, so a run has room
  for roughly 20 repairs. Runs that hit the budget say so (`budget_exhausted`), and the report
  counts them.
- **Gateway availability of glm-5-3** over the window a gate run needs is not guaranteed. A
  model swap mid-matrix would show up as a `model_id` change on the rows.
