/**
 * FreshBaselineRunner — one measured fresh-reasoning attempt (issue #39).
 *
 * Mirrors `ReplayRunner`'s posture at the scale of one run: measure wall clock
 * around the client call, never invent a token count, emit through the same
 * `MetricsEmitter`.
 *
 * ## Why this does not emit into the gate matrix's own NDJSON
 *
 * A `RunMetric` row has fields — `steps_total`, `repair_count`,
 * `success_with_le_2_repairs`, `cost_replay`, `cost_repair` — that describe a
 * *compiled-program replay*. A fresh attempt has none of those; it is not a
 * replay of anything. This runner still emits a schema-valid `RunMetric` row
 * (every required field present, every zero an honest zero — no compiled
 * steps ran, no repair happened), because the caller was told to use the same
 * `MetricsEmitter` and the schema has no other row shape available. But that
 * row must **never** be appended to the same NDJSON `gate:matrix` writes:
 * `repairCostVsFresh()` and `taskSuccessLe2Repairs()` in `src/metrics/aggregate.ts`
 * pool every run row in the file they are given, unconditionally. A
 * fresh-baseline row mixed into that pool would count as a zero-repair,
 * zero-step "run" and silently dilute the real matrix's success rate and
 * repair-cost mean.
 *
 * The entry point (`experiments/gate-v1/fresh-baseline.ts`) writes these rows
 * to their own file (`out/fresh-baseline/metrics.ndjson`) for exactly this
 * reason. What actually attaches a measured baseline to the matrix's own run
 * rows is `costFresh` on `ReplayRunnerOptions` — a separate, existing
 * mechanism (`src/runner/replay.ts`) that this runner's caller feeds from the
 * *aggregate* of these attempts, never from the rows themselves. See
 * `docs/gate/fresh-baseline.md`.
 */

import { randomUUID } from "node:crypto";
import { METRICS_SCHEMA_VERSION, type Cost, type RunMetric } from "../metrics/types.js";
import { measureWallClock, zeroCost } from "../metrics/cost.js";
import { MetricsEmitter } from "../metrics/emitter.js";
import {
  StubFreshBaselineClient,
  type FreshBaselineClient,
  type FreshBaselineContext,
} from "./fresh-baseline.js";
import type { Page } from "playwright";

export interface FreshBaselineRunnerOptions {
  client?: FreshBaselineClient;
  metrics?: MetricsEmitter;
}

export interface FreshBaselineRunContext {
  site_key: string;
  task_key: string;
  /** Must match the compiled program's own base recording version (#39 step 2) — same task, same instance. */
  testbed_version: string;
  task_goal: string;
  base_url: string;
  /** Absent for a dry run — see `FreshBaselineContext.page`. */
  page?: Page;
}

export interface FreshBaselineRunResult {
  run_id: string;
  task_success: boolean;
  cost_fresh: Cost;
  turns: number;
  /** Never emitted onto the metric row (no field for it); carried for the caller's own ledger. */
  notes: string;
  /** Carried from the client: the attempt was cut short by the network. */
  aborted?: "transport";
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Never let a negative or non-finite number reach an emitted `Cost` —
 * `contracts/metrics.schema.json` requires `integer, minimum 0` on every token
 * field. Clamping a malformed client response is not estimation (CONTRIBUTING
 * rule 3 forbids inventing a metric); it is refusing to let garbage from a
 * broken client masquerade as a measurement. `0` is what "unusable" becomes.
 */
function sanitizeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export class FreshBaselineRunner {
  private readonly client: FreshBaselineClient;
  private readonly metrics: MetricsEmitter;

  constructor(options: FreshBaselineRunnerOptions = {}) {
    this.client = options.client ?? new StubFreshBaselineClient();
    this.metrics = options.metrics ?? new MetricsEmitter();
  }

  getMetricsEmitter(): MetricsEmitter {
    return this.metrics;
  }

  /**
   * Run one fresh attempt and emit its `RunMetric` row.
   *
   * A client is expected to catch its own failures and report zero tokens for
   * the part it could not measure (`AnthropicFreshBaselineClient` does this on
   * every path — see its module note). This method adds one more layer for the
   * case a client's contract is broken and `attempt()` throws anyway: the
   * result is zeros with an explicit note, never a partially-filled `Cost`
   * built from whatever happened to be in scope when the throw occurred.
   */
  async run(
    context: FreshBaselineRunContext,
    runId: string = randomUUID(),
  ): Promise<FreshBaselineRunResult> {
    const ctx: FreshBaselineContext = {
      task_goal: context.task_goal,
      base_url: context.base_url,
      ...(context.page !== undefined ? { page: context.page } : {}),
    };

    let result: FreshBaselineRunResult;
    try {
      const { result: attempt, wall_clock_ms } = await measureWallClock(() =>
        this.client.attempt(ctx),
      );
      const cost: Cost = {
        tokens_in: sanitizeCount(attempt.tokens_in),
        tokens_out: sanitizeCount(attempt.tokens_out),
        wall_clock_ms: sanitizeCount(wall_clock_ms),
        ...(attempt.model_id !== undefined ? { model_id: attempt.model_id } : {}),
      };
      result = {
        run_id: runId,
        task_success: attempt.task_success,
        cost_fresh: cost,
        turns: sanitizeCount(attempt.turns),
        notes: attempt.notes ?? "",
        ...(attempt.aborted ? { aborted: attempt.aborted } : {}),
      };
    } catch (err) {
      // Cannot be measured at all — zeros, per #39's explicit constraint, and
      // the reason goes in `notes` for the caller's ledger. Never a guess built
      // from partial state.
      result = {
        run_id: runId,
        task_success: false,
        cost_fresh: zeroCost(),
        turns: 0,
        notes: `fresh-baseline attempt threw before it could be measured: ${errText(err)}`,
      };
    }

    this.emit(context, result);
    return result;
  }

  private emit(context: FreshBaselineRunContext, result: FreshBaselineRunResult): void {
    const row: RunMetric = {
      schema_version: METRICS_SCHEMA_VERSION,
      metric_kind: "run",
      run_id: result.run_id,
      site_key: context.site_key,
      task_key: context.task_key,
      testbed_version: context.testbed_version,
      task_success: result.task_success,
      // A fresh attempt has no repair loop — it IS the fresh reasoning, not a
      // recovery from a compiled step's failure.
      repair_count: 0,
      success_with_le_2_repairs: result.task_success,
      // No compiled steps ran. Zero here is a true statement — "not applicable
      // to a fresh attempt" — never a placeholder standing in for an unmeasured
      // value. See the module note on why this row must stay out of the
      // matrix's own NDJSON regardless.
      steps_total: 0,
      steps_replay_valid: 0,
      self_healed: false,
      cost_fresh: result.cost_fresh,
      cost_replay: zeroCost(),
      cost_repair: zeroCost(),
      wall_clock_total_ms: result.cost_fresh.wall_clock_ms,
      recorded_at: nowIso(),
    };
    this.metrics.emit(row);
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 300);
}
