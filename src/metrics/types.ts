/**
 * Types aligned with contracts/metrics.schema.json (schema_version 1.0.0).
 * Source: contracts/metrics.schema.json — access_date: 2026-07-24
 */

export const METRICS_SCHEMA_VERSION = "1.0.0" as const;

export type StepOutcome =
  | "PASS"
  | "ASSERTION_FAILED"
  | "LOCATOR_NOT_FOUND"
  | "TIMEOUT"
  | "PAGE_ERROR"
  | "REPAIRED_PASS"
  | "REPAIR_EXHAUSTED"
  /**
   * The step failed and the run's wall-clock budget ended its recovery (#84,
   * ADR-0011). Distinct from `TIMEOUT` (the page did not respond in time — a
   * property of the site) and from `REPAIR_EXHAUSTED` (repair was attempted and
   * ran out of attempts). Here repair attempts remained and time did not.
   */
  | "BUDGET_EXHAUSTED";

export type StepMode = "fresh" | "replay" | "repair";
export type AssertionStrength = "strong" | "weak";

export interface Cost {
  tokens_in: number;
  tokens_out: number;
  wall_clock_ms: number;
  model_id?: string;
}

/**
 * Where the program a run executed came from (ADR-0014, #118).
 *
 * **Provenance, not outcome.** A cache hit is `program_source === "cache"` AND
 * `replay_valid` — two independent facts that #67 combines. They are kept apart
 * here on purpose: `replay_valid` already means "the assertion passed on the
 * first attempt", and overloading it to also mean "came from cache" would make
 * one field answer two questions and neither answerable alone.
 *
 * Absent means the field predates #118 or was never set — never "file". A run
 * that never consulted a cache contributes to no hit-rate denominator, because
 * `no_data` and `0%` are different claims.
 */
export type ProgramSource = "cache" | "file";

export interface StepMetric {
  schema_version: typeof METRICS_SCHEMA_VERSION;
  metric_kind: "step";
  run_id: string;
  site_key: string;
  task_key: string;
  step_index: number;
  testbed_version: string;
  outcome: StepOutcome;
  replay_valid: boolean;
  /**
   * Where this step's compiled action came from (ADR-0014). Denormalized onto
   * the step row — as `site_key` and `task_key` already are — so hit-rate can
   * be aggregated from step rows alone without joining to the run row.
   */
  program_source?: ProgramSource;
  mode: StepMode;
  cost: Cost;
  repair_attempt?: number;
  time_to_repair_ms?: number;
  assertion_strength?: AssertionStrength;
  /**
   * Pre-actions the step ran before its own action (ADR-0024, #213). Present
   * only when at least one ran, so §9 can separate steps that passed by
   * inserting an action from steps that did not.
   */
  pre_action_count?: number;
  recorded_at: string;
}

export interface RunMetric {
  schema_version: typeof METRICS_SCHEMA_VERSION;
  metric_kind: "run";
  run_id: string;
  site_key: string;
  task_key: string;
  testbed_version: string;
  task_success: boolean;
  repair_count: number;
  success_with_le_2_repairs: boolean;
  steps_total: number;
  /**
   * Steps that produced a step row. Absent on rows written before #84; when
   * present and below `steps_total`, the run stopped early and the §9
   * denominators cover only what it reached.
   */
  steps_attempted?: number;
  steps_replay_valid: number;
  self_healed: boolean;
  time_to_repair_total_ms?: number;
  /**
   * Per-run comparison baseline: what a fresh run of this task costs *now*.
   *
   * The denominator of `repairCostVsFresh`, which is a per-run ratio and needs a
   * value on every row. **Never summed into the amortization numerator** — see
   * `cost_program_build` and ADR-0010. Zeros mean "not measured".
   */
  cost_fresh: Cost;
  /**
   * One-time capital cost: producing the compiled program this run replays.
   *
   * Present only on the run that consumed a given build's payment; **absent**
   * means never measured, and amortization reports `no_data` rather than
   * assuming a first point. Requires `program_build_id` when present.
   */
  cost_program_build?: Cost;
  /** Which compiled build this run replays. A recompile is a new id (ADR-0010). */
  program_build_id?: string;
  cost_replay: Cost;
  cost_repair: Cost;
  /**
   * `false` when this run's repair path could not report what it spent
   * (ADR-0020, #189): a delegated client, where the host agent paid for the
   * inference and no `usage` block ever reaches Paragent.
   *
   * Absent means measured — every existing emitter runs inference it can count,
   * and a stub's zeros are honest zeros. Rows marked `false` are **excluded**
   * from the §9 cost aggregates rather than folded in, because zeros in
   * `mean(cost_repair)` move the kill-line ratio toward a false pass. Outcome
   * aggregates (self-heal rate, task success) still count them: whether the
   * repair worked is measured regardless of who paid.
   */
  repair_cost_measured?: boolean;
  wall_clock_total_ms: number;
  /** Per-run ceiling in force for this run. `<= 0` means the guard was off (#84). */
  wall_clock_budget_ms?: number;
  /** True when the run stopped on its budget rather than finishing (#84). */
  budget_exhausted?: boolean;
  amortized_cost_tokens?: number;
  /**
   * Context budget the repair model was given (ADR-0012, #125). Absent when no
   * repair was attempted. A self-heal rate without this is not reproducible.
   */
  repair_context_level?: "landmarks" | "interactive" | "tree";
  /**
   * Where this run's program came from (ADR-0014, #118). Absent on runs that
   * predate the field — never assumed to be `file`.
   */
  program_source?: ProgramSource;
  /**
   * True when the resolved program had at least one invalidated row (ADR-0009).
   * Recorded so a reader can segment hit-rate by cache health; **advisory** —
   * it never suppressed a step, because confidence does not gate the
   * measurement. Only meaningful when `program_source === "cache"`.
   */
  cache_program_invalidated?: boolean;
  recorded_at: string;
}

export type MetricRow = StepMetric | RunMetric;

export interface GateReportSection {
  name: string;
  formula: string;
  value: number | null;
  status: "computed" | "no_data";
  numerator?: number;
  denominator?: number;
}
