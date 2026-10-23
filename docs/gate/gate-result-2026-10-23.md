---
title: "Gate result — full matrix on glm-5-3 (2026-10-23): EXTEND. Step-validity 81%, task success 50%, repair 1.4% of fresh"
doc_type: gate-result
status: review
owner: B4
created: 2026-10-23
updated: 2026-10-23
confidence: MED
supersedes: null
sources_verified: true
---

# Gate result — full matrix run, 2026-10-23

**Verdict: EXTEND** against PRD §9, applied as written and treated as *proposed* thresholds (see
"Which document controls"). Step-validity clears the 80% bar. Task-level success with ≤2 repairs
is 50%, short of 90%. Repair costs 1.4% of a fresh run, nowhere near the 70% kill line.

**Short version.** On 7 of 8 Grafana versions the compiled program now completes the task:
42 of 48 runs, every run on those versions.

- **9.5.21, the recording version:** passes without repair.
- **10.0.13 → 11.0.0:** pass within §9's two-repair allowance.
- **11.5.2 → 12.2.1:** complete the task but need a third repair, at step 7, so they miss the
  ≤2 bar.
- **13.0.3:** fails at step 1 on a control that only appears after another click (#226).

Every number below comes from committed files and was produced by `scripts/gate-memo-figures.mjs`.
**Read the caveats before quoting any of them.** The program and the repair design were corrected
against these same eight versions.

All figures are from `experiments/gate-v1/results/2026-10-23/` unless stated otherwise. That
directory holds `report/report.json`, `metrics.ndjson`, `matrix-run.json` and
`fresh-baseline/baseline.json`. To reprint every figure:
`node scripts/gate-memo-figures.mjs experiments/gate-v1/results/2026-10-23`.

## What was run

| | |
| --- | --- |
| Code | `main` at `648e0a7` (#233) |
| Program | `artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r3.bundle.json`: the ADR-0006 gate task, 12 steps, recorded on 9.5.21 ([ADR-0026](../decisions/ADR-0026-controls-appeared.md)) |
| Matrix | All 8 pins in `scripts/testbed/matrix.json`, 6 runs each, live, one seeded container per pin. None skipped (`matrix-run.json` `versions_skipped: []`) |
| Repair | `glm-5-3` on ASU's Voyager gateway, temperature 0 ([ADR-0027](../decisions/ADR-0027-gate-model-and-repair-cap.md)). No repair cap; each run bounded by a 300 s budget (`repair_cap: null`). Repair is told the task goal (`--gate-task-goal`, ADR-0025). Context level `interactive` |
| Fresh baseline | Same model and gateway: `gate:baseline --provider voyager --runs 8 --version 9.5.21`, same program and goal text (`fresh-baseline/baseline.json`) |
| Bindings | `dashboard_title=Paragent Gate {run}`, `panel_title=Gate Panel`, `series_alias=gate`, `series_count=5` |

## The numbers (`report/report.json`, `.metrics`)

| §9 quantity | Measured | Numerator / denominator | §9 bar (proposed) |
| --- | --- | --- | --- |
| Step-level replay-validity | **81.4%** | 420 / 516 step executions | PASS ≥ 80%; dead < ~50% |
| Task-level success, ≤2 repairs/run | **50.0%** | 24 / 48 runs | PASS ≥ 90% |
| Repair cost vs fresh, tokens | **1.4%** | mean 4,085 / mean 290,775 | dead ≥ 70% |
| Repair cost vs fresh, wall-clock | **6.0%** | mean 8.5 s / mean 140.4 s | dead ≥ 70% |
| Self-heal success rate | **85.7%** | 36 / 42 runs that failed a step on first pass | secondary target ≥ 70% |
| Time-to-repair, mean | **8.5 s** | 306,158 ms / 36 runs | — |
| Amortized tokens/task over N runs | **no_data** | 0 / 0. No program-build cost was attached (`--cost-program-build` not passed) | — |
| Cache hit-rate over N runs | **no_data** | 0 / 0. The matrix replayed a file, not a cache (`program_source: file`) | — |

Sample: 48 runs and 516 step executions, against §9's ≥42 / ≥400: **met** (`report.json` `sample`).
No run was cut short by its time budget. 60 steps were never attempted, all on 13.0.3 after the
step-1 failure (`report.json` `truncation`). Every run's repair cost was measured
(`cost_provenance`: 48 of 48).

Task success with any number of repairs, which is not a §9 bar: **42 / 48** (`metrics.ndjson` run
rows, `task_success`).

## Per version (`metrics.ndjson` run rows)

| Version | Task success | Within ≤2 repairs | Repairs per run | Where repaired / where it stops |
| --- | --- | --- | --- | --- |
| 9.5.21 (recording) | 6 / 6 | 6 / 6 | 0 | — |
| 10.0.13 | 6 / 6 | 6 / 6 | 2 | step 2 (inserted action), step 6 |
| 10.4.19 | 6 / 6 | 6 / 6 | 2 | step 2 (inserted action), step 6 |
| 11.0.0 | 6 / 6 | 6 / 6 | 2 | step 2 (inserted action), step 6 |
| 11.5.2 | 6 / 6 | **0 / 6** | 3 | steps 2, 6, **7** |
| 12.0.0 | 6 / 6 | **0 / 6** | 3 | steps 2, 6, **7** |
| 12.2.1 | 6 / 6 | **0 / 6** | 3 | steps 2, 6, **7** |
| 13.0.3 | **0 / 6** | 0 / 6 | 3 | **stops at step 1**, `REPAIR_EXHAUSTED` |

**What each repaired step was** (step rows, non-`PASS` outcomes):

- **Step 2, "Open the visualization picker", 36 / 36 repaired.** Every one inserted an action
  first (`pre_action_count: 1`): Grafana 10+'s data-source dialog (ADR-0024).
- **Step 6, "Title the panel", 36 / 36 repaired.** The title field moved. Repairable since ADR-0028.
- **Step 7, "Apply the panel and return to the dashboard", 18 / 18 repaired on 11.5.2 → 12.2.1.**
  It is repaired every time, so it never stops a run. But it is the third repair, and so it alone
  moves those 18 runs from inside the ≤2 bar to outside it. **Its cause has not been
  investigated.**
- **Step 1 on 13.0.3, "Add a visualization", 0 / 6.** "Add new panel" became an "Add" menu, then a
  "Visualization" item. A one-shot repair cannot name an item that only appears after the first
  click ([#226](https://github.com/myselfsiddharth/Paragent/issues/226)).

## Which document controls, and are the thresholds binding

PRD §9 sets four lines:

- **PASS:** step-validity ≥ 80% **and** task success ≥ 90%.
- **Dead:** step-validity < ~50% **or** repair cost ≥ 70% of fresh.
- **Otherwise:** extend.

The pivot brief §7 restates only the kill line ("replay-validity < ~50% or repair cost ≈ fresh").

- **Under the PRD,** this run is **EXTEND**. It clears both kill conditions by a wide margin and
  misses PASS on task success.
- **Under the pivot brief,** the thesis is **not dead**.

The two documents do not conflict here. They disagree only about what counts as PASS, and the PRD
is the stricter and more complete one, so it is the frame used.

**Binding.** `docs/INTEGRITY-AUDIT.md` B-05 and D-03, and PRD v0.4 addendum §2, label these
thresholds **proposed and unvalidated**, accepted by the founder at gate-memo time. This memo
applies them as the evaluation frame. It does **not** accept them: that is the founder's decision
in [#31](https://github.com/myselfsiddharth/Paragent/issues/31).

## Caveats, unhedged

1. **The program and the repair design were corrected against these eight versions.**
   - ADR-0021 → ADR-0028 each came from a failure observed on this matrix.
   - The gate task was re-recorded twice (r2, r3).
   - The repair model was switched (ADR-0027) after qwen3-235b could not compose the step-2 repair.

   Each change is a general mechanism (a dialog-first capture, sequence repair, a fill bound to its
   own slot), not a Grafana-specific rule, and each is tested on synthetic pages. But **this
   number measures a design tuned on its own test set.** A held-out check, such as a second product,
   a second task or versions not in this matrix, has not been run.

2. **Version-bump churn is a proxy for production churn** (`docs/gate/testbed.md`). PRD §9's
   protocol is 3 runs a day for 14 days against a live site. This is a version matrix instead.
   Pivot brief §4 requires confirming against one live site. **That has not happened.**

3. **Six runs per version are not six independent samples.** At temperature 0 every version
   behaved identically across its six runs (the per-version table has no mixed rows). The sample
   floor is met in count, but the effective sample is closer to 8 versions × 1.

4. **Weak assertions soften the step-validity number.** r3 has 6 strong and 6 weak checks.
   - Strong steps were valid on first pass **90.9%** of the time (240 / 264).
   - Weak steps were valid **71.4%** of the time (180 / 252).

   A weak check can pass while the step's real purpose failed. `controls-appeared` (steps 2 and
   8), for example, passes if a wrong panel opens (ADR-0026). `docs/gate/assertion-audit.md`
   audits r1, and **has not been re-run on r3**.

5. **The fresh baseline is a lower bound, and a thin one.**
   - 8 attempted, **6 measured**. 2 were dropped after Voyager gateway transport errors (TLS);
     they are flagged `unmeasured` and excluded.
   - **0 of 6** completed the task within 30 turns.

   So the fresh cost is the cost of failing to finish, not of finishing. That biases the 1.4%
   ratio *against* Paragent, but it also means the comparison is between a repair that finishes
   and a fresh run that does not.

6. **One model, not Claude.** glm-5-3, open-weight, on one academic gateway. On this same task, a
   different model (qwen3-235b) could not do the step-2 repair at all (ADR-0025). The numbers are
   properties of this model as much as of the mechanism.

7. **One task, one product.** Grafana OSS, the ADR-0006 task.

## Compared with the run before the fill fix (2026-10-22, same setup)

`experiments/gate-v1/results/2026-10-22-fill-bug/` is the same matrix on the code before #233,
when no repaired fill step could carry its value.

| | 2026-10-22 (fill bug) | 2026-10-23 |
| --- | --- | --- |
| Step-level replay-validity | 76.8% (258 / 336) | 81.4% (420 / 516) |
| Task success ≤2 repairs | 12.5% (6 / 48) | 50.0% (24 / 48) |
| Task success, any repairs | 6 / 48 | 42 / 48 |
| Repair vs fresh, tokens | 1.5% | 1.4% |

That run stopped every 10.0.13 → 12.2.1 run at step 6. The only code change between the two runs
is [ADR-0028](../decisions/ADR-0028-fill-repair-binding.md) (#233), so the step-validity and
task-success differences are its effect. The cost ratios also moved because the fresh baseline was
re-measured for each run.
[gate-result-2026-10-17](gate-result-2026-10-17.md) was on a different model, program and repair
design, and is not comparable with either.

## What this settles, and what it does not

**Settles,** for this task on this product: a compiled trajectory, with action-only repair, can
survive controlled version churn from 9.5 to 12.2 (three later major versions) for about 1–2% of
the tokens of reasoning the task fresh. The failure classes that remain are named and few:

- one step needing a third repair (step 7, on 11.5.2 → 12.2.1);
- one shape of churn the repair design cannot yet express (#226, on 13.0.3).

**Does not settle:**

- whether it survives organic production churn (caveat 2);
- whether the design generalizes beyond what it was tuned on (caveat 1);
- whether the counterparty thesis is alive (ADR-0004 closed that);
- whether anyone will pay for it.

## Handoff

- **Founder decision:** [#31](https://github.com/myselfsiddharth/Paragent/issues/31), kill or
  continue, including whether the §9 thresholds are accepted as binding. The 3-business-day
  clock in `docs/research/vertical-search/DECISION.md` applies to a PASS; this is not one.
- **PRD §9 for EXTEND:** "extend the window, add a second site, decide on data." The cheapest
  moves, in order:
  1. **Step 7 on 11.5.2 → 12.2.1.** Find why it needs repair. If it is a post-condition rather than
     an action, as step 2 was (#224), it may be a compile-side fix that brings 18 runs inside the
     ≤2 bar, with no change to repair.
  2. **#226** for 13.0.3.
  3. **A held-out check** (caveat 1) and **one live site** (caveat 2). These bear on the verdict
     more than either fix does.
- `docs/pitch/proof-points.md`'s `[PENDING TRACK-1]` markers are **left as they are** until #31 is
  decided. Pitch claims should follow the decision, not this memo.

## Open questions / what I could not verify

- **Why step 7 needs repair on 11.5.2 → 12.2.1.** It is repaired every time, and the cause was not
  looked at for this memo.
- **Whether the result holds on anything held out:** another product, task or version. Nothing
  held out was run (caveat 1).
- **Whether the assertion audit's load-bearing count changes on r3.** The audit was done on r1;
  only the strong/weak split above is measured for r3.
- **Whether a fresh run that finishes costs much more than one that runs out of turns.** No fresh
  run finished in this baseline, so the ratio's denominator is a cost of not finishing.
