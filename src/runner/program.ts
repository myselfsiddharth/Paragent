/**
 * `compiled_trajectory` bundle → `CompiledProgram`.
 *
 * This adapter used to live inside `tests/integration/pipeline.test.ts`, whose
 * comment said it was local "on purpose: the runtime never needs it today".
 * Issue #62 is the day that stopped being true — the live matrix driver replays
 * a committed bundle from `artifacts/compiled/`, so something in `src/` has to
 * turn one into the shape `ReplayRunner` accepts. Keeping a second copy in the
 * experiment directory would mean the tested adapter and the one the gate
 * actually runs could drift.
 *
 * **This is a mapping, not a schema change.** No field is invented on either
 * contract: `CacheRow` already carries `step_index`, `row_id`, `compiled_action`
 * and `assertion`, which is exactly `CompiledStep`. The bundle's own fields
 * (`confidence`, `pool_eligible`, `last_verified_at`, …) are cache bookkeeping
 * the runner has no use for and are deliberately dropped rather than smuggled
 * through.
 *
 * The one value that is **synthesized** is `program_id`, because no contract
 * defines one. `prog-<source_trajectory_id>` is a naming convention, not a
 * contract, and it is the same convention the integration test has used since
 * #52. `docs/gate/runner.md` tracks whether bundle `$id` should become a
 * first-class contract; until that is answered, this stays a convention with a
 * name that says where it came from.
 */

import type { CompiledTrajectoryBundle } from "../compiler/types.js";
import { PROGRAM_ID_PREFIX, programIdFor } from "../shared/program-id.js";
import { requiredParams } from "./params.js";
import type {
  Assertion,
  CompiledAction,
  CompiledProgram,
  CompiledStep,
} from "./types.js";

/**
 * Prefix for the synthesized `program_id`.
 *
 * Re-exported rather than declared: since #120 the **compiler** writes this
 * same identity onto every cache row, so a program resolved from the cache and
 * the same program adapted from its bundle must agree on it. Two copies of a
 * string that must match is the #74 failure mode, so there is one carrier —
 * `src/shared/program-id.ts` — and `tests/unit/program-id.test.ts` asserts it.
 */
export { PROGRAM_ID_PREFIX };

/**
 * Adapt a compiled bundle for replay at `testbedVersion`.
 *
 * `testbed_version` is the caller's, not the bundle's: the bundle records the
 * version it was *compiled from*, while a matrix run replays that same program
 * against every pinned version in turn. Overriding it here is what makes one
 * bundle measurable across the matrix — and why `site_key` and `task_key` are
 * **not** overridden. Relabelling those per version would make a row claim a
 * run that never happened.
 *
 * Steps are sorted by `step_index` rather than trusted in array order; the
 * bundle is JSON that may have been through other tools.
 */
export function bundleToProgram(
  bundle: CompiledTrajectoryBundle,
  testbedVersion: string,
): CompiledProgram {
  const steps: CompiledStep[] = [...bundle.rows]
    .sort((a, b) => a.step_index - b.step_index)
    .map((row) => {
      const step: CompiledStep = {
        step_index: row.step_index,
        row_id: row.row_id,
        compiled_action: row.compiled_action as CompiledAction,
        assertion: row.assertion as Assertion,
      };
      // The compiler never writes pre-actions (only a repair does, ADR-0024),
      // but a bundle exported from a repaired cache may carry them.
      const pre = (row as { pre_actions?: unknown }).pre_actions;
      if (Array.isArray(pre) && pre.length > 0) step.pre_actions = pre as CompiledAction[];
      return step;
    });

  const program: CompiledProgram = {
    schema_version: "1.0.0",
    program_id: programIdFor(bundle.source_trajectory_id),
    site_key: bundle.site_key,
    task_key: bundle.task_key,
    testbed_version: testbedVersion,
    steps,
  };
  // Derived here rather than at replay time: what a program needs bound is a
  // property of the program, and a caller has to be able to ask before it pays
  // for a container boot (#122). Names only — a value never enters a program.
  program.required_params = requiredParams(program);
  return program;
}

/**
 * What `rowsToProgram` needs from a resolved program (ADR-0013, #120).
 *
 * Declared structurally rather than imported from `src/cache/`, for the reason
 * `src/cache/update.ts` gives in the other direction: the cache is written *to*
 * by the runner, and a package dependency either way would make the two
 * inseparable. A `ResolvedProgram` satisfies this shape without either module
 * importing the other.
 */
export interface ResolvedProgramLike {
  program_id: string;
  site_key: string;
  task_key: string;
  rows: ReadonlyArray<{
    step_index: number;
    row_id?: string;
    pre_actions?: unknown;
    compiled_action: unknown;
    assertion: unknown;
  }>;
}

/**
 * Adapt rows resolved from the cache into a replayable program.
 *
 * The sibling of `bundleToProgram`, for the other source. It is deliberately a
 * *pure adapter* and does no resolving of its own: whether these rows are a
 * whole program was already decided by `resolveProgram()`, which fails closed,
 * and re-deciding it here would put the completeness rule in two places.
 *
 * `required_params` is **derived here rather than stored on the rows** —
 * ADR-0013's one deviation from what #120 sketched. The names a program needs
 * bound are a function of its steps, so storing them would create a second
 * source of truth that a recompile could leave stale; deriving them means the
 * declaration cannot disagree with the steps it describes. The caller gets the
 * same thing #120 asked for — the answer before a browser opens — because this
 * runs before anything is launched.
 */
export function rowsToProgram(
  resolved: ResolvedProgramLike,
  testbedVersion: string,
): CompiledProgram {
  const steps: CompiledStep[] = [...resolved.rows]
    .sort((a, b) => a.step_index - b.step_index)
    .map((row) => {
      const step: CompiledStep = {
        step_index: row.step_index,
        compiled_action: row.compiled_action as CompiledAction,
        assertion: row.assertion as Assertion,
      };
      if (row.row_id !== undefined) step.row_id = row.row_id;
      // ADR-0024: a repaired row's pre-actions are part of the step. Dropping
      // them here would undo the repair on every cache-read replay.
      if (Array.isArray(row.pre_actions) && row.pre_actions.length > 0) {
        step.pre_actions = row.pre_actions as CompiledAction[];
      }
      return step;
    });

  const program: CompiledProgram = {
    schema_version: "1.0.0",
    program_id: resolved.program_id,
    site_key: resolved.site_key,
    task_key: resolved.task_key,
    testbed_version: testbedVersion,
    steps,
  };
  program.required_params = requiredParams(program);
  return program;
}

/**
 * True when a parsed JSON document is a compiled bundle rather than an
 * already-shaped `CompiledProgram`.
 *
 * Both files live under version control and either may be handed to
 * `--program`, so the driver has to tell them apart. `bundle_kind` is the
 * discriminator the compiler writes; falling back to "has rows, has no steps"
 * would accept a malformed file, so it does not.
 */
export function isCompiledBundle(doc: unknown): doc is CompiledTrajectoryBundle {
  if (doc === null || typeof doc !== "object") return false;
  const kind = (doc as { bundle_kind?: unknown }).bundle_kind;
  return kind === "compiled_trajectory" && Array.isArray((doc as { rows?: unknown }).rows);
}
