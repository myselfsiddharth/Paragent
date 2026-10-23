---
title: Runner, repair loop, and gate metrics
doc_type: spec
status: draft
owner: B4
created: 2026-07-24
updated: 2026-08-16
confidence: MED
supersedes: null
sources_verified: true
---

# Gate — Runner (B4)

Replays a **compiled program** (cache-row actions + assertions) in Playwright,
repairs **actions only** on failure (≤2 repairs/run by default), and emits
**measured** step/run metrics for PRD §9. Never invents token counts or gate rates.

## Package layout (`src/runner/`)

| Module | Responsibility |
| --- | --- |
| `types.ts` | `CompiledProgram`, steps, assertions, repair/run result types |
| `templates.ts` | `interpolate`, `PARAM_HOLE`, `deepFreeze`, `assertionsEqual` |
| `params.ts` | `requiredParams` / `missingParams` / `assertParamsBound`, `UnboundParamsError` — the pre-run binding check |
| `locators.ts` | Playwright `getByRole` / `getByLabel` / `getByTestId` / `getByText` / `getByPlaceholder` / `locator`; `topology_only` → not found |
| `assertions.ts` | `evaluateAssertion` → `PASS` / `ASSERTION_FAILED` / `LOCATOR_NOT_FOUND` / `TIMEOUT` / `PAGE_ERROR` |
| `actions.ts` | `executeAction` for navigate/click/fill/select/check/uncheck/press/hover/wait/upload/custom |
| `page-state.ts` | `capturePageState` / `emptyPageState` — no cookies, storage, or raw HTML. `visible_landmarks` runs the **one** enumeration from `src/shared/landmarks.ts`, byte-identical to what `src/recorder/fingerprint.ts` runs ([ADR-0007](../decisions/ADR-0007-post-action-visibility.md), #74). It owns no role list of its own: before #74 it enumerated 6 `[role=]` selectors and missed `complementary` / `contentinfo` / `region` the recorder reported, so the repair model would be handed landmarks the recorder never produced. The evaluate body is a string on purpose: named function expressions get esbuild's `__name` wrapper, which does not exist in the browser. Covered by `tests/unit/page-state.test.ts` and `tests/unit/landmarks.test.ts` |
| `repair.ts` | `RepairModelClient`, `StubRepairModelClient` (null action, zero tokens), `assertAssertionUnchanged` |
| `replay.ts` | `ReplayRunner` — dry-run, repair loop, metrics emission |
| `metrics/` | Sibling package: emitter + §9 aggregates |

## Bounded runs (`runBudgetMs`)

Per-step waits were bounded before ([below](#bounded-waits)); the **run** was not. Nothing capped
elapsed time, only repair attempts, so a task with several stale locators could sit for an
unbounded stretch — and §9's kill line is measured in wall-clock as well as tokens.

Since [#84](https://github.com/DevToolie/Paragent/issues/84) every run carries a ceiling:
`DEFAULT_RUN_BUDGET_MS` = 300 000 ms, overridable via `ReplayRunnerOptions.runBudgetMs`, disabled
with `<= 0`. It is checked **at step boundaries and before each repair proposal, never
mid-action** — no assertion is ever denied its own timeout, so nothing about what is measured
changes. A run can therefore overshoot by at most one step.

What it reports matters more than that it fires ([ADR-0011](../decisions/ADR-0011-replay-wall-clock-budget.md)):

| Situation | Row |
| --- | --- |
| Step attempted, failed, budget ended its repair | step row, new outcome `BUDGET_EXHAUSTED`, `first_pass_outcome` preserved, `replay_valid: false` |
| Step never reached | **no row** — it was not attempted, and scoring it would invent a result |
| The run itself | `budget_exhausted`, `wall_clock_budget_ms`, and `steps_attempted` beside `steps_total` |
| The report | a `truncation` block beside the §9 sample floor: `runs_truncated_by_budget`, `steps_unattempted` |

`BUDGET_EXHAUSTED` is a new `stepOutcome` member rather than a reuse: `TIMEOUT` means the *site*
did not respond, and `REPAIR_EXHAUSTED` claims attempts ran out when in fact time did. `selfHealRate`
now divides by attempted steps, so a run truncated with nothing failing is not scored as a failed
self-heal.

## Bounded waits

Every wait the runner performs has an explicit ceiling. One did not: a `wait` step with no
positive duration parameter called `page.waitForLoadState("networkidle")` with **no timeout**,
inheriting Playwright's 30s default — a number nobody here chose. If the page never goes quiet
for 500ms the step burned all 30s and then failed anyway: maximum latency for zero information.

Now bounded by `NETWORK_IDLE_WAIT_MS` (5000ms, `src/runner/actions.ts`), overridable per run via
`ReplayRunnerOptions.networkIdleWaitMs`. Measured in `tests/unit/runner-bounded-wait.test.ts`
against a page that never reaches idle:

| | unbounded (before) | bounded (after) |
| --- | --- | --- |
| default | 30.8 s | 5.0 s |
| 1s override | 30.0 s | 1.0 s |

**Honest scope.** The seeded Grafana dashboard does *not* trigger this — `networkidle` settles
there in ~3 ms (measured on 11.0.0, `/d/paragent-seed`, 2026-07-28), because the seed dashboard
sets no refresh interval and TestData is generated client-side. This is a **latent** worst case,
reachable on any surface with continuous polling, streaming, or websockets — not a hang observed
on the current test-bed. Bounding it is cheap insurance taken before the gate runs, not a fix
for a live symptom.

**It changes which steps pass.** A page that first goes quiet at 12 s held the step until it did
and does not now — at 5 s the step continues and the assertion decides on whatever is on screen.
Deliberate, and cheap *today* because no gate number exists yet: since
[#62](https://github.com/DevToolie/Paragent/issues/62) `gate:matrix` runs live, but one run per
version over an example program is not a measurement. After a published measurement this would be
an expensive silent shift.

### A recorded wait reproduces exactly (ADR-0008)

`TrajectoryRecorder.wait(intent, ms)` always takes an explicit duration but used to drop it —
`action: { type: "wait" }` carried nothing — so replay fell through to the `networkidle` probe
below for every recorded wait, on a different clock than the one actually recorded. The action
now carries `wait_ms`, and `executeAction` checks it before anything else: a recorded wait
replays as the same sleep, every time, and `networkidle` is reached only for a bare `wait` action
with no duration at all — a hand-authored program choosing that condition on purpose, not a
recorder ever emitting one.

The check is for **presence**, not a positive value. `wait_ms: 0` is schema-valid and
`recorder.wait(intent, 0)` is a legal call, so a recorded zero replays as an instant no-op;
reading it as "no duration given" would send it to the `networkidle` probe below, which is the
condition-swap the fix removes. Only a `wait_ms` that is absent, negative or non-finite reaches
the probe.

### Reaching the bound is not a step failure

A parameterless `wait` is a settling **hint**. The step's post-condition is the assertion that
runs immediately after it, with its own `timeout_ms` budget. So when the bound elapses the step
**proceeds** and records `settled: false` (`ActionResult.settled`, surfaced as
`StepAttemptResult.notes`) — the same posture as the 250 ms idle probe in
`src/runner/page-state.ts`, where a timeout means *no claim* rather than failure.

Classifying it as `TIMEOUT` would be worse than slow. `replay.ts` routes every non-`PASS`
outcome into the repair loop, so a never-quiet page would fail deterministically at the bound,
consume both repair attempts, and land on `REPAIR_EXHAUSTED` — and no `corrected_action` can
make a polling page go quiet. The run's `success_with_le_2_repairs` would then be reporting a
scaffolding condition as churn, which is the one thing the gate number must not do. On exactly
the surfaces this bound exists for (polling, streaming, websockets), the bound would otherwise
make a doomed step fail 6× faster without making it any less doomed.

If the page really is broken, nothing is hidden: the assertion fails on its own evidence, and
*that* failure is worth a repair attempt. And a step that genuinely needs idle as its
post-condition can say so — `network-idle` is an assertion type
(`src/runner/assertions.ts`), where a timeout is a real failure because it was a real claim.

`tests/unit/runner-bounded-wait.test.ts` pins both halves: the clock (bounded, not 30 s) and the
classification (`repair_count: 0` on a never-idle page, with the note still recorded). Reverting
either fails it.

## Parameter bindings are validated before the run, not during it

`ReplayRunner.run()` throws `UnboundParamsError` when the program declares a parameter the caller
did not bind — **before step 0, before the browser is touched, and before any metric is emitted**.

This is a measurement-integrity rule, not an ergonomics one. `fill` and `select` already fail
closed on a missing value, but the template paths had no equivalent, and three of their four
shapes report a *caller error as a site-churn failure*:

| Shape | Unbound `{hole}` |
| --- | --- |
| `http://{host}:{port}/dashboard/new` (navigate) | `new URL()` throws → `PAGE_ERROR` |
| `http://localhost:3000/d/{dash_uid}/view` (navigate) | **valid URL** — a real request to `/d/%7Bdash_uid%7D/view` |
| `press` with a templated `key` | literal `{key}` reaches `page.keyboard.press` → `PAGE_ERROR` |
| `url-matches` / `text-matches` | expected keeps the hole, actual does not → `ASSERTION_FAILED` |

`PAGE_ERROR` and `ASSERTION_FAILED` are exactly what `stepReplayValidity()` and the §9 kill line
read as evidence about churn. A forgotten binding produced those outcomes at the same place in the
run, and nothing in the metric row told them apart — so one misconfigured parameter reported a
*worse gate number* and looked like ordinary churn.

**A refused run is an absent run, not a failed one.** It emits no step rows and no run row, so it
contributes to no §9 denominator. That is why the refusal is an exception rather than a new
`StepOutcome`: there is no outcome to report, because nothing was attempted.

**Required means "will actually be interpolated".** `src/runner/params.ts` mirrors `executeAction`
and `evaluateAssertion` branch for branch: `url_template` only for `navigate`, `key` only for
`press`, `param_refs` only for `fill`/`select` (a `wait`'s binding is an optional alternative to a
recorded `wait_ms` under ADR-0008), and `regex_template` in preference to `template` /
`target.url_template`. That precision is load-bearing: the live gate bundle asserts on
`.../d/{dashboard_uid}/{dashboard_slug}?orgId=1` with a `regex_template` alongside, and those two
values are generated by the site — a caller cannot bind them. Requiring every hole would refuse
the gate's own program. The risk traded for is drift between the derivation and the evaluator, so
`tests/unit/runner-params.test.ts` pins the pairs.

`CompiledProgram.required_params` carries the names — written by `bundleToProgram`, so a caller can
ask what to bind rather than read the steps, which is what #118's resolver will need. It is
**unioned** with what the steps derive, never trusted in place of it: a stale declaration can add a
requirement, never quietly remove one. Names only; a value never enters a program.

`interpolate` still leaves an unbound hole as literal text, and that is now a decision rather than
an oversight. The only way one can still reach it is through an action a **repair proposed** — the
model may return a `corrected_action` carrying a template the run-start check never saw. Keeping
`interpolate` total means that step fails its assertion and is recorded, instead of aborting a run
and losing the steps already measured.

`gate:matrix` pre-flights the same check after loading `--program` and before booting anything, so
an unbindable program is reported in a second rather than after the first container is up. It names
what to pass. `--dry-run` honours `--param` too, which is what makes it a faithful pre-flight for
the live path.

## The repair model client (#27)

`StubRepairModelClient` proposes `null` and reports zero tokens, which makes self-heal rate
structurally 0 and `cost_repair` structurally zero — blocking two PRD §9 metrics outright.
`AnthropicRepairModelClient` is the real one. It is **opt-in**: the stub remains the default, so
`npm run ci`, dry runs, and every existing test path make no network call and spend nothing.

| Decision | Why |
| --- | --- |
| Sees only `serializeRepairContext()` output | ADR-0012. The raw `RepairContext` holds `params` — the runtime bindings, secrets included |
| Throws at construction without `ANTHROPIC_API_KEY` | A run that silently used the stub would report a self-heal rate of 0 that *looks measured* |
| **Prompt caching off** | `cache_read_input_tokens` and `cache_creation_input_tokens` bill differently from plain input. A repair cost that quietly excluded cache writes would understate against §9's 70% kill line. All four fields are summed anyway, so enabling caching later cannot silently change what the number means |
| Structured output, never prose parsing | A parser for free text is a second place for the contract to drift |
| No `temperature` / `top_p` / `top_k` | Rejected with a 400 on `claude-opus-5` |
| `stop_reason === "refusal"` checked before reading content | A decline is HTTP 200 with possibly empty content; indexing `content[0]` would throw |
| A proposal carrying an assertion is dropped **whole** | Partially honouring it would look like a repair while corrupting the measurement. `assertAssertionUnchanged` is the runtime guard; the output schema offers no assertion field at all, so the ask is never made |
| Errors return `corrected_action: null` **with the tokens consumed** | A failure path reporting zero makes repair look free against the kill line. Never retried silently — a hidden retry hides cost |

`model_id` and the chosen `effort` are recorded on every proposal: a cost figure without the
model and effort that produced it is not reproducible.

## Invariants

1. **Assertions are immutable in repair.** `deepFreeze` + `assertAssertionUnchanged` — proposals
   may only supply `corrected_action`, plus up to two `pre_actions` to run before it (ADR-0024),
   each validated by the same `sanitizeProposedAction` gate. Two independent checks run after every proposal
   (`replay.ts`): one against `ctx.assertion` (catches a client that reassigns the property it was
   handed) and one against the live `step.assertion` (catches a client that mutates the original,
   non-frozen object reachable via `ctx.step`) — a third check re-verifies `step.assertion` after
   the retry executes, closing the window where a tampered assertion could otherwise decide a
   spurious `PASS` before anyone looks at it again. `tests/unit/runner.test.ts` pins the equality
   check itself; `tests/integration/repair-invariants.test.ts` drives `ReplayRunner` end to end
   against hostile scripted clients (reassignment, in-place mutation, and the specific
   strong→weak downgrade the contract language names) and — required by #65 — proves each guard
   is load-bearing by disabling it and watching the corresponding attack go undetected (a silent
   `REPAIRED_PASS`, once even reporting `assertion_strength: "weak"`) before restoring it.
2. **No invented metrics.** Stub repair and unwired fresh baselines emit **zeros**; aggregates report `no_data` when denominators are empty.
3. **`maxRepairsPerRun` default 2 in `ReplayRunner`; the gate matrix runs uncapped (ADR-0027).**
   `gate:matrix` passes `Infinity` unless `--max-repairs-per-run` says otherwise, so a run repairs
   until the task finishes or `wall_clock_budget_ms` runs out, and a step stops early only when
   the model re-proposes a sequence that already failed there while the page is unchanged. Run rows record `repair_cap` (null =
   uncapped). The rest of this invariant holds for any finite cap: the budget is per run, not per
   step. `repairCount` is one counter for the whole `run()` call, not reset between steps — a step
   that enters repair with
   the budget already spent gets zero attempts of its own, immediately `REPAIR_EXHAUSTED`. Aligns
   with `success_with_le_2_repairs` on run metrics, which is hard-coded to a threshold of 2
   regardless of what `maxRepairsPerRun` was configured to, so raising the cap to study a harder
   case can't accidentally raise the PRD §9 bar too. Both properties are pinned by
   `tests/integration/repair-invariants.test.ts`.
4. **Repeats are independent.** `--runs` gives each run a fresh browser context and a fresh
   login. Reusing either would correlate the repeats and understate the spread — the one thing
   repeat runs exist to measure. No run is discarded, including a failed one.
5. **A skip is not a failure.** A version the matrix could not bring up produced no measurement;
   it is recorded in `out/matrix-run.json` with a stage and a reason and never reaches the
   NDJSON. Counting it as a failed run would invent a data point, dropping it would shrink the
   denominator in silence.
6. **A repair client's own failure cannot escape `run()`.** A `RepairModelClient.propose()` call
   is an external dependency (a model API) exactly like a browser action or an assertion
   evaluation, both of which are caught into a typed `StepOutcome` rather than left to throw
   (`src/runner/actions.ts`, `src/runner/assertions.ts`) — until #65, `propose()` was the one
   external call in the loop with no equivalent catch, so a client that threw aborted the entire
   `run()` promise instead of failing one step. Fixed in `replay.ts`: a thrown proposal is now
   caught and recorded as `REPAIR_EXHAUSTED` with the error message preserved, same as a `null`
   proposal. Covered by `tests/integration/repair-invariants.test.ts`.

## Repeat runs and the §9 sampling floor (#66)

`--runs <n>` (default 3) replays the program N times per version. §9 specifies 3×/day for 14 days
— **≥42 runs and ≥400 step-executions** — and swapping the calendar for the version matrix does
not change the statistics. Eight pins at one run each is 8 runs; clearing the floor needs
`--runs 6` (48). `--runs 5` gives 40 and lands two short.

The shortfall is **reported, never enforced**: `section9SampleFloor()` puts `meets_floor` and the
exact gap into `report.json`, and the CLI prints it before the first container boots. A short
sample is worth looking at; a short sample read as a gate measurement is not.

`perVersionBreakdown()` adds `runs_attempted`, `runs_succeeded`, `step_validity_per_run` and
`step_validity_spread` per version. A pooled ratio makes 3/3 and 2/3 the same number; the spread
is what shows they are different findings. Non-zero spread across repeats of an **unchanged**
version is harness flakiness rather than churn, and it has to be understood before any matrix
number is trusted.

**Measured so far:** three live repeats of 9.5.21 against one unchanged container agreed exactly
— `step_validity_per_run: [1, 1, 1]`, spread 0. That is a weak probe: the program was the 2-step
example bundle, and the 12-step gate task (#25) is where flakiness would surface.

## Live matrix (#62)

`npm run gate:matrix` now drives a real browser. The exit-2 guard is gone; `--dry-run` stays,
because it exercises the harness without Docker and the CI job depends on it.

Per version, in `experiments/gate-v1/live-run.ts`: compose up → `/api/health` readiness → seed →
**seed-fingerprint gate** → Chromium → login preamble → `ReplayRunner` with `dryRun: false` →
teardown in a `finally`. Nothing in that file retries a step, downgrades an outcome, or catches
an assertion failure — repair is the only permitted second attempt.

The fingerprint gate is why a version can be skipped for a reason that is not infrastructure: if
its seeded state differs from the base version's, a step failure could be the seed's fault rather
than the surface's, and no honest attribution is possible after the fact. That version yields no
data point instead of a misleading one.

**Dry-run rows stay labelled.** `mode` is recorded per run and dry rows carry
`dry-run — tokens remain 0; not a gate measurement`. Mixing the two in one report is the easiest
way to publish a fabricated gate number.

### The NDJSON cannot yet say *why* a step failed

`contracts/metrics.schema.json` sets `additionalProperties: false` and has no field for a failure
reason. Because `StubRepairModelClient` always proposes `null` (stub 1), every genuine failure
ends as `REPAIR_EXHAUSTED` — so `LOCATOR_NOT_FOUND`, `ASSERTION_FAILED` and `TIMEOUT` are three
findings the gate needs to tell apart, flattened into one value in the emitted row.

Widening the metric row is a contract change and is deliberately **not** made here. Instead
`StepAttemptResult.first_pass_outcome` carries the real outcome in memory, and the driver records
it in its own ledger:

```json
{"step": 1, "outcome": "REPAIR_EXHAUSTED", "first_pass": "LOCATOR_NOT_FOUND"}
```

That is a workaround, not a fix. Until the contract question is answered, the NDJSON alone cannot
distinguish failure modes, and any report built only from it will under-describe them.

## Outcomes

From `contracts/metrics.schema.json` `$defs.stepOutcome`:

`PASS` · `ASSERTION_FAILED` · `LOCATOR_NOT_FOUND` · `TIMEOUT` · `PAGE_ERROR` · `REPAIRED_PASS` · `REPAIR_EXHAUSTED`

## Gate harness

See [`experiments/gate-v1/README.md`](../../experiments/gate-v1/README.md).

```bash
npm run gate:matrix -- --dry-run
npm run gate:report
```

## Sources

| Claim | Source | Access date |
| --- | --- | --- |
| Action + locator strategies | `contracts/cache-row.schema.json` | 2026-07-24 |
| Assertion types / strength / “MUST NOT weaken” | `contracts/assertion.schema.json` | 2026-07-24 |
| Step/run metric fields + outcomes | `contracts/metrics.schema.json` | 2026-07-24 |
| Fingerprint posture (no HTML/cookies) | `contracts/trajectory.schema.json` `$defs.fingerprint` | 2026-07-24 |
| Playwright locators / actions | https://playwright.dev/docs/locators | 2026-07-24 |
| Stack choice | `docs/decisions/ADR-0001-typescript-node-playwright.md` | 2026-07-24 |

## Open questions / what I could not verify

- Exact §9 kill thresholds (numeric gate) — **not invented**; pending founder PRD drop + Track-1 measurement (`docs/prd/` still placeholder).
- ~~Model wiring for `RepairModelClient` — stub only.~~ **Built (#27)** —
  `AnthropicRepairModelClient` (`src/runner/repair-anthropic.ts`), opt-in via
  `gate:matrix --repair-model`. The stub stays the default so no run spends money or makes a
  network call unless asked. **Still unmeasured:** no live repair has been observed. The client
  is covered by 21 mocked-SDK tests; a self-heal rate remains structurally 0 until someone runs
  it with a real key, which is the exit criterion #27 names and this repo will not fabricate.

  **That opt-in did not actually work until
  [#165](https://github.com/DevToolie/Paragent/issues/165).** `--repair-model` was accepted by
  the parser, documented in `usage()`, and dropped twice over: `assignValue` had no branch for
  it, and nothing in `run-matrix.ts` read `args.repairModel` to build a client. So a run asking
  for the real model got `StubRepairModelClient` — a null proposal and zero tokens — and
  reported a self-heal rate of 0 and a `cost_repair` of zero that both look measured. The client
  refuses to degrade silently (it throws when `ANTHROPIC_API_KEY` is unset); the CLI in front of
  it degraded anyway and never reached that constructor. Both halves are wired now, and the
  construction happens before anything boots, so a missing key is a named refusal rather than a
  stub run. **Any pre-#165 artifact produced with `--repair-model` reported stub numbers** — a
  stub run has `cost_repair` all-zero on every row and no `repair_context_level`, so check the
  rows rather than the command that was typed.
- Whether `compiled_trajectory` bundle `$id` becomes a first-class contract (B3 packaging convention today).
- Fresh-reasoning cost capture for `cost_fresh` — measured separately; defaults to zeros when
  unwired. Since [#123](https://github.com/DevToolie/Paragent/issues/123) this field means the
  **per-run comparison baseline** only. The one-time cost of producing the compiled program is a
  separate optional field, `cost_program_build` (+ `program_build_id`), passed to `ReplayRunner`
  as `costProgramBuild`/`programBuildId` on the single run that paid it —
  [ADR-0010](../decisions/ADR-0010-amortization-cost-model.md). Neither has been measured yet;
  the amortized curve reports `no_data` until one is.
- ~~Live `page` injection API for matrix vs caller-owned browser lifecycle.~~ **Settled (#62)** —
  the driver owns the lifecycle: a fresh Chromium and a fresh context per version, closed in the
  same `finally` as the container. Carrying a context between versions would let one version's
  state decide another's outcome.
- **Whether a metric row should carry the pre-repair outcome.** Today it cannot
  (`additionalProperties: false`, no field), so every failure reads `REPAIR_EXHAUSTED` and the
  driver keeps the real outcome in its own ledger instead. Answering this needs an ADR, and it
  matters before any report is published from the NDJSON alone.
- **What a live run actually measures is still limited by the program.** #62 built the driver;
  the only Grafana-targeted bundle on `main` is a compile of a hand-written example, and its
  step-0 assertion (`getByRole("form")`) matches **zero** elements on real Grafana — an unnamed
  `<form>` has no ARIA role. The gate task bundle arrives with #25.
- ~~Which version list the gate matrix walks.~~ **Settled (#26)** — `scripts/testbed/matrix.json`
  (ADR-0003 pins), read through `src/testbed/matrix.ts`. The placeholder
  `experiments/gate-v1/versions.json` is deleted, so `npm run gate:matrix -- --dry-run` now
  emits one run row per pinned version instead of one row for `pending-b1@placeholder`. Still a
  dry run: outcomes are hard-coded `PASS`, every token count is 0, and the rows say so.
- Whether walking eight versions changes anything the report can *conclude*. It does not — more
  rows over the same hand-written 2-step program is a better-shaped denominator, not a
  measurement. That waits on live execution ([#62](https://github.com/DevToolie/Paragent/issues/62)).
- **`settled: false` is recorded but not aggregated.** It reaches `StepAttemptResult.notes` in
  memory and stops there: `metrics.schema.json` has no field for it, so nothing counts how often
  a wait's hint went unanswered across a matrix run. Adding one is a contract change, and there
  is no measurement yet to justify the shape. Until then a reader cannot tell "this run met a
  never-quiet page eight times" from "never".
- Whether 5000 ms is the right *bound* rather than merely a chosen one. It equals
  `DEFAULT_ASSERTION_TIMEOUT_MS` by coincidence, not by construction — two independent constants
  in two packages, nothing enforcing the match. Neither number has been fitted to an observation
  because no live run exists yet.
