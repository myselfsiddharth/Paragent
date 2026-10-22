/**
 * Confidence, self-invalidation, and the repair rewrite (PRD §5.3, issue #64).
 *
 * `contracts/cache-row.schema.json` has carried `confidence`, `success_count`,
 * `failure_count` and `last_verified_at` since B5. Nothing ever updated them:
 * the compiler wrote zeros and `ReplayRunner` never touched the cache. §5.3
 * makes those fields the mechanism rather than bookkeeping —
 *
 * > Entries are confidence-weighted by recent success rate; stale entries
 * > self-invalidate on assertion failure; the repair rewrites the entry
 *
 * — so until this module they described a self-healing cache that did not exist.
 *
 * ## The two rules that matter more than the maths
 *
 * 1. **Confidence never gates the gate measurement.** Nothing here is consulted
 *    to decide whether to attempt a step. A matrix run attempts every compiled
 *    step regardless of confidence, because skipping a low-confidence row would
 *    quietly shrink the step-validity denominator and inflate the headline
 *    number. During Track 1 confidence is *recorded*, not *acted on*. This is
 *    exactly the optimisation a later reader will helpfully add, so it is said
 *    here, in `docs/gate/cache.md`, and pinned by
 *    `tests/unit/cache-confidence.test.ts`.
 *
 * 2. **Every update goes through `writeCacheRow()`.** A repaired action can
 *    carry a locator the original never had, so a rewrite is exactly as capable
 *    of leaking tenant material as a first write. The privacy boundary is not
 *    re-implemented here; the update path builds a candidate and hands it to the
 *    same gatekeeper, and `tests/canary/repair-rewrite.test.ts` proves a tainted
 *    repair is still refused.
 *
 * ## The numbers are chosen defaults, not measurements
 *
 * `CONFIDENCE_ALPHA` and `INVALIDATION_THRESHOLD` are **design choices**. No
 * measurement supports them and none is claimed — `docs/INTEGRITY-AUDIT.md`
 * category B exists because of exactly this failure mode. What justifies them is
 * the behaviour they produce, which is stated and tested rather than asserted:
 *
 * | Situation | Result |
 * | --- | --- |
 * | Fresh row, first PASS | `1.0` — one observation, and it succeeded |
 * | Fully-confident row, two consecutive failures | `0.49` → **invalidated** |
 * | …then one PASS | `0.643` — recovers above the threshold |
 * | Fresh row, first-ever failure | `0.0` → **invalidated** immediately |
 * | Passed 100×, then 3 failures today | `0.343` → **invalidated** |
 *
 * That last row is §5.3's own example: "a row that passed 100 times last year
 * and failed 3 times today is stale". A plain success *rate* would score it
 * 0.97 and call it healthy, which is why the weighting is exponential and not
 * an average.
 */

import type { CacheRow, CacheRowCandidate } from "./types.js";

/**
 * Strip the fields that describe *the write that produced a version*, before
 * handing a row back to the write path to produce the next one.
 *
 * `pool_eligible` / `pool_ineligible_reason` are **outputs** of a write, not
 * inputs to the next one. Forwarding the stored value would turn a
 * recomputation into a demand: `writeCacheRow()` throws when a caller asserts
 * `pool_eligible: true` and the row no longer earns it, so a repair that
 * produced a less-poolable action would blow up instead of being reclassified.
 * Reclassification is the correct behaviour — the locators changed.
 *
 * `repair_provenance` is stripped for the same reason (#114). The schema and
 * ADR-0009 both say it is "present only on a row written by a repair rewrite",
 * and carrying it forward on a later plain `PASS` breaks that: the version is
 * labelled with a repair that did not write it, and its `repaired_at` no longer
 * matches that version's `last_verified_at`. Only the repair branch below puts
 * it back, so the invariant is structural rather than something each branch has
 * to remember to clear.
 */
function forRewrite(row: CacheRow): CacheRowCandidate {
  const {
    pool_eligible: _pe,
    pool_ineligible_reason: _pr,
    repair_provenance: _rp,
    ...rest
  } = row;
  return rest;
}

/**
 * Weight given to the newest observation. Chosen default, not measured.
 *
 * 0.3 is picked for the properties in the module table: two consecutive
 * failures take a perfect row under the threshold, and one success brings it
 * back. Lower would make the cache slow to notice churn — the thing it exists
 * to notice; higher would make a single flake look like staleness, and #66
 * has not yet established how flaky the harness is.
 */
export const CONFIDENCE_ALPHA = 0.3;

/** Below this, a row is marked invalidated. Chosen default, not measured. */
export const INVALIDATION_THRESHOLD = 0.5;

/** Rounding for the stored value — keeps append-only JSONL diffs readable. */
const PRECISION = 1e6;

export type OutcomeKind = "pass" | "failure" | "repaired";

/**
 * Map a runner `StepOutcome` onto what it means for a cache entry.
 *
 * Typed structurally rather than importing `StepOutcome` from `src/runner/`:
 * the cache is written to by the runner, not the other way round, and a package
 * dependency in that direction would be backwards.
 *
 * `REPAIR_EXHAUSTED` counts as a failure — the step did not do what the entry
 * says it does. `PASS` after a repair (`REPAIRED_PASS`) is deliberately *not* a
 * plain pass: it means the recorded action was wrong and a different one worked,
 * which is a rewrite, not a confirmation.
 */
