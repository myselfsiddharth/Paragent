/**
 * Runner types aligned with:
 * - contracts/cache-row.schema.json
 * - contracts/assertion.schema.json
 * - contracts/metrics.schema.json
 * access_date: 2026-07-24
 */

import type { Cost, StepMode, StepOutcome } from "../metrics/types.js";
import type { ContextElement, ContextLevel } from "../shared/page-context.js";

export type LocatorStrategy =
  | "role_name"
  | "label"
  | "testid"
  | "structural"
  | "text"
  | "placeholder"
  | "css_vocab"
  | "topology_only";

export type ActionType =
  | "navigate"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "uncheck"
  | "press"
  | "hover"
  | "wait"
  | "upload"
  | "custom";

export type AssertionType =
  | "element-visible"
  | "text-matches"
  | "url-matches"
  | "count-equals"
  | "network-idle"
  | "custom";

export type AssertionStrength = "strong" | "weak";

export type FailureClassification =
  | "assertion_failed"
  | "locator_not_found"
  | "timeout"
  | "page_error"
  | "network_error"
  | "unknown";

export type ParamType =
  | "string"
  | "email"
  | "url"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "secret_ref"
  | "json";

/** Runtime bindings for template holes — values are never persisted in contracts. */
export type ParamBindings = Record<string, string | number | boolean>;

export interface LocatorSpec {
  strategy: LocatorStrategy;
  role?: string;
  name?: string;
  label?: string;
  testid?: string;
  structural_path?: string;
  text?: string;
  css?: string;
  tenant_scoped?: boolean;
}

export interface CompiledAction {
  type: ActionType;
  param_refs?: string[];
  url_template?: string;
  key?: string;
  custom_op?: string;
  /** For wait actions: the recorded duration in milliseconds (ADR-0008). */
  wait_ms?: number;
  locator_fallback_chain: LocatorSpec[];
}

export interface AssertionTarget {
  locator?: LocatorSpec;
  url_template?: string;
  count_scope?: string;
  /** ADR-0022: "the element this step's action resolved" — instead of a copied locator. */
  locator_ref?: "action_target";
}

export interface AssertionExpected {
  template?: string;
  param_types?: Record<string, ParamType>;
  regex_template?: string;
  count?: number;
  visible?: boolean;
  custom_predicate_id?: string;
}

export interface Assertion {
  schema_version: "1.0.0";
  assertion_id: string;
  type: AssertionType;
  strength: AssertionStrength;
  target?: AssertionTarget;
  expected?: AssertionExpected;
  timeout_ms: number;
  failure_classification: FailureClassification;
  notes?: string;
}

export interface CompiledStep {
  step_index: number;
  row_id?: string;
  /**
   * Actions run, in order, before `compiled_action` (ADR-0024, #213). Only a
   * repair writes them: churn that **adds** an action, such as Grafana 10's
   * data-source modal before "Change Visualization". The step's assertion is
   * checked once, after `compiled_action`, so a step is still one step, with
   * one post-condition, however many actions it takes. At most
   * `MAX_PRE_ACTIONS`. Absent or empty means none.
   */
  pre_actions?: CompiledAction[];
  compiled_action: CompiledAction;
  assertion: Assertion;
}

export interface CompiledProgram {
  schema_version: "1.0.0";
  program_id: string;
  site_key: string;
  task_key: string;
  testbed_version: string;
  steps: CompiledStep[];
  /**
   * Param names the program needs bound before it can run (#122).
   *
   * A property of the program, so a caller can ask what to bind instead of
   * reading its steps — which matters once a program arrives from a cache
   * resolver with no human who knows the answer (#118). Written by
   * `bundleToProgram`; **names only, never values**.
   *
   * Optional because a hand-written `CompiledProgram` fixture may omit it, and
   * because `CompiledProgram` has no JSON Schema — this is a TS interface, not
   * a contract change. `requiredParams()` unions it with what the steps
   * actually need, so a stale declaration can add a requirement but never
   * remove one.
   */
  required_params?: string[];
}

/**
 * Privacy-safe page snapshot for repair context.
 * Never includes cookies, storage, or raw HTML.
 * Source posture: contracts/trajectory.schema.json fingerprint (no HTML).
 */
export interface PageStateSnapshot {
  url: string;
  title: string;
  visible_landmarks: string[];
  network_idle: boolean;
  captured_at: string;
  /**
   * Which context budget produced this snapshot (ADR-0012, #125).
   *
   * Recorded on the snapshot, not just in config, because a self-heal rate is
   * not reproducible without knowing what the model could see. Two runs with
   * the same `model_id` and different levels are not comparable.
   */
  context_level?: ContextLevel;
  /**
   * Interactive elements the repair may target: role + accessible name only.
   * Empty at the `landmarks` level. Never carries an input's value — see
   * `src/shared/page-context.ts`.
   */
  elements?: ContextElement[];
}

export interface RepairContext {
  run_id: string;
  step: CompiledStep;
  /** Frozen copy — repair MUST NOT mutate. */
  assertion: Assertion;
  failed_outcome: StepOutcome;
  page_state: PageStateSnapshot;
  attempt: number;
  error_message?: string;
  params: ParamBindings;
  /**
   * What the whole task is for, in developer-authored prose (ADR-0025, #225):
   * the same goal the fresh baseline is given, so both sides of the §9 ratio
   * know what the task is. Lets a repair *choose* (which data source, which
   * audience), not only find. Never page content and never a param value —
   * `ReplayRunner.run` refuses a goal that contains one.
   */
  task_goal?: string;
}

