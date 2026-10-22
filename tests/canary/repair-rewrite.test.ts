/**
 * A repair rewrite is a write, and the privacy boundary applies to it (#64).
 *
 * This is the new attack surface #64 opens. Before it, every row in the cache
 * came from the compiler, whose output the canary already covers. Now a *model*
 * proposes a `corrected_action` and that action becomes a persisted row — so a
 * repair can introduce a locator the original never had, carrying tenant text
 * the compiler never saw.
 *
 * The update path does not re-implement the boundary; it hands the candidate to
 * `writeCacheRow()`, the same gatekeeper. What these prove is that it actually
 * does that, and that a tainted repair is refused **before** anything reaches
 * the store — which matters more here than elsewhere, because the store is
 * append-only. There is no correcting a bad line later.
 */

import { describe, expect, it } from "vitest";
import {
  CANARY_TENANT,
  findCanariesIn,
} from "../../src/cache/pipeline.js";
import { MemoryCacheStore } from "../../src/cache/store.js";
import { recordStepOutcome } from "../../src/cache/update.js";
import { CacheWriteRejectedError } from "../../src/cache/write.js";
import type { CacheRow } from "../../src/cache/types.js";

const KEY = {
  site_key: "grafana-oss@127.0.0.1:3000",
  task_key: "create-stat-dashboard",
  step_index: 0,
};
const NOW = "2026-08-03T12:00:00.000Z";

function pooledRow(): CacheRow {
  return {
    schema_version: "1.0.0",
    row_id: "cache-row-0",
    ...KEY,
    compiled_action: {
      type: "click",
      locator_fallback_chain: [
        { strategy: "testid", testid: "submit-button", tenant_scoped: false },
      ],
    },
    assertion: {
      schema_version: "1.0.0",
      assertion_id: "assert-0",
      type: "element-visible",
      strength: "strong",
      target: { locator: { strategy: "testid", testid: "page-header" } },
      expected: { visible: true },
      timeout_ms: 5000,
      failure_classification: "assertion_failed",
    },
    confidence: 1,
    success_count: 3,
    failure_count: 0,
    last_verified_at: "2026-08-01T00:00:00.000Z",
    pool_eligible: true,
    pool_ineligible_reason: null,
  } as unknown as CacheRow;
}

/** A repair that "fixes" the step by grabbing tenant text off the page. */
function taintedRepair() {
  return {
    run_id: "run-1",
    repair_attempt: 1,
    corrected_action: {
      type: "click" as const,
      locator_fallback_chain: [
        { strategy: "text" as const, text: CANARY_TENANT.resourceName },
        { strategy: "role_name" as const, role: "button", name: CANARY_TENANT.personName },
      ],
    },
  };
}

describe("canary: a repaired action goes through the privacy boundary", () => {
  it("refuses to persist a repair that would pool tenant text", () => {
    const store = new MemoryCacheStore();
    store.write(pooledRow());

    expect(() =>
      recordStepOutcome(
        { ...KEY, outcome: "REPAIRED_PASS", repair: taintedRepair() },
        { store, now: () => NOW },
      ),
    ).toThrow(CacheWriteRejectedError);
  });

  it("leaves the store untouched when a repair is refused", () => {
    // Append-only: a leaked line cannot be corrected by a later write, so the
    // refusal has to happen before the store sees anything.
    const store = new MemoryCacheStore();
    store.write(pooledRow());
    try {
      recordStepOutcome(
        { ...KEY, outcome: "REPAIRED_PASS", repair: taintedRepair() },
        { store, now: () => NOW },
      );
    } catch {
      /* expected */
    }

    expect(store.allWrites()).toHaveLength(1); // just the seed row
    expect(findCanariesIn(JSON.stringify(store.allWrites()))).toEqual([]);
  });

  it("no canary string reaches any stored row", () => {
    const store = new MemoryCacheStore();
    store.write(pooledRow());
    for (const outcome of ["PASS", "ASSERTION_FAILED", "REPAIRED_PASS"]) {
      try {
        recordStepOutcome(
          { ...KEY, outcome, ...(outcome === "REPAIRED_PASS" ? { repair: taintedRepair() } : {}) },
          { store, now: () => NOW },
        );
      } catch {
        /* refusals are the point */
      }
    }
    expect(findCanariesIn(JSON.stringify(store.allWrites()))).toEqual([]);
    for (const [label, value] of Object.entries(CANARY_TENANT)) {
      expect(JSON.stringify(store.allWrites()), `leaked ${label}`).not.toContain(value);
    }
  });

  it("accepts a clean repair — the refusal is not blanket", () => {
    // Counter-check. If every repair were refused, the tests above would pass
    // for the wrong reason and the rewrite path would be dead code.
    const store = new MemoryCacheStore();
    store.write(pooledRow());
    const result = recordStepOutcome(
      {
        ...KEY,
        outcome: "REPAIRED_PASS",
        repair: {
          run_id: "run-1",
          repair_attempt: 1,
          corrected_action: {
            type: "click",
            locator_fallback_chain: [
              { strategy: "testid", testid: "modal-close", tenant_scoped: false },
            ],
          },
        },
      },
      { store, now: () => NOW },
    );

    expect(result.row?.pool_eligible).toBe(true);
    expect(result.row?.repair_provenance?.run_id).toBe("run-1");
    expect(store.allWrites()).toHaveLength(2);
  });
});

