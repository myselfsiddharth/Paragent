/**
 * Cache-row types aligned with contracts/cache-row.schema.json.
 * Authoritative pool eligibility is decided at write time (B5), never by callers.
 */

import type { ProgramRef } from "../shared/program-id.js";

export type { ProgramRef };

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

export type LocatorStrategy =
  | "role_name"
  | "label"
  | "testid"
  | "structural"
  | "text"
  | "placeholder"
  | "css_vocab"
  | "topology_only";

export type PoolIneligibleReason =
  | "tenant_locator_text"
  | "tainted_attribute"
  | "non_vocab_role"
  | "literal_in_assertion"
  | "topology_only_degraded"
  | "manual_hold"
  | "other";

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

export interface FlowTopology {
  prev_action_type?: string;
  next_action_type?: string;
  landmark?: string;
}

/** Assertion shape — B5 only inspects for pool safety; full schema is B3's. */
export interface AssertionLike {
  schema_version?: string;
  assertion_id?: string;
  type?: string;
  strength?: string;
  target?: {
    locator?: CompiledLocator;
    url_template?: string;
    count_scope?: string;
    /** ADR-0022: "the element this step's action resolved" — instead of a copied locator. */
    locator_ref?: "action_target";
  };
  expected?: {
    template?: string;
    param_types?: Record<string, string>;
    regex_template?: string;
    count?: number;
    visible?: boolean;
    custom_predicate_id?: string;
  };
  timeout_ms?: number;
  failure_classification?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface CacheRow {
  schema_version: "1.0.0";
  row_id: string;
  site_key: string;
  task_key: string;
  step_index: number;
  /**
   * Which program this row is a step of (ADR-0013). Optional because rows
   * written before #120 do not carry it — and a resolver treats their absence
   * as a MISS with a reason, never as "probably complete".
   */
  program?: ProgramRef;
  /**
   * Actions run, in order, before `compiled_action` (ADR-0024). Written only
   * by a repair rewrite, classified for the pool exactly like
   * `compiled_action` is. Absent means none.
   */
  pre_actions?: CompiledAction[];
  compiled_action: CompiledAction;
  assertion: AssertionLike;
  confidence: number;
  success_count: number;
  failure_count: number;
  last_verified_at: string;
  pool_eligible: boolean;
  pool_ineligible_reason?: PoolIneligibleReason | null;
  flow_topology?: FlowTopology;
  /**
   * When confidence first fell below the invalidation threshold, or null when
   * the row is not invalidated (ADR-0009). Stored rather than derived so later
   * tuning of the threshold cannot retroactively relabel history.
   */
  invalidated_at?: string | null;
  /** Set only on a row produced by a repair rewrite (ADR-0009). */
  repair_provenance?: RepairProvenance;
}

export interface RepairProvenance {
  repaired_at: string;
  run_id: string;
  repair_attempt: number;
  /** Action type of the version this one replaced. */
  replaced_action_type?: string;
  /** Pre-actions the repair left on the step (ADR-0024). Absent means none. */
  pre_action_count?: number;
}

/** Input to write path — pool_eligible is ignored; B5 recomputes. */
export type CacheRowCandidate = Omit<
  CacheRow,
  "pool_eligible" | "pool_ineligible_reason"
> & {
  pool_eligible?: boolean;
  pool_ineligible_reason?: PoolIneligibleReason | null;
};

export type TaintReason =
  | "free_text"
  | "non_vocab_attr"
  | "aria_or_name_tenant"
  | "role_text_tenant"
  | "non_vocab_role"
  | "non_vocab_testid"
  | "structural_free_text"
  | "caller_marked_tenant";

export interface LocatorTaintResult {
  tainted: boolean;
  reasons: TaintReason[];
  /** Which named taint rule(s) fired (for mutation tests). */
  rulesFired: string[];
}
