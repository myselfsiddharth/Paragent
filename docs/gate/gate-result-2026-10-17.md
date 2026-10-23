---
title: "Gate result — first live matrix run (2026-10-17): no verdict, floor not met; every failure is a post-condition"
doc_type: gate-result
status: review
owner: B4
created: 2026-10-18
updated: 2026-10-18
confidence: MED
supersedes: null
sources_verified: true
---

# Gate result — first live matrix run, 2026-10-17

**Verdict: none.** The run did not meet the §9 sample floor. Below are the measured numbers, an
indicative reading against §9, and an attribution of every failure.

**Short version.** The compiled program replays perfectly on the version it was recorded on, and
fails on every later pin. Every one of those failures is a **post-condition** the compiler made
more specific than the task. None is an action that could not be found or healed. Where an action
did break, repair located the moved control for **0.3% of the fresh-reasoning token cost**.

## What was run

| | |
| --- | --- |
| Program | `artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r2.bundle.json` — the ADR-0006 gate task, 12 steps, re-recorded after the [ADR-0021](../decisions/ADR-0021-first-live-replay-corrections.md) corrections |
| Matrix | All 8 pins in `scripts/testbed/matrix.json`, `--runs 6` → 48 runs, live, one seeded container per pin |
| Repair | `VoyagerRepairModelClient`, model `qwen3-235b-a22b-instruct-2507` (superseded as the gate model by glm-5-3 in [ADR-0027](../decisions/ADR-0027-gate-model-and-repair-cap.md)) (open-weight, served through ASU's OpenAI-spec Voyager gateway), temperature 0, ≤2 repairs/run, context level `interactive` |
| Fresh baseline | Same model, same gateway, `gate:baseline --provider voyager --runs 8` on 9.5.21 |
| Bindings | `dashboard_title=Paragent Gate {run}`, `panel_title=Gate Panel`, `series_alias=gate`, `series_count=5` |
| Code | Branch `gate/voyager-first-live-run`, commits `d041942` (Voyager clients) and `07a9440` (ADR-0021) |
| Raw output | `experiments/gate-v1/out/metrics.ndjson` (198 rows), `out/matrix-run.json`, `out/fresh-baseline/baseline.json` — gitignored, regenerable |

## Results per pin

| Pin | Runs passed | Breaks at | Mechanism |
| --- | --- | --- | --- |
| 9.5.21 (recording version) | **6 / 6** | — | 12/12 steps, 0 repairs, 1.4 s/run |
| 10.0.13 | 0 / 6 | step 2 | see A + B below |
| 10.4.19 | 0 / 6 | step 2 | same as 10.0.13 |
| 11.0.0 | 0 / 6 | step 2 | same as 10.0.13 |
| 11.5.2 | 0 / 6 | step 0 | see C below |
| 12.0.0 | 0 / 6 | step 0 | same as 11.5.2 |
| 12.2.1 | 0 / 6 | step 0 | same as 11.5.2 |
| 13.0.3 | 0 / 6 | step 0 | same as 11.5.2 |

No run was flaky. Each pin failed identically in all six repeats.

## §9, measured

| Metric | Value | Threshold (proposed, #68) |
| --- | --- | --- |
| Step-validity, executed steps | **72%** (108 / 150) | PASS ≥ 80%; dead < ~50% |
| Step-validity, all compiled steps | **19%** (108 / 576) | same |
| Task success, ≤ 2 repairs | **12.5%** (6 / 48) | PASS ≥ 90% |
| Repair cost vs fresh, tokens | **0.3%** (1,506 / 476,300) | dead ≥ 70% |
| Repair cost vs fresh, wall-clock | **12.5%** (25.9 s / 207 s) | dead ≥ 70% |
| Self-heal rate | **0%** (0 / 42) | secondary target ≥ 70% |
| Time-to-repair, amortized tokens, cache hit-rate | `no_data` | — |

**Why step-validity has two rows.** The report's formula divides by steps *executed*. A run stops at
its first failure, so a run that dies at step 0 contributes one step to the denominator, not
twelve. Read that way the number sits in the EXTEND band. Counted over every compiled step it is
below the kill line. Neither row is the gate number, because the floor was not met, and any later
citation of either must state which one it is.

**Sample floor.** 48 runs clears ≥ 42. 150 step-executions does not clear ≥ 400, because failing
runs stop early. `matrix-run.json` records `meets_floor: false`.

## Failure attribution

**A — a renamed control (repaired correctly).** On Grafana 10+ the visualization-picker toggle's
accessible name changed from `toggle-viz-picker` to `"Change Visualization"`. Its test id still
carries the old string. Repair proposed `button "Change Visualization"`, which is the right
element, from ~1,580 input tokens. This is the one action-level break in the matrix, and repair
handled it.

**B — an inserted step, and a layout-pinned post-condition (not repairable).** Grafana 10 also
opens a new "Select data source" modal over the panel editor. 9.5.21 auto-selected the default.
The modal intercepts the correct click. Repair cannot insert a step (#213). Its context also did
not contain the modal, because the 120-element capture filled up with the inert background
first (#212). Verified by hand on 10.0.13: even after inserting the data-source choice and
clicking the renamed control, step 2's post-condition times out, because it is a structural CSS
path (`main > div:nth-of-type(2) > … > button:nth-of-type(1)`). Assertions are frozen under repair
by design (ROADMAP rule 3), so this step cannot pass on any version whose layout moved.

**C — a post-condition that over-specifies the URL (not repairable).** From 11.5.2, `/dashboard/new`
settles to `?orgId=1&from=now-6h&to=now&timezone=browser`. Step 0's check is the anchored regex
`^…/dashboard/new\?orgId=1$`. The navigation is correct and the check rejects it. Repair
correctly proposed `null`.

**Across the bundle:** 7 of 12 post-conditions are anchored on structural paths, and the remaining
5 are URL checks. That is the dominant cause, and it is a compiler choice, not a property of
Grafana's churn (#211).

## The fresh baseline

8 attempts on 9.5.21. 3 were cut short by a transport error (`UND_ERR_SOCKET other side closed`:
pooled sockets racing the gateway's idle close, fixed in `d041942`) and are excluded from the
mean as truncated measurements. Of the 5 measured, 1 completed (25 turns, 362,880 input tokens)
and 4 hit the 30-turn cap (~500k). The one success was **audited against Grafana's API**: Stat
panel, TestData, alias, series count and panel title all present. It is not just the model's
claim. That matters, because a diagnostic attempt earlier the same day reported success while
skipping a required field.

The matrix started after that fix (`chat-openai.ts` saved 22:56, matrix launched 22:57). All 60
repair calls in it returned, with identical token counts within each pin (e.g. 3,160 / 80 on every
10.0.13 run), so no call was truncated.

`mean(cost_fresh)` = 475,262 input / 1,038 output tokens. Four of the five measured attempts were
capped, so this is a **lower bound** on the cost of completing the task fresh. That makes the
repair-vs-fresh ratio *conservative*: it is biased against Paragent, not for it.

## What this does not settle

- **It is not a gate verdict.** The floor was not met, and the thresholds themselves are still proposed (#68).
- **Version-bump churn is a proxy** for production churn ([testbed.md](./testbed.md)).
- **One model, open-weight, not Claude.** Repair quality and fresh cost are properties of
  `qwen3-235b-a22b-instruct-2507` on this gateway. A different model could move every number in
  both §9 arms.
- **One task, hand-recorded** (#127). The locators are better than an agent would pick at runtime.
- **The ADR-0021 corrections changed what `interactive` contains.** No earlier gate numbers
  existed, so nothing is invalidated, but any later comparison must stay on this side of
  `07a9440`.
- **Temperature 0 is not independence.** The fresh model followed nearly fixed paths. The one
  success reproduced token-for-token (362,880) across two separate runs.

## Next

Fix #211 (semantic post-condition anchors, URL view-state rule), recompile the same trajectory,
and re-run this exact matrix with nothing else changed, so the before/after is attributable to
post-conditions alone. #212 is a small capture fix. #213 (insert-capable repair or an explicit
out-of-scope) is a founder decision. #209 / #210 are about cross-agent correctness and do not
move this number.

## Re-run after ADR-0022 (2026-10-18)

The same `-r2` trajectory was recompiled with [ADR-0022](../decisions/ADR-0022-postcondition-anchoring.md)
(#211). Actions are byte-identical; only post-conditions changed. It was re-run with the identical
configuration: 8 pins × 6 runs, same model, same baseline file.

| Pin | Run 1 breaks at | Run 2 breaks at |
| --- | --- | --- |
| 9.5.21 | — (6/6) | — (6/6) |
| 10.0.13, 10.4.19, 11.0.0 | step 2 | step 2, unchanged, as predicted |
| 11.5.2, 12.0.0, 12.2.1 | step 0 | **step 2**: the URL failure is gone |
| 13.0.3 | step 0 | **step 1**: a new failure, see below |

| Metric | Run 1 | Run 2 |
| --- | --- | --- |
| Step-validity, executed steps | 72% (108/150) | 78% (150/192) |
| Step-validity, all compiled steps | 19% (108/576) | 26% (150/576) |
| Task success, ≤ 2 repairs | 12.5% (6/48) | 12.5% (6/48) |
| Repair cost vs fresh, tokens | 0.3% | 0.55% |
| Repair cost vs fresh, wall-clock | 12.5% | 25.4% |
| Self-heal | 0 / 42 | 0 / 42 |

Still **no verdict**: 192 step-executions against a floor of 400. Repair costs rose only because more
runs now reach a repairable step.

**What remains is one failure class: inserted steps (#213).** Step 2 on 10.0.13 through 12.2.1 is the
data-source modal (attribution B above). On 13.0.3, "Add new panel" became an "Add" menu with a
"Visualization" item. Repair proposed `button "Add"`, which is the right control and executed
successfully, but one recorded click is now two, and a single-action repair supplies one. Probed by
hand on a live 13.0.3. No post-condition failure remains in the matrix.

## Open questions / what I could not verify

- **Whether 10.4.19 and 11.0.0 fail for exactly the same reason as 10.0.13.** They fail at the same
  step with identical repair costs, but only 10.0.13 and 11.5.2 were probed by hand.
- ~~Whether self-heal would be non-zero once #211 lands, or whether #213 is binding.~~ **Answered by
  the re-run: #213 is binding.** After #211, every remaining failure is an inserted step.
