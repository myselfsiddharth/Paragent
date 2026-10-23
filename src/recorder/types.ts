/**
 * Trajectory types — mirror contracts/trajectory.schema.json exactly.
 * Do not add fields here without an ADR + schema change.
 */

export const TRAJECTORY_SCHEMA_VERSION = "1.0.0" as const;

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
  | "css_vocab";

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

export interface Provenance {
  recorder: string;
  agent_model: string;
  testbed_version: string;
  notes?: string;
}

export interface LocatorCandidate {
  strategy: LocatorStrategy;
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

export interface Fingerprint {
  url_template: string;
  title_template: string;
  dom_digest: string;
  visible_landmarks?: string[];
  network_idle?: boolean;
}

export interface Action {
  type: ActionType;
  param_refs?: string[];
  key?: string;
  url_template?: string;
  custom_op?: string;
  /** For wait actions: the recorded duration in milliseconds (ADR-0008). */
  wait_ms?: number;
}

export interface TimingMs {
  started_offset_ms: number;
  duration_ms: number;
}

export interface AssertionHint {
  suggested_type?: string;
  observed_signals?: string[];
}

export interface Step {
  step_index: number;
  intent: string;
  action: Action;
  locator_candidates: LocatorCandidate[];
  pre_state: Fingerprint;
  post_state: Fingerprint;
  timing_ms: TimingMs;
  assertion_hint?: AssertionHint;
  /** ADR-0007. Absent when the step acted through no locator. */
  post_action_target_visible?: boolean;
  /**
   * ADR-0026. How many controls (role + accessible name) were visible after
   * the action that were not before it. A count only: the names are never
   * persisted. Absent when the capture failed, never guessed as 0.
   */
  controls_appeared?: number;
}

export interface Trajectory {
  schema_version: typeof TRAJECTORY_SCHEMA_VERSION;
  trajectory_id: string;
  site_key: string;
  task_key: string;
  recorded_at: string;
  base_url_template: string;
  provenance: Provenance;
  parameters: Record<string, ParamType>;
  steps: Step[];
}

export interface RecordSessionOptions {
  trajectory_id: string;
  site_key: string;
  task_key: string;
  base_url_template: string;
  provenance: Provenance;
  parameters?: Record<string, ParamType>;
  bindings?: Record<string, string | number | boolean>;
}
