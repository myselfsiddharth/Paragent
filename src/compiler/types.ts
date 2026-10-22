/**
 * Compiler-facing types aligned with contracts/*.schema.json.
 * Do not invent fields outside those schemas for emitted CacheRow / Assertion.
 */

import type { ProgramRef } from "../shared/program-id.js";

export type { ProgramRef };

export const COMPILER_VERSION = "0.1.0-b3" as const;
export const SCHEMA_VERSION = "1.0.0" as const;

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

export type LocatorStrategy =
  | "role_name"
  | "label"
  | "testid"
  | "structural"
  | "text"
  | "placeholder"
  | "css_vocab"
  | "topology_only";

/** B2 preference order for fallback chains (trajectory.schema.json). */
export const LOCATOR_PREFERENCE: readonly Exclude<
  LocatorStrategy,
  "topology_only"
>[] = [
  "role_name",
  "label",
  "testid",
  "structural",
  "text",
  "placeholder",
  "css_vocab",
] as const;

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

export type PoolIneligibleReason =
  | "tenant_locator_text"
  | "tainted_attribute"
  | "non_vocab_role"
  | "literal_in_assertion"
  | "topology_only_degraded"
  | "manual_hold"
  | "other";

export interface LocatorCandidate {
  strategy: Exclude<LocatorStrategy, "topology_only">;
  rank: number;
  role?: string;
  name?: string;
  label?: string;
  testid?: string;
  structural_path?: string;
  text?: string;
  css?: string;
  tenant_scoped?: boolean;
}

export interface CompiledLocator {
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

export interface Fingerprint {
  url_template: string;
  title_template: string;
  dom_digest: string;
  visible_landmarks?: string[];
  network_idle?: boolean;
}

export interface TrajectoryAction {
  type: ActionType;
  param_refs?: string[];
  key?: string;
  url_template?: string;
  custom_op?: string;
  /** For wait actions: the recorded duration in milliseconds (ADR-0008). */
  wait_ms?: number;
}

export interface AssertionHint {
  suggested_type?: string;
  observed_signals?: string[];
}

export interface TrajectoryStep {
  step_index: number;
  intent: string;
  action: TrajectoryAction;
  locator_candidates: LocatorCandidate[];
  pre_state: Fingerprint;
  post_state: Fingerprint;
  timing_ms: {
    started_offset_ms: number;
    duration_ms: number;
  };
  assertion_hint?: AssertionHint;
  /** ADR-0007. Absent when the step acted through no locator. */
  post_action_target_visible?: boolean;
}

export interface Trajectory {
  schema_version: typeof SCHEMA_VERSION;
  trajectory_id: string;
  site_key: string;
  task_key: string;
  recorded_at: string;
  base_url_template: string;
  provenance: {
    recorder: string;
    agent_model: string;
    testbed_version: string;
    notes?: string;
  };
  parameters: Record<string, ParamType>;
  steps: TrajectoryStep[];
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
  schema_version: typeof SCHEMA_VERSION;
  assertion_id: string;
  type: AssertionType;
  strength: AssertionStrength;
  target?: {
    locator?: CompiledLocator;
    url_template?: string;
    count_scope?: string;
    /** ADR-0022: "the element this step's action resolved" — instead of a copied locator. */
    locator_ref?: "action_target";
  };
  expected?: AssertionExpected;
  timeout_ms: number;
  failure_classification: FailureClassification;
  notes?: string;
}

export interface CompiledAction {
  type: ActionType;
  param_refs?: string[];
  url_template?: string;
  key?: string;
  custom_op?: string;
  /** For wait actions: the recorded duration in milliseconds (ADR-0008). */
  wait_ms?: number;
  locator_fallback_chain: CompiledLocator[];
}

export interface CacheRow {
  schema_version: typeof SCHEMA_VERSION;
  row_id: string;
  site_key: string;
  task_key: string;
  step_index: number;
  /**
   * Which program this row is a step of (ADR-0013, #120). The compiler is the
   * only thing that knows `steps_total`, so it is the only thing that can
   * record it — a resolver reading rows back cannot derive the program's length
   * from the rows it happens to hold, which is the question it is asking.
   */
  program?: ProgramRef;
  compiled_action: CompiledAction;
  assertion: Assertion;
  confidence: number;
  success_count: number;
  failure_count: number;
  last_verified_at: string;
  pool_eligible: boolean;
  pool_ineligible_reason?: PoolIneligibleReason | null;
  flow_topology?: {
    prev_action_type?: string;
    next_action_type?: string;
    landmark?: string;
  };
}

/**
 * Bundle shape (not a contract schema yet): one CacheRow per trajectory step.
 * Each `rows[]` entry MUST validate against contracts/cache-row.schema.json.
 */
export interface CompiledTrajectoryBundle {
  schema_version: typeof SCHEMA_VERSION;
  bundle_kind: "compiled_trajectory";
  source_trajectory_id: string;
  site_key: string;
  task_key: string;
  compiled_at: string;
  compiler: {
    version: typeof COMPILER_VERSION;
    input_path?: string;
    notes: string;
  };
  rows: CacheRow[];
}