/**
 * ADR-0024 (#213): a repair may insert actions before the step's own, and each
 * one is a locator chain a model proposed. They are held to exactly the
 * boundary `compiled_action` is. The new field is the obvious place for a leak
 * to ride past a check that only walks `compiled_action`.
 */
describe("canary: a repair's pre-actions go through the same boundary (ADR-0024)", () => {
  const clean = {
    type: "click" as const,
    locator_fallback_chain: [{ strategy: "testid" as const, testid: "modal-close", tenant_scoped: false }],
  };

  it("refuses a repair whose only tainted part is a pre-action", () => {
    const store = new MemoryCacheStore();
    store.write(pooledRow());
    expect(() =>
      recordStepOutcome(
        {
          ...KEY,
          outcome: "REPAIRED_PASS",
          repair: {
            run_id: "run-1",
            repair_attempt: 1,
            corrected_action: clean,
            pre_actions: [taintedRepair().corrected_action],
          },
        },
        { store, now: () => NOW },
      ),
    ).toThrow(CacheWriteRejectedError);
    expect(store.allWrites()).toHaveLength(1);
    expect(findCanariesIn(JSON.stringify(store.allWrites()))).toEqual([]);
  });

  it("strips a pre-action's tainted locators and keeps its clean ones", () => {
    const store = new MemoryCacheStore();
    store.write(pooledRow());
    const mixed = {
      type: "click" as const,
      locator_fallback_chain: [
        ...taintedRepair().corrected_action.locator_fallback_chain,
        { strategy: "testid" as const, testid: "cancel-button", tenant_scoped: false },
      ],
    };
    const result = recordStepOutcome(
      {
        ...KEY,
        outcome: "REPAIRED_PASS",
        repair: { run_id: "run-1", repair_attempt: 1, corrected_action: clean, pre_actions: [mixed] },
      },
      { store, now: () => NOW },
    );
    expect(result.row?.pool_eligible).toBe(true);
    expect(result.row?.pre_actions?.[0]?.locator_fallback_chain).toEqual([
      { strategy: "testid", testid: "cancel-button", tenant_scoped: false },
    ]);
    expect(result.row?.repair_provenance?.pre_action_count).toBe(1);
    for (const [label, value] of Object.entries(CANARY_TENANT)) {
      expect(JSON.stringify(store.allWrites()), `leaked ${label}`).not.toContain(value);
    }
  });

  it("an empty list clears a row's pre-actions; a report without the field keeps them", () => {
    const store = new MemoryCacheStore();
    store.write({ ...pooledRow(), pre_actions: [clean] } as CacheRow);
    const kept = recordStepOutcome(
      { ...KEY, outcome: "REPAIRED_PASS", repair: { run_id: "r", repair_attempt: 1, corrected_action: clean } },
      { store, now: () => NOW },
    );
    expect(kept.row?.pre_actions).toHaveLength(1);
    const cleared = recordStepOutcome(
      { ...KEY, outcome: "REPAIRED_PASS", repair: { run_id: "r", repair_attempt: 1, corrected_action: clean, pre_actions: [] } },
      { store, now: () => NOW },
    );
    expect(cleared.row?.pre_actions).toBeUndefined();
    expect(cleared.row?.repair_provenance?.pre_action_count).toBeUndefined();
  });

  it("an ordinary confidence update carries a row's pre-actions through", () => {
    // finalize() builds rows field by field; a field it forgets is silently
    // dropped on every rewrite, which would undo the repair on the next PASS.
    const store = new MemoryCacheStore();
    store.write({ ...pooledRow(), pre_actions: [clean] } as CacheRow);
    const result = recordStepOutcome({ ...KEY, outcome: "PASS" }, { store, now: () => NOW });
    expect(result.row?.pre_actions).toEqual([clean]);
  });
});
