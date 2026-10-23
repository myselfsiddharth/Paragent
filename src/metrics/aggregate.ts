/**
 * PRD §9 aggregate computation from measured MetricRow[] only.
 * Sources: docs/prd/PRD-trajectory-cache-v0.2.md §9; contracts/metrics.schema.json
 * access_date: 2026-07-24 — never invents values.
 */

import type {
  Cost,
  GateReportSection,
  MetricRow,
  RunMetric,
  StepMetric,
} from "./types.js";
import { addCost, totalTokens, zeroCost } from "./cost.js";

function isStep(row: MetricRow): row is StepMetric {
  return row.metric_kind === "step";
}
function isRun(row: MetricRow): row is RunMetric {
  return row.metric_kind === "run";
}

export function filterRuns(rows: readonly MetricRow[]): RunMetric[] {
  return rows.filter(isRun);
}
export function filterSteps(rows: readonly MetricRow[]): StepMetric[] {
  return rows.filter(isStep);
}

/**
 * Runs whose `cost_repair` is a real measurement (ADR-0020, #189).
 *
 * A delegated repair client hands the reasoning to the calling agent, which
 * pays for it and never reports usage back. Those rows carry
 * `repair_cost_measured: false` and zeros — and a zero that means "unmeasured"
 * is arithmetically identical to a zero that means "no inference ran". Folded
 * into `mean(cost_repair)` they drag the §9 ratio *down*, and down is the
 * direction that reads as "the thesis passed".
 *
 * Excluded here, not zero-filled and not silently dropped: an all-excluded
 * pool reports `no_data`, never `0`. Absent means measured — every emitter
 * predating the field counted real tokens.
 *
 * **Cost aggregates only.** `selfHealRate`, `taskSuccessLe2Repairs` and
 * step-validity keep these rows: whether a repair worked is observed by the
 * runner regardless of whose budget paid for it.
 */
export function filterCostMeasuredRuns(rows: readonly MetricRow[]): RunMetric[] {
  return filterRuns(rows).filter((r) => r.repair_cost_measured !== false);
}

function dedupeLatestSteps(steps: StepMetric[]): StepMetric[] {
  const map = new Map<string, StepMetric>();
  for (const s of steps) map.set(`${s.run_id}::${s.step_index}`, s);
  return [...map.values()];
}

export function stepReplayValidity(
  rows: readonly MetricRow[],
): GateReportSection {
  const steps = dedupeLatestSteps(filterSteps(rows));
  const denominator = steps.length;
  const numerator = steps.filter((s) => s.replay_valid).length;
  if (denominator === 0) {
    return {
      name: "step-level replay-validity",
      formula: "count(replay_valid=true) / count(compiled steps executed)",
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    };
  }
  return {
    name: "step-level replay-validity",
    formula: "count(replay_valid=true) / count(compiled steps executed)",
    value: numerator / denominator,
    status: "computed",
    numerator,
    denominator,
  };
}

/**
 * Per-version breakdown — the thing a pooled ratio hides.
 *
 * Every §9 aggregate above pools across the whole matrix, so a version that
 * succeeded 5/5 and one that succeeded 3/5 contribute to the same number and
 * become indistinguishable. Those are different findings: the first is a version
 * the task survives, the second is either real churn or harness flakiness, and
 * the report has to let a reader see which versions moved.
 *
 * **Spread is the flakiness signal.** Repeat runs of one version against an
 * unchanged instance should agree. If `step_validity_per_run` varies there, the
 * variation is the harness's, not the surface's — and that has to be understood
 * before any matrix number is trusted (#66).
 *
 * Counts only what the NDJSON contains, which is **attempted** runs. A version
 * that was skipped never produced a row, and inferring it here would invent a
 * denominator; the skip and its reason live in the driver's
 * `out/matrix-run.json` ledger instead.
 */
