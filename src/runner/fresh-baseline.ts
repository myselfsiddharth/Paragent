/**
 * The fresh-reasoning baseline client (issue #39) — the §9 kill-line's
 * denominator: what it costs a model to do the gate task **from scratch**,
 * with no compiled trajectory, no cached locators, and no step list.
 *
 * ## What "fresh" means
 *
 * See [`docs/gate/fresh-baseline.md`](../../docs/gate/fresh-baseline.md) for the
 * full definition — write it there before reading a number off this code. In
 * one line: a model is handed the task's stated goal and the live page, and
 * must drive the browser to the same outcome the compiled program encodes,
 * having never seen that program's steps, locators, or assertions.
 *
 * ## Symmetry with the repair client
 *
 * §9 compares `cost_repair` against `cost_fresh` at a 70% kill line, so the two
 * measurements must be produced the same way or the ratio is meaningless. This
 * module is deliberately shaped like `src/runner/repair.ts`:
 *
 * - `FreshBaselineClient` is the same kind of seam `RepairModelClient` is — an
 *   interface the runner depends on, injected in tests, real only when a caller
 *   opts in.
 * - `StubFreshBaselineClient` mirrors `StubRepairModelClient`: it reports
 *   `task_success: false` and zero tokens, so a run that never wired a real
 *   client cannot be mistaken for a measurement.
 * - The real implementation, `AnthropicFreshBaselineClient`
 *   (`fresh-baseline-anthropic.ts`), reuses `billedInputTokens` from
 *   `repair-anthropic.ts` verbatim rather than re-deriving it — the accounting
 *   convention has to be identical, not merely similar.
 */

import type { Page } from "playwright";

/**
 * What the client is told. Deliberately thin: `task_goal` is prose describing
 * the outcome (see `DEFAULT_TASK_GOAL` in `fresh-baseline-anthropic.ts`), never
 * the compiled program's steps, locators, or assertions — handing those over
 * would defeat the measurement's whole point (ADR-0006's task is API-reachable
 * in one call; a fresh agent must not be told the call). `page` is the live
 * browser surface the client drives itself, exactly as a human tester would.
 */
export interface FreshBaselineContext {
  task_goal: string;
  /**
   * Optional so a caller without a live browser (`--dry-run`, or the stub's own
   * tests) never has to fabricate one. `StubFreshBaselineClient` never touches
   * it; `AnthropicFreshBaselineClient` refuses with a measured-zero result
   * (never a crash) when it is absent — the same posture `ReplayRunner` takes
   * on a missing `page` (`src/runner/replay.ts`).
   */
  page?: Page;
  /** Bound so a client can log/report it; never interpolated into a locator. */
  base_url: string;
}

/**
 * What one fresh attempt cost and whether it succeeded.
 *
 * Shaped like `RepairProposal` on purpose — `tokens_in`/`tokens_out`/`model_id`
 * are read the same way at the call site. `turns` and `notes` exist only for
 * the fresh-baseline runner's own ledger (see `FreshBaselineRunner`); neither
 * reaches `contracts/metrics.schema.json`, which has no field for either.
 */
export interface FreshBaselineAttempt {
  /** Whether the model's own last turn reported the task done and successful. */
  task_success: boolean;
  tokens_in: number;
  tokens_out: number;
  model_id?: string;
  /** Number of model turns the attempt took, including the final one. */
  turns: number;
  /**
   * Human-readable explanation — how the attempt ended, or why it could not be
   * measured. Never emitted onto a `RunMetric` row (the schema has no field for
   * it); the caller's own ledger carries it instead, the same posture
   * `run-matrix.ts`'s `ledgerRow()` already takes for `first_pass_outcome`.
   */
  notes?: string;
  /**
   * Set when the attempt was cut short by the network, not by the model —
   * no HTTP response came back for a turn. Its token count is a truncation,
   * so a baseline summary treats it as unmeasured rather than averaging a
   * partial cost into `mean(cost_fresh)`.
   */
  aborted?: "transport";
}

export interface FreshBaselineClient {
  attempt(context: FreshBaselineContext): Promise<FreshBaselineAttempt>;
}

/**
 * Stub until a caller opts into a real model. Mirrors `StubRepairModelClient`:
 * reports failure and zero tokens rather than a no-op success, so a run built
 * on the stub cannot be misread as a measurement.
 */
export class StubFreshBaselineClient implements FreshBaselineClient {
  async attempt(_context: FreshBaselineContext): Promise<FreshBaselineAttempt> {
    return {
      task_success: false,
      tokens_in: 0,
      tokens_out: 0,
      turns: 0,
      notes: "StubFreshBaselineClient — no model wired; not a measurement",
    };
  }
}