export interface RepairProposal {
  /** Corrected action only — assertion changes are forbidden. */
  corrected_action: CompiledAction | null;
  /**
   * Actions to run before `corrected_action`, when the page now needs an extra
   * one first (ADR-0024). Run as one attempt, checked once by the frozen
   * assertion after `corrected_action`. Ignored when `corrected_action` is null.
   */
  pre_actions?: CompiledAction[];
  tokens_in: number;
  tokens_out: number;
  /**
   * `false` when this client cannot observe what the repair cost (ADR-0020,
   * #189) — a delegated repair, where the host paid and does not report usage.
   *
   * Absent means measured. Every client that runs inference reports a real
   * `usage` block, and `StubRepairModelClient`'s zeros are a true statement
   * (no model ran) rather than a placeholder. The flag exists because those two
   * zeros are indistinguishable in a `Cost`, and folding an unmeasured one into
   * `mean(cost_repair)` would deflate the §9 ratio toward a false pass.
   */
  cost_measured?: boolean;
  model_id?: string;
  notes?: string;
}

export interface StepAttemptResult {
  step_index: number;
  outcome: StepOutcome;
  replay_valid: boolean;
  mode: StepMode;
  cost: Cost;
  repair_attempt?: number;
  time_to_repair_ms?: number;
  assertion_strength?: AssertionStrength;
  error_message?: string;
  /**
   * The outcome of the **first** attempt, when `outcome` was later overwritten
   * with `REPAIR_EXHAUSTED`.
   *
   * Every genuine failure exhausts repair today, because `StubRepairModelClient`
   * always proposes `null` (`architecture.md` stub 1). So the emitted metric row
   * reads `REPAIR_EXHAUSTED` whether the locator was never found, the assertion
   * was false, or the page timed out — three findings the gate needs to tell
   * apart, flattened into one.
   *
   * `contracts/metrics.schema.json` has `additionalProperties: false` and no
   * field for this, so widening the NDJSON would be a contract change (ADR, per
   * CONTRIBUTING). This field is runner-internal and **not emitted**: it lets a
   * caller such as the gate matrix driver record the real outcome in its own
   * ledger while the contract question is settled separately.
   */
  first_pass_outcome?: StepOutcome;
  /**
   * How many pre-actions this attempt ran before `compiled_action` (ADR-0024).
   * Present only when at least one did; emitted as `pre_action_count`, so a
   * gate number that depends on inserted actions says so.
   */
  pre_action_count?: number;
  /**
   * Something worth recording about a step that did **not** fail — today only
   * "the `networkidle` hint never fired, we proceeded anyway". Deliberately not
   * `error_message`: this is not an error, and a step carrying it can be `PASS`.
   *
   * In-memory only. Adding it to `metrics.schema.json` is a contract change,
   * and nothing aggregates it yet — see docs/gate/runner.md.
   */
  notes?: string;
}

/**
 * What a caller may observe after each step settles (issue #64).
 *
 * Declared structurally so the runner keeps no dependency on `src/cache/` — the
 * cache is written *to*, and a runner -> cache import would be backwards. The
 * cache supplies an implementation via `createCacheUpdateSink()`.
 *
 * Purely an observer. Nothing the sink does or returns can change an outcome,
 * skip a step, or alter a metric row: confidence is recorded during Track 1,
 * never acted on, or a low-confidence row would quietly shrink the
 * step-validity denominator. See docs/gate/cache.md.
 */
export interface StepOutcomeObservation {
  site_key: string;
  task_key: string;
  step_index: number;
  outcome: StepOutcome;
  /** Set only when the outcome was REPAIRED_PASS. */
  repair?: {
    run_id: string;
    repair_attempt: number;
    corrected_action: CompiledAction;
    /**
     * The step's full pre-action list after the repair (ADR-0024): the
     * recorded ones that ran before the failure, then the repair's own. Empty
     * clears them, which is how a repair removes an action churn took away.
     */
    pre_actions: CompiledAction[];
  };
}

export interface RunResult {
  run_id: string;
  site_key: string;
  task_key: string;
  testbed_version: string;
  task_success: boolean;
  repair_count: number;
  success_with_le_2_repairs: boolean;
  steps_total: number;
  /** Steps that produced a metric row. `< steps_total` means the run stopped early. */
  steps_attempted: number;
  steps_replay_valid: number;
  self_healed: boolean;
  time_to_repair_total_ms: number;
  step_results: StepAttemptResult[];
  wall_clock_total_ms: number;
  /** The per-run ceiling in force. `<= 0` means the guard was disabled (#84). */
  wall_clock_budget_ms: number;
  /** True when the run stopped because the budget was spent, not because it finished. */
  budget_exhausted: boolean;
  /** Per-run comparison baseline (§9 ratio denominator). Never amortized. */
  cost_fresh: Cost;
  /** One-time build payment, present only on the run that paid it (ADR-0010). */
  cost_program_build?: Cost;
  /** Which compiled build this run replayed. Required alongside the payment. */
  program_build_id?: string;
  cost_replay: Cost;
  cost_repair: Cost;
  /**
   * `false` when any repair in this run came from a client that cannot observe
   * its own cost (ADR-0020, #189). Absent means measured.
   */
  repair_cost_measured?: boolean;
}