export interface VersionBreakdown {
  testbed_version: string;
  runs_attempted: number;
  runs_succeeded: number;
  /** Step-level replay-validity per run, ordered as the runs were emitted. */
  step_validity_per_run: number[];
  /** null when there are no completed runs — never 0, which would read as agreement. */
  step_validity_min: number | null;
  step_validity_max: number | null;
  /** max - min. null on no data; 0 means the repeats genuinely agreed. */
  step_validity_spread: number | null;
  status: "computed" | "no_data";
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const list = map.get(key(item));
    if (list) list.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

function summarizeVersion(
  version: string,
  versionRuns: RunMetric[],
  stepsByRun: Map<string, StepMetric[]>,
): VersionBreakdown {
  const validity = versionRuns
    .map((r) => stepsByRun.get(r.run_id) ?? [])
    // A run with no step rows has no validity to report. Scoring it 0 would be
    // indistinguishable from a run where every step genuinely failed.
    .filter((runSteps) => runSteps.length > 0)
    .map((runSteps) => runSteps.filter((s) => s.replay_valid).length / runSteps.length);

  if (validity.length === 0) {
    return {
      testbed_version: version,
      runs_attempted: versionRuns.length,
      runs_succeeded: versionRuns.filter((r) => r.task_success).length,
      step_validity_per_run: [],
      step_validity_min: null,
      step_validity_max: null,
      step_validity_spread: null,
      status: "no_data",
    };
  }

  const min = Math.min(...validity);
  const max = Math.max(...validity);
  return {
    testbed_version: version,
    runs_attempted: versionRuns.length,
    runs_succeeded: versionRuns.filter((r) => r.task_success).length,
    step_validity_per_run: validity,
    step_validity_min: min,
    step_validity_max: max,
    step_validity_spread: max - min,
    status: "computed",
  };
}

export function perVersionBreakdown(
  rows: readonly MetricRow[],
): VersionBreakdown[] {
  const stepsByRun = groupBy(dedupeLatestSteps(filterSteps(rows)), (s) => s.run_id);
  const byVersion = groupBy(filterRuns(rows), (r) => r.testbed_version);

  return [...byVersion.entries()]
    .map(([version, versionRuns]) =>
      summarizeVersion(version, versionRuns, stepsByRun),
    )
    // Stable order so two reports over the same data diff cleanly.
    .sort((a, b) => a.testbed_version.localeCompare(b.testbed_version));
}

/**
 * Whether the run count clears PRD §9's sampling floor.
 *
 * §9 specifies 3×/day for 14 days — **≥42 runs and ≥400 step-executions**. The
 * pivot swaps the calendar for the version matrix, but the statistical floor
 * survives the substitution: eight pins at one run each is 8 runs, an order of
 * magnitude short, and cannot separate churn from noise.
 *
 * Reported rather than enforced. A short sample is still worth looking at; what
 * must not happen is a short sample being read as a gate measurement, so this
 * says plainly which one you are holding.
 */
export const SECTION9_MIN_RUNS = 42;
export const SECTION9_MIN_STEP_EXECUTIONS = 400;

export function section9SampleFloor(rows: readonly MetricRow[]): {
  runs: number;
  step_executions: number;
  meets_floor: boolean;
  shortfall: string | null;
} {
  const runs = filterRuns(rows).length;
  const stepExecutions = dedupeLatestSteps(filterSteps(rows)).length;
  const meets =
    runs >= SECTION9_MIN_RUNS && stepExecutions >= SECTION9_MIN_STEP_EXECUTIONS;

  const missing: string[] = [];
  if (runs < SECTION9_MIN_RUNS) {
    missing.push(`${runs}/${SECTION9_MIN_RUNS} runs`);
  }
  if (stepExecutions < SECTION9_MIN_STEP_EXECUTIONS) {
    missing.push(`${stepExecutions}/${SECTION9_MIN_STEP_EXECUTIONS} step-executions`);
  }

  return {
    runs,
    step_executions: stepExecutions,
    meets_floor: meets,
    shortfall: missing.length > 0 ? `below PRD §9 floor: ${missing.join(", ")}` : null,
  };
}

/**
 * How much of the matrix the aggregates above do **not** cover (#84).
 *
 * Every §9 ratio here is computed over steps that produced rows, so a run cut
 * short by its wall-clock budget shrinks the denominators. That is the right
 * arithmetic — an unreached step is not evidence of anything — but a shrinking
 * denominator that nobody states is exactly how a number gets flattered. This
 * section makes the shortfall unmissable in the same report.
 *
 * Reported, never enforced: a truncated run is still a real measurement of the
 * steps it reached.
 */
export function truncationSummary(rows: readonly MetricRow[]): {
  runs: number;
  runs_truncated_by_budget: number;
  steps_unattempted: number;
  status: "computed" | "no_data";
} {
  const runs = filterRuns(rows);
  if (runs.length === 0) {
    return {
      runs: 0,
      runs_truncated_by_budget: 0,
      steps_unattempted: 0,
      status: "no_data",
    };
  }
  return {
    runs: runs.length,
    runs_truncated_by_budget: runs.filter((r) => r.budget_exhausted === true).length,
    steps_unattempted: runs.reduce(
      (sum, r) => sum + Math.max(0, r.steps_total - (r.steps_attempted ?? r.steps_total)),
      0,
    ),
    status: "computed",
  };
}

/**
 * How many steps passed only by running inserted actions (ADR-0024, #213).
 *
 * A repair may now insert up to two actions before a step's own, and a step
 * repaired that way replays with them afterwards. Both count as one repair and
 * one step in every §9 ratio, which is the decision ADR-0024 records. So the
 * ratios above depend on it, and this block says by how much: without it, a
 * gate number that rests on insertion would read the same as one that does not.
 */
export function repairShapeSummary(rows: readonly MetricRow[]): {
  steps_repaired: number;
  steps_repaired_with_pre_actions: number;
  steps_replay_valid_with_pre_actions: number;
  status: "computed" | "no_data";
} {
  const steps = filterSteps(rows);
  const repaired = steps.filter((r) => r.outcome === "REPAIRED_PASS");
  return {
    steps_repaired: repaired.length,
    steps_repaired_with_pre_actions: repaired.filter((r) => (r.pre_action_count ?? 0) > 0).length,
    steps_replay_valid_with_pre_actions: steps.filter(
      (r) => r.replay_valid && (r.pre_action_count ?? 0) > 0,
    ).length,
    status: steps.length === 0 ? "no_data" : "computed",
  };
}

export function taskSuccessLe2Repairs(
  rows: readonly MetricRow[],
): GateReportSection {
  const runs = filterRuns(rows);
  const denominator = runs.length;
  const numerator = runs.filter((r) => r.success_with_le_2_repairs).length;
  if (denominator === 0) {
    return {
      name: "task-level success (with ≤2 repairs/run)",
      formula: "count(success_with_le_2_repairs=true) / count(runs)",
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    };
  }
  return {
    name: "task-level success (with ≤2 repairs/run)",
    formula: "count(success_with_le_2_repairs=true) / count(runs)",
    value: numerator / denominator,
    status: "computed",
    numerator,
    denominator,
  };
}

/**
 * The §9 kill line: repair cost against a fresh run of the same task.
 *
 * Consumes `cost_fresh`, which is a **per-run** baseline and legitimately
 * appears on every row — this is a mean-of-ratios question, so a denominator is
 * needed on each run. That is the opposite of what `amortizedTokensOverN`
 * needs, which is why the two now read different fields (#123, ADR-0010).
 */
export function repairCostVsFresh(rows: readonly MetricRow[]): {
  tokens: GateReportSection;
  wall_clock: GateReportSection;
} {
  // Unmeasured-repair rows are excluded, not zero-filled (ADR-0020, #189).
  // Wall-clock goes with tokens: a delegated repair's elapsed time is the
  // host's whole turn — its own tool loop, its queueing, possibly a human — so
  // it is not the same quantity as an API call's latency either.
  const runs = filterCostMeasuredRuns(rows);
  const empty = (name: string, formula: string): GateReportSection => ({
    name,
    formula,
    value: null,
    status: "no_data",
    numerator: 0,
    denominator: 0,
  });
  if (runs.length === 0) {
    return {
      tokens: empty(
        "repair cost vs fresh (tokens)",
        "mean(cost_repair.tokens) / mean(cost_fresh.tokens)",
      ),
      wall_clock: empty(
        "repair cost vs fresh (wall-clock)",
        "mean(cost_repair.wall_clock_ms) / mean(cost_fresh.wall_clock_ms)",
      ),
    };
  }
  const meanFreshTokens =
    runs.reduce((s, r) => s + totalTokens(r.cost_fresh), 0) / runs.length;
  const meanRepairTokens =
    runs.reduce((s, r) => s + totalTokens(r.cost_repair), 0) / runs.length;
  const meanFreshMs =
    runs.reduce((s, r) => s + r.cost_fresh.wall_clock_ms, 0) / runs.length;
  const meanRepairMs =
    runs.reduce((s, r) => s + r.cost_repair.wall_clock_ms, 0) / runs.length;
  return {
    tokens: {
      name: "repair cost vs fresh (tokens)",
      formula: "mean(cost_repair.tokens) / mean(cost_fresh.tokens)",
      value: meanFreshTokens > 0 ? meanRepairTokens / meanFreshTokens : null,
      status: meanFreshTokens > 0 ? "computed" : "no_data",
      numerator: meanRepairTokens,
      denominator: meanFreshTokens,
    },
    wall_clock: {
      name: "repair cost vs fresh (wall-clock)",
      formula:
        "mean(cost_repair.wall_clock_ms) / mean(cost_fresh.wall_clock_ms)",
      value: meanFreshMs > 0 ? meanRepairMs / meanFreshMs : null,
      status: meanFreshMs > 0 ? "computed" : "no_data",
      numerator: meanRepairMs,
      denominator: meanFreshMs,
    },
  };
}

/**
 * Of the runs that failed a step on first pass, how many recovered.
 *
 * The denominator counts against **attempted** steps, not `steps_total` (#84).
 * A run truncated by its wall-clock budget never reached its later steps, and
 * counting those as first-pass failures would put a run with nothing to heal
 * into the denominator and score it as a self-heal failure — a value invented
 * out of a step that was never executed. `steps_attempted` is absent on rows
 * written before #84, where it equals `steps_total` by construction.
 */
export function selfHealRate(rows: readonly MetricRow[]): GateReportSection {
  const failingFirstPass = filterRuns(rows).filter((r) => {
    const attempted = r.steps_attempted ?? r.steps_total;
    return attempted > 0 && r.steps_replay_valid < attempted;
  });
  const denominator = failingFirstPass.length;
  const numerator = failingFirstPass.filter((r) => r.self_healed).length;
  if (denominator === 0) {
    return {
      name: "self-heal success rate",
      formula:
        "count(self_healed=true) / count(runs with steps_replay_valid < steps_total)",
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    };
  }
  return {
    name: "self-heal success rate",
    formula:
      "count(self_healed=true) / count(runs with steps_replay_valid < steps_total)",
    value: numerator / denominator,
    status: "computed",
    numerator,
    denominator,
  };
}

export function meanTimeToRepair(
  rows: readonly MetricRow[],
): GateReportSection {
  const withRepair = filterRuns(rows).filter(
    (r) => (r.time_to_repair_total_ms ?? 0) > 0,
  );
  const denominator = withRepair.length;
  if (denominator === 0) {
    return {
      name: "time-to-repair (mean ms)",
      formula: "mean(time_to_repair_total_ms) over runs with repairs",
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    };
  }
  const sum = withRepair.reduce(
    (s, r) => s + (r.time_to_repair_total_ms ?? 0),
    0,
  );
  return {
    name: "time-to-repair (mean ms)",
    formula: "mean(time_to_repair_total_ms) over runs with repairs",
    value: sum / denominator,
    status: "computed",
    numerator: sum,
    denominator,
  };
}

/**
 * One run's position on the amortization curve.
 *
 * `program_build_paid` marks the runs that carried a one-time payment — the
 * points where the curve steps *up*. A reader has to be able to see those: a
 * task recompiled after churn has paid full price twice, and a plot that shows
 * only the decline overstates the result (#123).
 */
export interface AmortizationPoint {
  n: number;
  amortized_tokens: number;
  program_build_paid: boolean;
}

/**
 * Published in the report, so it states exactly what is summed. `cost_fresh` is
 * deliberately **not** a term: it is a per-run comparison baseline (the
 * denominator of `repairCostVsFresh`), and summing it over N would grow the
 * numerator linearly with N and flatten the curve PRD §12 calls the demo.
 */
const AMORTIZED_FORMULA =
  "(sum(cost_program_build where present + cost_repair + cost_replay) over first N runs) / N " +
  "— no_data unless some run in the window carries a measured cost_program_build, " +
  "and no_data if any run in the window has repair_cost_measured=false";

/**
 * The §12 curve: what one task costs per run once its one-time cost is spread
 * over N runs.
 *
 * **The numerator sums `cost_program_build`, not `cost_fresh` (#123).** The two
 * were one field, read as a one-time capital cost by this function and as a
 * per-run operating cost by `repairCostVsFresh`. Both readings are legitimate;
 * they are different quantities, and the disagreement was invisible only
 * because the field was always zeros. ADR-0010 splits them.
 *
 * **No payment measured → `no_data`, not a curve.** Replay costs no tokens, so
 * without a build cost the numerator is ~0 and the "curve" is a flat line at
 * zero — which would publish the strongest possible version of the claim on the
 * strength of a field nobody ever filled in. An unmeasured first point is
 * absent, never assumed (CONTRIBUTING rule 3).
 *
 * **A recompile stays in the same series.** A second payment appears as a step
 * up at the run that made it, rather than resetting N. Resetting would show two
 * clean declines and hide that full price was paid twice — see ADR-0010 for the
 * decision and what it costs.
 */
export function amortizedTokensOverN(
  rows: readonly MetricRow[],
  n?: number,
): {
  points: AmortizationPoint[];
  /**
   * `program_build_id` of every row that carried a payment, in run order.
   * Duplicates are **kept**: a repeated id means one build was paid for twice,
   * which is an emitter bug, and de-duplicating here would hide it behind a
   * prettier curve. Compare against `new Set(...).size`.
   */
  builds_paid: string[];
  section: GateReportSection;
} {
  // Ordering first, exclusion second: the window is "the first N runs", and
  // dropping rows before sorting would silently slide a later run into the
  // window. An unmeasured run inside the window makes the whole series
  // no_data (ADR-0020, #189) rather than a curve missing a term — the
  // numerator is a *sum*, so one missing repair cost understates every point
  // after it, and a curve that declines for the wrong reason is exactly the
  // failure mode #123 was filed about.
  const runs = [...filterRuns(rows)].sort((a, b) =>
    a.recorded_at.localeCompare(b.recorded_at),
  );
  const limit = n === undefined ? runs.length : Math.min(n, runs.length);
  const noData = (): {
    points: AmortizationPoint[];
    builds_paid: string[];
    section: GateReportSection;
  } => ({
    // Deliberately no points: an empty series renders as "no_data" in the SVG,
    // where a zero-valued series would render as a flat line labelled as the demo.
    points: [],
    builds_paid: [],
    section: {
      name: "amortized tokens/task over N runs",
      formula: AMORTIZED_FORMULA,
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    },
  });
  if (limit === 0) return noData();
  if (runs.slice(0, limit).some((r) => r.repair_cost_measured === false)) {
    return noData();
  }

  const points: AmortizationPoint[] = [];
  const buildsPaid: string[] = [];
  let cumulative = 0;
  for (let i = 0; i < limit; i++) {
    const r = runs[i]!;
    const paid = r.cost_program_build !== undefined;
    if (paid) {
      cumulative += totalTokens(r.cost_program_build!);
      // Schema `dependentRequired` guarantees the id when the cost is present;
      // the fallback names the violation rather than dropping the payment.
      buildsPaid.push(r.program_build_id ?? `<unattributed:${r.run_id}>`);
    }
    cumulative += totalTokens(r.cost_repair) + totalTokens(r.cost_replay);
    points.push({
      n: i + 1,
      amortized_tokens: cumulative / (i + 1),
      program_build_paid: paid,
    });
  }
  if (buildsPaid.length === 0) return noData();

  const last = points[points.length - 1]!;
  return {
    points,
    builds_paid: buildsPaid,
    section: {
      name: "amortized tokens/task over N runs",
      formula: AMORTIZED_FORMULA,
      value: last.amortized_tokens,
      status: "computed",
      numerator: cumulative,
      denominator: limit,
    },
  };
}

/**
 * One point on the hit-rate trend (#67).
 *
 * Shaped like `AmortizationPoint` on purpose — the report plots the two curves
 * together, and §9 pairs them: amortized cost shows the *effect*, hit-rate shows
 * the *mechanism*. If tokens fell for an unrelated reason (a cheaper model, a
 * shorter task) hit-rate would stay flat and expose it.
 */
export interface CacheHitRatePoint {
  /**
   * Index over **cache-consulting runs**, not over all runs.
   *
   * A run that never consulted the cache contributes no denominator, so
   * including it would flat-line the curve for a reason that has nothing to do
   * with the cache. `run_id` is carried so a reader can join back to the
   * amortized series rather than assume the two share an x-axis.
   */
  n: number;
  run_id: string;
  /** Cumulative through this point — the trend §9 asks for. */
  hit_rate: number;
  /** Cumulative denominator, so a reader can see how thin an early point is. */
  cache_steps: number;
}

/** Published in the report so the number states exactly what it counts. */
const CACHE_HIT_RATE_FORMULA =
  "count(program_source=cache AND replay_valid=true) / count(program_source=cache)";

/**
 * Cache hit-rate on anchor tasks over time (PRD §9 secondary metric).
 *
 * ## What counts as a hit
 *
 * Defined in [ADR-0014](../../docs/decisions/ADR-0014-cache-read-path.md), and
 * it is a **conjunction of two independently stored facts**:
 *
 * ```
 * cache hit  ≡  program_source == "cache"  AND  replay_valid
 * ```
 *
 * Replay is deterministic and uses no model — the model only appears in repair
 * — so a hit cannot mean "skipped a model call during replay". It means *this
 * run did not need fresh reasoning to obtain a program*. That is provenance;
 * whether the program then worked is `replay_valid`, which already exists and
 * is deliberately **not** redefined here. #67 is explicit that hit-rate must not
 * be squeezed into an existing field.
 *
 * **A repaired step is a miss**, even though it passed: it cost model tokens,
 * which is the thing this metric exists to track. `REPAIRED_PASS` therefore
 * lands in the denominator and not the numerator, via `replay_valid === false`.
 *
 * ## Why the denominator excludes file-loaded steps
 *
 * A step whose program came from `--program <bundle>` has no cache provenance at
 * all, and `program_source` is simply absent on it. Counting those as misses
 * would make hit-rate a function of **how the operator invoked the runner**
 * rather than of the cache: a matrix run against a file bundle would report 0%,
 * which reads as "the cache is failing" when the truth is "the cache was never
 * asked". So they are excluded entirely and an all-file run reports `no_data`.
 *
 * No target and no threshold. §9 gives a direction ("up") and no number, and
 * inventing one here would be exactly the category-B failure
 * `docs/INTEGRITY-AUDIT.md` exists for.
 */
export function cacheHitRate(rows: readonly MetricRow[]): {
  points: CacheHitRatePoint[];
  section: GateReportSection;
} {
  const noData = (): { points: CacheHitRatePoint[]; section: GateReportSection } => ({
    // Deliberately no points: an empty series renders as "no_data", where a
    // zero-valued series would render as a flat line labelled as a measurement.
    points: [],
    section: {
      name: "cache hit-rate over N runs",
      formula: CACHE_HIT_RATE_FORMULA,
      value: null,
      status: "no_data",
      numerator: 0,
      denominator: 0,
    },
  });

  // Only steps that actually carry provenance. Absent means the run never
  // consulted a cache — not "file", and not a miss.
  const steps = dedupeLatestSteps(filterSteps(rows)).filter(
    (s) => s.program_source === "cache",
  );
  if (steps.length === 0) return noData();

  // Grouped by run and ordered by the run's earliest step, rather than by a
  // joined run row: a step row is the thing being counted, and a series that
  // silently dropped runs whose run row was missing would understate the trend
  // without saying so.
  const byRun = new Map<string, StepMetric[]>();
  for (const step of steps) {
    const bucket = byRun.get(step.run_id);
    if (bucket) bucket.push(step);
    else byRun.set(step.run_id, [step]);
  }
  const runIds = [...byRun.keys()].sort((a, b) => {
    const first = (id: string) =>
      byRun.get(id)!.reduce((min, s) => (s.recorded_at < min ? s.recorded_at : min), "\uffff");
    const fa = first(a);
    const fb = first(b);
    return fa === fb ? a.localeCompare(b) : fa.localeCompare(fb);
  });

  const points: CacheHitRatePoint[] = [];
  let hits = 0;
  let total = 0;
  for (const [i, runId] of runIds.entries()) {
    for (const step of byRun.get(runId)!) {
      total += 1;
      if (step.replay_valid) hits += 1;
    }
    points.push({
      n: i + 1,
      run_id: runId,
      hit_rate: hits / total,
      cache_steps: total,
    });
  }

  return {
    points,
    section: {
      name: "cache hit-rate over N runs",
      formula: CACHE_HIT_RATE_FORMULA,
      value: hits / total,
      status: "computed",
      numerator: hits,
      denominator: total,
    },
  };
}

/**
 * Bucket totals across runs.
 *
 * `fresh` is a sum of per-run baselines and is **not** an amortization
 * numerator — see `amortizedTokensOverN`. `program_build` sums only the rows
 * that carried a payment, which is the quantity that is amortized.
 */
export function sumRunCosts(runs: readonly RunMetric[]): {
  fresh: Cost;
  program_build: Cost;
  replay: Cost;
  repair: Cost;
} {
  return runs.reduce(
    (acc, r) => ({
      fresh: addCost(acc.fresh, r.cost_fresh),
      program_build: r.cost_program_build
        ? addCost(acc.program_build, r.cost_program_build)
        : acc.program_build,
      replay: addCost(acc.replay, r.cost_replay),
      repair: addCost(acc.repair, r.cost_repair),
    }),
    {
      fresh: zeroCost(),
      program_build: zeroCost(),
      replay: zeroCost(),
      repair: zeroCost(),
    },
  );
}

/**
 * How much of the run pool the §9 cost metrics could actually be computed over
 * (ADR-0020, #189).
 *
 * Published beside the sample floor and the truncation summary, for the same
 * reason both of those are: a `no_data` or a suspiciously low ratio has to be
 * explainable from the report itself. Without this line, excluding delegated
 * rows would be invisible — the honest thing and the silently-dropped thing
 * look identical in the output.
 */
export function repairCostProvenance(rows: readonly MetricRow[]): {
  runs_total: number;
  runs_cost_measured: number;
  runs_cost_unmeasured: number;
} {
  const total = filterRuns(rows).length;
  const measured = filterCostMeasuredRuns(rows).length;
  return {
    runs_total: total,
    runs_cost_measured: measured,
    runs_cost_unmeasured: total - measured,
  };
}

export function buildGateReport(rows: readonly MetricRow[]): {
  prd_section: "§9";
  generated_at: string;
  row_counts: { step: number; run: number };
  sample: ReturnType<typeof section9SampleFloor>;
  truncation: ReturnType<typeof truncationSummary>;
  /**
   * Which run rows the cost metrics were computed over. `runs_cost_unmeasured`
   * counts delegated-repair rows excluded by ADR-0020 — not failures, just runs
   * whose repair cost nobody could observe.
   */
  cost_provenance: ReturnType<typeof repairCostProvenance>;
  /** How many steps rest on inserted actions (ADR-0024). */
  repair_shape: ReturnType<typeof repairShapeSummary>;
  metrics: GateReportSection[];
  per_version: VersionBreakdown[];
  amortized_points: AmortizationPoint[];
  /**
   * Hit-rate trend (#67). Indexed over cache-consulting runs, so it does **not**
   * share an x-axis with `amortized_points` — each point carries its `run_id`
   * for joining. Empty when nothing consulted a cache.
   */
  cache_hit_rate_points: CacheHitRatePoint[];
  /**
   * How many one-time payments the window contains, and for which builds.
   * `payments > distinct_builds` means one build id was paid for twice — kept
   * visible rather than corrected at aggregation time (#123).
   */
  amortization: {
    payments: number;
    distinct_builds: number;
    builds_paid: string[];
  };
} {
  const repairVs = repairCostVsFresh(rows);
  const amortized = amortizedTokensOverN(rows);
  const hitRate = cacheHitRate(rows);
  return {
    prd_section: "§9",
    generated_at: new Date().toISOString(),
    row_counts: {
      step: filterSteps(rows).length,
      run: filterRuns(rows).length,
    },
    // Stated before the metrics, deliberately: a reader has to know whether the
    // sample can carry them before reading the numbers.
    sample: section9SampleFloor(rows),
    // Beside the sample floor, for the same reason: both say what the numbers
    // below them are and are not computed over.
    truncation: truncationSummary(rows),
    // Third of the three "what these numbers are computed over" blocks.
    cost_provenance: repairCostProvenance(rows),
    // Fourth: the §9 ratios count an inserted action as part of one repair
    // and one step (ADR-0024), so how many steps needed one is stated here.
    repair_shape: repairShapeSummary(rows),
    metrics: [
      stepReplayValidity(rows),
      taskSuccessLe2Repairs(rows),
      repairVs.tokens,
      repairVs.wall_clock,
      selfHealRate(rows),
      meanTimeToRepair(rows),
      amortized.section,
      // Beside the amortized curve on purpose: §9 pairs them, because
      // amortized cost shows the effect and hit-rate shows the mechanism.
      hitRate.section,
    ],
    per_version: perVersionBreakdown(rows),
    amortized_points: amortized.points,
    cache_hit_rate_points: hitRate.points,
    amortization: {
      payments: amortized.builds_paid.length,
      distinct_builds: new Set(amortized.builds_paid).size,
      builds_paid: amortized.builds_paid,
    },
  };
}
