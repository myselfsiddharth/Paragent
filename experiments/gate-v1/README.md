---
title: Gate-v1 experiment harness (throwaway)
doc_type: runbook
status: draft
owner: B4
created: 2026-07-24
updated: 2026-08-11
confidence: MED
supersedes: null
sources_verified: true
---

# experiments/gate-v1/

**Throwaway.** Week-gate harness only — do not promote into a product API.

## Contents

| Path | Role |
| --- | --- |
| `fixtures/compiled-program.json` | 2-step local demo program |
| `fixtures/local-demo.html` | Static page for the local-demo program |
| `live-run.ts` | Per-version live driver: bring-up, browser, replay, teardown (#62) |
| `trajectories/` | B2 recorded trajectories (fixture gate task) |
| `run-matrix.ts` | Matrix CLI — live by default, `--dry-run` for the no-Docker path |
| `report/generate-amortized.ts` | SVG/CSV/HTML/JSON from NDJSON (`writeReport`) |
| `out/` | Generated metrics + reports (gitignored) |

## The version list

[`scripts/testbed/matrix.json`](../../scripts/testbed/matrix.json) — the ADR-0003 pins — is the
**only** version list, read through `src/testbed/matrix.ts`. This directory used to carry its
own `versions.json` holding a single `pending-b1@placeholder` entry, so every report generated
here was a report about nothing. It was deleted in
[#26](https://github.com/DevToolie/Paragent/issues/26) rather than kept in sync: two lists for
one thing drift, and its only non-duplicated fields (`site_key` / `task_key` overrides) were
actively misleading — they relabelled the local-demo program per version as if a Grafana run had
happened.

Consequently **only `testbed_version` varies per run.** `site_key` and `task_key` stay whatever
the compiled program actually is.

A version marked `"status": "unavailable"` in `matrix.json` is **skipped and recorded**, never
silently dropped — see `out/matrix-run.json`.

## Commands

```bash
npm run gate:matrix                                       # LIVE, every available pin
npm run gate:matrix -- --versions 9.5.21 --headed         # one version, watch it
npm run gate:matrix -- --dry-run                          # no Docker, no browser
npm run gate:matrix -- --dry-run --versions 11.0.0,12.0.0 # a subset
npm run gate:report
npm run recorder -- --fixture
```

Since [#62](https://github.com/DevToolie/Paragent/issues/62) the **default is a live run**: one
seeded container per version, a real browser, real step outcomes. `--dry-run` is kept because it
exercises the harness without Docker and the CI job depends on it.

| Flag | Effect |
| --- | --- |
| `--dry-run` | No Docker, no browser. Hard-coded `PASS`, zero tokens, rows labelled not-a-measurement |
| `--versions <list>` | Comma-separated ids, or `all` (default) |
| `--program <path>` | A `CompiledProgram` **or** a `compiled_trajectory` bundle from `artifacts/compiled/` |
| `--param k=v` | Bind one of the program's own `param_refs`. Repeatable. `{run}` in a value is replaced by the run number |
| `--runs <n>` | Repeats per version (default 3). See below |
| `--port <n>` | Host port for the test-bed (default 3000) |
| `--headed` | Show the browser |
| `--keep-up` | Leave each container running for inspection |
| `--no-preamble` | Skip the login preamble, for programs that log in as a measured step |

`base_url`, `host` and `port` are bound by the driver and cannot be overridden by `--param`: a
program must not be able to redirect itself away from the version being measured. Every other
hole the program declares is the caller's to supply — inventing a default would silently
substitute a value the recording never used.

You do not have to work out which holes those are. Since
[#132](https://github.com/DevToolie/Paragent/issues/132) the driver derives them from the
program itself (`requiredParams`, `src/runner/params.ts`) and refuses **before the first
container boots**, naming every one it is missing:

```text
gate:matrix: prog-traj-gate-live-create-stat-dashboard-from-testdata-9.5.21 needs parameter(s) nothing binds: panel_title, series_alias, series_count.
  Pass --param panel_title=<value> --param series_alias=<value> --param series_count=<value>
  Refusing to start: an unbound parameter fails as PAGE_ERROR or ASSERTION_FAILED, which is
  indistinguishable from site churn in the §9 aggregates.
```

Names only — a required-param *name* is printed, a value never is. Exit 2, nothing booted,
no NDJSON row.

Unknown ids are rejected with the valid list, never defaulted:

```text
gate:matrix: unknown version id(s): 99.0.0
valid ids (scripts/testbed/matrix.json): 9.5.21, 10.0.13, 10.4.19, 11.0.0, 11.5.2, 12.0.0, 12.2.1, 13.0.3
```

Exit codes: **2** for a usage error, an unknown id, or a live run with no Docker daemon; **1** if
the run measured zero versions — an empty NDJSON is a missing denominator, not a successful run.

## Repeat runs (`--runs`)

One run per version is not a sample. PRD §9 specifies 3×/day for 14 days — **≥42 runs and ≥400
step-executions** — and the pivot to a version matrix swaps the calendar, not the statistics.
Eight pins at one run each is 8 runs, an order of magnitude short, and it cannot tell "this
locator broke on v12" from "that run flaked".

**Default 3.** Enough to *see* disagreement between repeats, cheap enough that people actually
run it. Clearing the §9 floor across the eight pins needs `--runs 6`:

| `--runs` | Runs across 8 pins | Clears ≥42? |
| --- | --- | --- |
| 1 | 8 | no |
| 3 (default) | 24 | no |
| 5 | 40 | **no** — two short |
| 6 | 48 | yes |

The shortfall is **reported, not enforced**: `gate:matrix` prints it before the first boot and
`report.json` carries a `sample` section with `meets_floor` and the exact gap. A short sample is
still worth looking at; what must not happen is a short sample being read as a gate measurement.

**Each run is independent.** A fresh browser context and a fresh login per run — not per version.
Reusing a context would let run 1's cookies and cache decide run 2's outcome, the repeats would
correlate, and the spread would understate the real variance that repeats exist to measure.

**State-mutating tasks need help.** The gate task creates a dashboard, so replaying it twice
against one container collides on the second run and fails for a reason that is not churn. Put
`{run}` in the value and it becomes unique per run:

```bash
npm run gate:matrix -- --runs 3 \
  --program artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21.bundle.json \
  --param 'dashboard_title=Paragent Gate {run}' \
  --param 'panel_title=Gate Panel' \
  --param series_alias=gate \
  --param series_count=5
```

The live bundle declares **four** caller-supplied holes, one per `fill` step — `series_alias`
(step 4), `series_count` (step 5), `panel_title` (step 6), `dashboard_title` (step 9). `host`
and `port` come from step 0's `url_template` and are bound by the driver, which is why they are
absent above. Every value except `dashboard_title` is a placeholder: pick whatever the gate run
should assert on.

`{run}` belongs on `dashboard_title` specifically — that is the value the save collides on. It
is deliberately explicit rather than automatic: auto-suffixing every param would silently change
values a recording captured, while the assertion templates still compared against the recorded
hole.

This README used to document the same command with `dashboard_title` alone. Run against the live
bundle before [#132](https://github.com/DevToolie/Paragent/issues/132), the three unbound fills
failed as `PAGE_ERROR` mid-run and landed in the §9 churn denominators — a *worse gate number*
rather than an error. The pre-flight above now refuses in about a second instead
([#142](https://github.com/DevToolie/Paragent/issues/142)).

**Interrupting is safe.** Ctrl-C finishes the run in flight, tears down the container, and stops:
the completed runs stay in the NDJSON as real measurements and the version is recorded as
`SKIPPED (interrupted)` with how far it got. A second Ctrl-C aborts immediately and may orphan a
container. Rows are appended after every run rather than written once at the end, so a partial
NDJSON is always valid.

### Per-version variance in the report

`report.json` gained a `per_version` section, because pooled ratios hide the finding:

```json
{"testbed_version": "11.0.0", "runs_attempted": 3, "runs_succeeded": 2,
 "step_validity_per_run": [1, 0.5, 1], "step_validity_spread": 0.5, "status": "computed"}
```

A version at 3/3 and one at 2/3 are different findings, and pooling makes them one number. A
non-zero `step_validity_spread` on repeats of an **unchanged** version is harness flakiness, not
churn — and that has to be understood before any matrix number is trusted.

`status: "no_data"` (not `0`) when a run emitted no step rows: zero would be indistinguishable
from every step having failed.

### `out/matrix-run.json` — the skip ledger

Written every run beside the NDJSON. Records `mode`, the selection, `runs_per_version`,
`runs_planned` vs `runs_completed`, `interrupted`, `section9_floor`, `versions_in_matrix`,
`versions_walked`, `state_baseline_version`, and `versions_skipped[] {id, stage, reason}`.
Without it a later reader cannot tell "8 pins, 3 unavailable" from "5 pins", and the denominator
shrinks silently.

**A skip is not a failure.** A version whose container never started, whose image would not pull,
whose login broke, or whose seed state differs from the base version produced *no measurement*.
It is recorded with the stage it died at and never reaches the NDJSON. The stages are
`compose-up`, `readiness`, `seed`, `fingerprint`, `browser`, `login-preamble`, `interrupted`.

**No run is ever discarded.** Every attempted run appears in the NDJSON, including a run that
failed and a run cut short by an interrupt. Dropping an outlier is the single easiest way to
manufacture a passing gate, and it would be undetectable in the report.

The ledger also carries the pre-repair outcome per step, which the NDJSON cannot:

```json
{"step": 1, "outcome": "REPAIR_EXHAUSTED", "first_pass": "LOCATOR_NOT_FOUND"}
```

Every genuine failure ends as `REPAIR_EXHAUSTED` in the metric row, because stub repair always
proposes `null` and `contracts/metrics.schema.json` has no field for a reason. See
[gate/runner.md](../../docs/gate/runner.md) — it is a workaround, not a fix.

Report paths (after `gate:report`):

- `experiments/gate-v1/out/report/report.json`
- `experiments/gate-v1/out/report/report.csv`
- `experiments/gate-v1/out/report/report.html`
- `experiments/gate-v1/out/report/amortized.svg`

Empty NDJSON → scaffold with `status: no_data` and null values (never invented rates).

## Sources

| Claim | Source | Access date |
| --- | --- | --- |
| §9 measurable fields | `contracts/metrics.schema.json` | 2026-07-24 |
| Runner emits step/run rows | `docs/gate/runner.md` | 2026-07-24 |
| Fixture trajectory | `docs/gate/recorder.md` | 2026-07-25 |

## Open questions / what I could not verify

- ~~Wire `versions.json` to ADR-0003 / `scripts/testbed/matrix.json` pins.~~ **Done (#26)** —
  `versions.json` is deleted and the harness reads the pins directly. Walking eight versions
  makes the row count honest; #62 then made the rows real. Neither makes the *numbers*
  meaningful — that needs a gate-task program (#25) and repeat runs (#66).
- The program under test is still `fixtures/compiled-program.json`, whose own
  `testbed_version` reads `pending-b1@placeholder` because it was compiled against no testbed at
  all. That is accurate and left alone; the runner overrides it per version.
- Fresh-reasoning baseline cost measurement path — not wired; `cost_fresh` stays zeros until
  measured. It is the **per-run** §9 ratio denominator only. The §12 amortized curve consumes a
  separate one-time `cost_program_build` and reports `no_data` until a payment is measured, which
  nothing here emits yet ([ADR-0010](../../docs/decisions/ADR-0010-amortization-cost-model.md),
  [#123](https://github.com/DevToolie/Paragent/issues/123)).
- ~~Live matrix against Grafana OSS.~~ **Done (#62)** — `npm run gate:matrix` brings up each pin,
  drives Chromium, and emits real outcomes. What it does **not** yet establish: a *meaningful*
  number. The only Grafana-targeted bundle on `main` is a compile of a hand-written example, and
  its step-0 assertion (`getByRole("form")`) matches zero elements on real Grafana — an unnamed
  `<form>` has no ARIA role. The driver reported that honestly on its first live run, which is
  the harness working, not the gate measuring. The gate task bundle arrives with
  [#25](https://github.com/DevToolie/Paragent/issues/25).
- ~~One run per version is not a sample.~~ **Addressed (#66)** — `--runs`, per-version variance,
  and a reported §9 floor. What it does **not** settle: whether the harness is flaky under a
  *realistic* task. Three live repeats of one unchanged version agreed exactly
  (`step_validity_spread: 0`), but the program was the 2-step example bundle. A 12-step task with
  drawer and picker interactions is where flakiness would appear, and that task arrives with #25.
- Nothing reseeds between runs. `{run}` substitution makes a mutating task's state unique, which
  is enough for a dashboard title; a task that mutates state it cannot parameterise away would
  need a container recreated per run, which is not implemented.
- Whether a metric row should carry the pre-repair outcome. Today it cannot, so the ledger holds
  it instead; see [gate/runner.md](../../docs/gate/runner.md).

## Committed results

`out/` is gitignored and regenerable. A run that a gate-result memo cites is copied to
`results/<date>/` and committed, so every figure in the memo stays reproducible (#28, #29):

- `results/2026-10-23/`: the run behind [gate-result-2026-10-23](../../docs/gate/gate-result-2026-10-23.md).
- `results/2026-10-22-fill-bug/`: the same matrix before #233, kept for the before/after comparison.

`node scripts/gate-memo-figures.mjs results-dir` prints every figure the memo cites from these files.