export function classifyOutcome(outcome: string): OutcomeKind | null {
  switch (outcome) {
    case "PASS":
      return "pass";
    case "REPAIRED_PASS":
      return "repaired";
    case "ASSERTION_FAILED":
    case "LOCATOR_NOT_FOUND":
    case "TIMEOUT":
    case "PAGE_ERROR":
    case "REPAIR_EXHAUSTED":
      return "failure";
    default:
      // An outcome this module does not understand must not silently score as
      // either. Returning null leaves the row untouched.
      return null;
  }
}

/**
 * Next confidence after one observation.
 *
 * The first observation seeds the value directly instead of decaying from the
 * compiler's `confidence: 0`. Otherwise a brand-new row's first success would
 * score 0.3 and read as low-confidence, when what it actually is is
 * *verified once*. Zero observations means **no data**, not low confidence —
 * the same distinction `src/metrics/aggregate.ts` draws when it reports
 * `no_data` rather than 0.
 */
export function nextConfidence(
  current: number,
  observations: number,
  success: boolean,
): number {
  const observed = success ? 1 : 0;
  const next =
    observations <= 0
      ? observed
      : CONFIDENCE_ALPHA * observed + (1 - CONFIDENCE_ALPHA) * current;
  return Math.round(next * PRECISION) / PRECISION;
}

/** True when a row has been observed at least once. */
export function isVerified(row: Pick<CacheRow, "success_count" | "failure_count">): boolean {
  return row.success_count + row.failure_count > 0;
}

/**
 * Whether a row counts as invalidated.
 *
 * An unobserved row is **never** invalidated, however low its confidence reads:
 * the compiler writes `confidence: 0` on every fresh row, and treating that as
 * staleness would mark the entire cache invalid the moment it was compiled.
 */
export function isInvalidated(row: CacheRow): boolean {
  return row.invalidated_at !== undefined && row.invalidated_at !== null;
}

export interface OutcomeContext {
  /** ISO timestamp for the observation. Injected so tests are deterministic. */
  now: string;
  /** Present for `repaired`: what the repair produced and where it came from. */
  repair?: {
    run_id: string;
    repair_attempt: number;
    corrected_action: CacheRow["compiled_action"];
    /** The step's pre-actions after the repair (ADR-0024). Empty clears them. */
    pre_actions?: CacheRow["compiled_action"][];
  };
}

/**
 * Apply one step outcome to a row, returning the **candidate** for the next
 * version. Does not write: `writeCacheRow()` is the only thing that writes, so
 * the privacy boundary applies to the result.
 *
 * Append-only storage means this is a new version rather than a mutation, and
 * every superseded version stays on disk — deletion would destroy the record of
 * what churn did, which is the entire experiment.
 */
export function applyOutcome(
  row: CacheRow,
  kind: OutcomeKind,
  ctx: OutcomeContext,
): CacheRowCandidate {
  const observations = row.success_count + row.failure_count;
  const success = kind !== "failure";

  if (kind === "repaired") {
    // The recorded action was wrong and a different one worked. The corrected
    // action has no history of its own, so it starts as verified-once rather
    // than inheriting the confidence of the action it replaces — carrying that
    // over would credit the new action with the old one's track record.
    const repaired: CacheRowCandidate = {
      ...forRewrite(row),
      compiled_action: ctx.repair?.corrected_action ?? row.compiled_action,
      confidence: 1,
      success_count: 1,
      failure_count: 0,
      last_verified_at: ctx.now,
      invalidated_at: null,
    };
    // ADR-0024: a repair that reports pre-actions replaces the step's whole
    // sequence. The recorded ones it kept are already in its list, so an empty
    // list clears them: that is how a repair drops an action churn took away.
    // A report without the field predates ADR-0024 and leaves them as they are.
    if (ctx.repair?.pre_actions !== undefined) {
      delete repaired.pre_actions;
      if (ctx.repair.pre_actions.length > 0) repaired.pre_actions = ctx.repair.pre_actions;
    }
    // The only place provenance is set. `forRewrite` cleared whatever an
    // earlier repair left, so a `repaired` outcome that arrives without repair
    // details carries none rather than inheriting the previous repair's.
    if (ctx.repair) {
      repaired.repair_provenance = {
        repaired_at: ctx.now,
        run_id: ctx.repair.run_id,
        repair_attempt: ctx.repair.repair_attempt,
        replaced_action_type: row.compiled_action.type,
      };
      if (repaired.pre_actions) {
        repaired.repair_provenance.pre_action_count = repaired.pre_actions.length;
      }
    }
    return repaired;
  }

  const confidence = nextConfidence(row.confidence, observations, success);
  const successCount = row.success_count + (success ? 1 : 0);
  const failureCount = row.failure_count + (success ? 0 : 1);

  const next: CacheRowCandidate = {
    ...forRewrite(row),
    confidence,
    success_count: successCount,
    failure_count: failureCount,
    // Only a success re-verifies. A failure is an observation, but it is not
    // evidence the entry still describes the page.
    last_verified_at: success ? ctx.now : row.last_verified_at,
  };

  // Crossing the threshold in either direction is recorded, both times. The
  // marker is stored rather than derived from `confidence < THRESHOLD` so that
  // later tuning of the threshold cannot retroactively relabel history.
  if (confidence < INVALIDATION_THRESHOLD) {
    next.invalidated_at = isInvalidated(row) ? row.invalidated_at! : ctx.now;
  } else {
    next.invalidated_at = null;
  }

  return next;
}
