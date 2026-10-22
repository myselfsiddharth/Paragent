/**
 * The cache-update path the runner drives (issue #64).
 *
 * `ReplayRunner` reports each step's outcome; this turns that into the next
 * version of the corresponding cache row and writes it **through
 * `writeCacheRow()`**, so a rewritten row passes the same fail-closed privacy
 * checks a first write does. A repaired action can carry a locator the original
 * never had, which makes a rewrite exactly as capable of leaking tenant
 * material as an initial write.
 *
 * ## Direction of dependency
 *
 * The runner does not import this file. It takes an optional
 * `onStepOutcome` callback whose shape is declared structurally in
 * `src/runner/types.ts`, and the cache supplies an implementation. Runner →
 * cache would be backwards: the cache is written *to*.
 *
 * It is also **opt-in**. A `ReplayRunner` with no sink behaves exactly as it did
 * before #64, which is what keeps the gate matrix unaffected: no gate run starts
 * consulting or mutating a cache because this landed.
 */

import { applyOutcome, classifyOutcome, type OutcomeContext } from "./confidence.js";
import type { CacheStore } from "./store.js";
import type { CacheRow } from "./types.js";
import {
  CacheWriteRejectedError,
  writeCacheRow,
  type WriteOptions,
} from "./write.js";

/**
 * What the runner hands over per step. Deliberately a plain shape rather than
 * an import of the runner's own types — see the module note on direction.
 */
export interface StepOutcomeReport {
  site_key: string;
  task_key: string;
  step_index: number;
  outcome: string;
  /** Set when the outcome was REPAIRED_PASS. */
  repair?: {
    run_id: string;
    repair_attempt: number;
    corrected_action: CacheRow["compiled_action"];
    /** The step's pre-actions after the repair (ADR-0024). Empty clears them. */
    pre_actions?: CacheRow["compiled_action"][];
  };
}

export interface CacheUpdateOptions extends WriteOptions {
  store: CacheStore;
  /** Injected so tests are deterministic. */
  now?: () => string;
}

export interface CacheUpdateResult {
  /** The row that was written, or undefined when there was nothing to update. */
  row?: CacheRow;
  /** Why no write happened, when none did. */
  skipped?: "no-such-row" | "unhandled-outcome";
}

/**
 * Why a written row came back with an empty fallback chain (#114).
 *
 * Read off `pool_ineligible_reason` rather than assumed. Tainted locators are
 * the obvious cause, but they are not the only one: `buildPoolRow` drops the
 * chain entirely when the assertion carries a tenant literal, without ever
 * classifying a locator — so a repair proposing perfectly clean locators
 * against a step whose (frozen, unchanged-by-repair) assertion is tainted hits
 * this same refusal. The machine-readable `reason` on the error was already
 * right in that case; only the human-readable text claimed something false.
 */
function emptyChainCause(row: CacheRow): string {
  switch (row.pool_ineligible_reason) {
    case "literal_in_assertion":
      return (
        "the step's assertion carries a tenant literal, so the row was written " +
        "with no locators at all — the corrected locators were never reached"
      );
    case "tenant_locator_text":
    case "tainted_attribute":
    case "non_vocab_role":
      // ADR-0024: "an action" because it may be one of the repair's
      // pre-actions; any of them losing every locator refuses the whole row.
      return "every locator of a repaired action was tenant-tainted";
    default:
      return (
        "the corrected action was written with no usable locator " +
        `(${row.pool_ineligible_reason ?? "reason not recorded"})`
      );
  }
}

/**
 * Record one step outcome against the cache.
 *
 * Returns rather than throws when the row is absent: a program can be replayed
 * against a cache that was never populated for it, and that is not an error —
 * it is the normal state during Track 1, where the compiler writes rows and the
 * gate matrix replays a bundle without a cache behind it.
 */
export function recordStepOutcome(
  report: StepOutcomeReport,
  options: CacheUpdateOptions,
): CacheUpdateResult {
  const kind = classifyOutcome(report.outcome);
  if (kind === null) return { skipped: "unhandled-outcome" };

  const existing = options.store.get({
    site_key: report.site_key,
    task_key: report.task_key,
    step_index: report.step_index,
  });
  if (!existing) return { skipped: "no-such-row" };

  const ctx: OutcomeContext = {
    now: (options.now ?? (() => new Date().toISOString()))(),
  };
  if (kind === "repaired" && report.repair) ctx.repair = report.repair;

  const candidate = applyOutcome(existing, kind, ctx);

  // Through the gatekeeper, never around it. A repaired action's locators are
  // taint-checked exactly like a first write's. The store is deliberately left
  // off this call so the classified row can be inspected *before* it is
  // persisted — the store is append-only, so a bad line has no "later" in which
  // to be corrected.
  const { store, ...writeOptions } = options;
  const row = writeCacheRow(candidate, writeOptions);

  // A repair whose locators were all stripped comes back with an empty fallback
  // chain: correctly classified, and useless. Persisting it would record a
  // "repair" that can never resolve anything and would overwrite a version that
  // at least described a real control. Refuse instead, and leave the previous
  // version standing — the step's failure is already in the metrics, which is
  // where a failure belongs.
  if (
    kind === "repaired" &&
    (ctx.repair?.corrected_action.locator_fallback_chain.length ?? 0) > 0 &&
    row.compiled_action.locator_fallback_chain.length === 0
  ) {
    throw new CacheWriteRejectedError(
      `repair rewrite refused: ${emptyChainCause(row)}, leaving an action that ` +
        "cannot resolve. Previous version retained.",
      row.pool_ineligible_reason ?? "pool_leak_refused",
    );
  }

  store.write(row);
  return { row };
}

/**
 * Adapter for `ReplayRunnerOptions.onStepOutcome`.
 *
 * Errors are deliberately **not** swallowed. A refused write means a repaired
 * action tried to carry tenant material into the pool, and that must surface as
 * a failure rather than a silently skipped cache update.
 */
export function createCacheUpdateSink(
  options: CacheUpdateOptions,
): (report: StepOutcomeReport) => void {
  return (report) => {
    recordStepOutcome(report, options);
  };
}
