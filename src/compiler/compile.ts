import {
  synthesizeAssertion,
  type SynthesizeAssertionOptions,
} from "./assertions.js";
import { buildLocatorFallbackChain } from "./locators.js";
import { decidePoolEligibility } from "./pool.js";
import { programIdFor } from "../shared/program-id.js";
import {
  COMPILER_VERSION,
  SCHEMA_VERSION,
  type CacheRow,
  type CompiledAction,
  type CompiledTrajectoryBundle,
  type Trajectory,
  type TrajectoryStep,
} from "./types.js";

function slugPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9@._-]+/g, "-").replace(/-+/g, "-");
}

function buildCompiledAction(step: TrajectoryStep): {
  action: CompiledAction;
  topologyOnly: boolean;
} {
  const { chain, topologyOnly } = buildLocatorFallbackChain(
    step.locator_candidates,
  );
  const action: CompiledAction = {
    type: step.action.type,
    locator_fallback_chain: chain,
  };
  if (step.action.param_refs !== undefined) {
    action.param_refs = step.action.param_refs;
  }
  if (step.action.url_template !== undefined) {
    action.url_template = step.action.url_template;
  }
  if (step.action.key !== undefined) {
    action.key = step.action.key;
  }
  if (step.action.custom_op !== undefined) {
    action.custom_op = step.action.custom_op;
  }
  if (step.action.wait_ms !== undefined) {
    action.wait_ms = step.action.wait_ms;
  }
  return { action, topologyOnly };
}

function landmarkHint(step: TrajectoryStep): string | undefined {
  const post = step.post_state.visible_landmarks ?? [];
  return post[0];
}

export function compileStep(
  trajectory: Trajectory,
  step: TrajectoryStep,
  compiledAt: string,
  assertionOptions: SynthesizeAssertionOptions = {},
): CacheRow {
  const { action, topologyOnly } = buildCompiledAction(step);
  const assertion = synthesizeAssertion(
    {
      trajectory,
      step,
      locatorChain: action.locator_fallback_chain,
    },
    assertionOptions,
  );
  const steps = trajectory.steps;
  const idx = step.step_index;
  const prev = steps.find((s) => s.step_index === idx - 1);
  const next = steps.find((s) => s.step_index === idx + 1);

  const flow_topology: NonNullable<CacheRow["flow_topology"]> = {};
  if (prev) flow_topology.prev_action_type = prev.action.type;
  if (next) flow_topology.next_action_type = next.action.type;
  const landmark = landmarkHint(step);
  if (landmark) flow_topology.landmark = landmark;
  // Computed before the pool decision, not after: `buildPoolRow` degrades an
  // all-tainted chain to a `topology_only` pool row *only* when the row carries
  // `flow_topology`, so the pre-check has to know whether this row will (#170).
  const hasFlowTopology = Object.keys(flow_topology).length > 0;

  const pool = decidePoolEligibility({
    chain: action.locator_fallback_chain,
    assertion,
    topologyOnly,
    hasFlowTopology,
  });

  const row: CacheRow = {
    schema_version: SCHEMA_VERSION,
    row_id: `cache-${slugPart(trajectory.site_key)}-${slugPart(trajectory.task_key)}-${idx}`,
    site_key: trajectory.site_key,
    task_key: trajectory.task_key,
    step_index: idx,
    // ADR-0013: the compiler is the only thing that knows how many steps the
    // program has, so it is the only thing that can record it. A resolver
    // reading rows back cannot derive `steps_total` from the rows it happens to
    // hold — that is precisely the question it is trying to answer.
    program: {
      program_id: programIdFor(trajectory.trajectory_id),
      steps_total: trajectory.steps.length,
      compiled_at: compiledAt,
    },
    compiled_action: action,
    assertion,
    confidence: 0,
    success_count: 0,
    failure_count: 0,
    last_verified_at: compiledAt,
    pool_eligible: pool.pool_eligible,
    pool_ineligible_reason: pool.pool_ineligible_reason,
  };

  if (hasFlowTopology) {
    row.flow_topology = flow_topology;
  }

  return row;
}

export interface CompileOptions {
  compiledAt?: string;
  inputPath?: string;
  notes?: string;
  /**
   * Override the `timeout_ms` written onto every synthesized assertion.
   * Defaults to `DEFAULT_ASSERTION_TIMEOUT_MS`. Read the note on that constant
   * before changing it — it is an assertion-strength knob, not a perf one.
   */
  assertionTimeoutMs?: number;
}

/**
 * Replace a post_state URL the very next step's pre_state contradicts on the
 * same path (#224 review, ADR-0026).
 *
 * Nothing acts between one step's post_state and the next step's pre_state,
 * so when the two share a path and differ, the first was taken mid-redirect:
 * Grafana's Save routes to `/d/{uid}/{slug}` and only then adds `?orgId=1`.
 * Kept as recorded, that transient taught ADR-0022's state-bearing rule that
 * `orgId` must be absent there, and every replay on the recording version
 * failed. The recorder now waits for the URL to stop moving; this removes the
 * class at the compiler, whatever the recorder's timing. A different path is a
 * real navigation and is left alone. Returns a copy; the input is untouched.
 */
export function settleTransientUrls(trajectory: Trajectory): Trajectory {
  const steps = [...trajectory.steps].sort((a, b) => a.step_index - b.step_index);
  const out = steps.map((s) => ({ ...s, post_state: { ...s.post_state } }));
  const path = (u: string) => u.split(/[?#]/)[0];
  for (let i = 0; i + 1 < out.length; i++) {
    const post = out[i]!.post_state.url_template;
    const nextPre = out[i + 1]!.pre_state.url_template;
    if (post && nextPre && post !== nextPre && path(post) === path(nextPre)) {
      out[i]!.post_state.url_template = nextPre;
    }
  }
  return { ...trajectory, steps: out };
}

export function compileTrajectory(
  trajectory: Trajectory,
  options: CompileOptions = {},
): CompiledTrajectoryBundle {
  if (trajectory.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported trajectory schema_version=${trajectory.schema_version}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (!trajectory.steps?.length) {
    throw new Error("Trajectory has no steps to compile");
  }

  // #224 review: see settleTransientUrls.
  trajectory = settleTransientUrls(trajectory);

  const compiledAt = options.compiledAt ?? new Date().toISOString();
  const assertionOptions: SynthesizeAssertionOptions =
    options.assertionTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.assertionTimeoutMs };
  const rows = [...trajectory.steps]
    .sort((a, b) => a.step_index - b.step_index)
    .map((step) => compileStep(trajectory, step, compiledAt, assertionOptions));

  const bundle: CompiledTrajectoryBundle = {
    schema_version: SCHEMA_VERSION,
    bundle_kind: "compiled_trajectory",
    source_trajectory_id: trajectory.trajectory_id,
    site_key: trajectory.site_key,
    task_key: trajectory.task_key,
    compiled_at: compiledAt,
    compiler: {
      version: COMPILER_VERSION,
      notes:
        options.notes ??
        "One CacheRow per step; locator_fallback_chain in B2 preference order; assertions synthesized from post_state (+ hints). pool_eligible fail-closed.",
    },
    rows,
  };
  if (options.inputPath !== undefined) {
    bundle.compiler.input_path = options.inputPath;
  }
  return bundle;
}
