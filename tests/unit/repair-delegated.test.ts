/**
 * The delegated repair client (#189) — a fake host callback, no network, no key.
 *
 * What these guard, in order of how much it would cost to get wrong:
 *
 * 1. **Every proposal is flagged unmeasured.** A delegated repair reports zero
 *    tokens because nobody counted them, not because none were spent. If one
 *    exit path forgot the flag, those zeros would enter `mean(cost_repair)` and
 *    push the §9 kill-line ratio toward a false pass.
 * 2. **The host only ever sees the authorized payload.** Delegation adds a
 *    third party; `RepairContext` carries `params`.
 * 3. **A non-answer is an answer.** Decline, throw, timeout, and garbage all
 *    land on `corrected_action: null` — never a retry, never a hang.
 * 4. **A proposal touching the assertion is dropped whole**, exactly as the
 *    model client's is.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DELEGATED_COST_NOTE,
  DEFAULT_DELEGATED_TIMEOUT_MS,
  DelegatedRepairModelClient,
  type DelegatedRepairResponse,
  type RepairRequestHandler,
} from "../../src/runner/repair-delegated.js";
import { emptyPageState } from "../../src/runner/page-state.js";
import type { CompiledAction, RepairContext } from "../../src/runner/types.js";

// Named `canaryValue`, not the obvious thing: `scripts/secret-scan.mjs`'s
// `env-assignment` pattern matches a SECRET/API_KEY-shaped name followed by
// `=`, which makes the *correct* name for a canary a scan hit. Fifth trip on
// that pattern in this repo — see the note in `repair-anthropic.ts` and #100.
const canaryValue = "CANARY-" + "DELEGATED-" + "5f2b81ce";

function context(): RepairContext {
  return {
    run_id: "run-1",
    attempt: 1,
    failed_outcome: "LOCATOR_NOT_FOUND",
    assertion: {
      schema_version: "1.0.0",
      assertion_id: "assert-0",
      type: "element-visible",
      strength: "strong",
      expected: { template: "Saved" },
      timeout_ms: 5000,
      failure_classification: "assertion_failed",
    },
    step: {
      step_index: 3,
      compiled_action: {
        type: "click",
        locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Save" }],
      },
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "assert-0",
        type: "element-visible",
        strength: "strong",
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    },
    page_state: {
      ...emptyPageState({ url: "http://127.0.0.1:3000/d/x", title: "Dash" }),
      context_level: "interactive",
      elements: [{ role: "button", name: "Save dashboard" }],
    },
    params: { password: canaryValue },
  } as unknown as RepairContext;
}

const GOOD_ACTION: CompiledAction = {
  type: "click",
  locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Save dashboard" }],
};

function client(handler: RepairRequestHandler, timeoutMs?: number) {
  return new DelegatedRepairModelClient(
    timeoutMs === undefined ? { handler } : { handler, timeoutMs },
  );
}

describe("DelegatedRepairModelClient: the host proposes (#189)", () => {
  it("returns the host's corrected action", async () => {
    const proposal = await client(async () => ({ corrected_action: GOOD_ACTION })).propose(
      context(),
    );
    expect(proposal.corrected_action).toEqual(GOOD_ACTION);
  });

  it("accepts a synchronous handler", async () => {
    // The callback is the primitive an MCP wrapper would sit on; a host that
    // already has the answer should not have to fabricate a promise.
    const proposal = await client(() => ({ corrected_action: GOOD_ACTION })).propose(context());
    expect(proposal.corrected_action).toEqual(GOOD_ACTION);
  });

  it("passes through the host's pre_actions, validated like its action (ADR-0024)", async () => {
    const ok = await client(() => ({ corrected_action: GOOD_ACTION, pre_actions: [GOOD_ACTION] })).propose(context());
    expect(ok.pre_actions).toEqual([GOOD_ACTION]);
    const bad = await client(() => ({ corrected_action: GOOD_ACTION, pre_actions: [{ type: "click" }] })).propose(context());
    expect(bad.corrected_action).toBeNull();
    expect(bad.notes).toMatch(/pre_actions\[0\]/);
  });

  it("passes through the host's model_id without making the cost measured", async () => {
    const proposal = await client(async () => ({
      corrected_action: GOOD_ACTION,
      model_id: "host-model-1",
    })).propose(context());
    expect(proposal.model_id).toBe("host-model-1");
    // Reproducibility only. A model id is not a usage block.
    expect(proposal.cost_measured).toBe(false);
    expect(proposal.tokens_in).toBe(0);
  });

  it("refuses to be constructed without a handler", () => {
    expect(() => new DelegatedRepairModelClient({} as never)).toThrow(TypeError);
  });

  it("defaults to a two-minute ceiling", () => {
    expect(client(async () => null).timeoutMs).toBe(DEFAULT_DELEGATED_TIMEOUT_MS);
  });
});

describe("token accounting: zero, flagged, never estimated (#189)", () => {
  const cases: Array<[string, RepairRequestHandler]> = [
    ["a repair", async () => ({ corrected_action: GOOD_ACTION })],
    ["a decline (null)", async () => null],
    ["a decline (undefined)", async () => undefined],
    ["a throw", () => Promise.reject(new Error("host is busy"))],
    ["a non-object", async () => "sure, click Save" as unknown as DelegatedRepairResponse],
    ["an assertion mutation", async () => ({ corrected_action: { ...GOOD_ACTION, timeout_ms: 1 } })],
  ];

  it.each(cases)("reports zero unmeasured tokens after %s", async (_label, handler) => {
    const proposal = await client(handler).propose(context());
    expect(proposal.tokens_in).toBe(0);
    expect(proposal.tokens_out).toBe(0);
    // The flag, not the note, is what the aggregate reads (ADR-0020).
    expect(proposal.cost_measured).toBe(false);
    expect(proposal.notes).toContain(DELEGATED_COST_NOTE);
  });
});

describe("a non-answer is an answer, not a retry (#189)", () => {
  it("treats null as an explicit decline", async () => {
    const proposal = await client(async () => null).propose(context());
    expect(proposal.corrected_action).toBeNull();
    expect(proposal.notes).toContain("declined");
  });

  it("reports a throwing handler instead of propagating it", async () => {
    // The runner catches a throw too, but a caught throw loses the reason.
    const proposal = await client(() => Promise.reject(new Error("host is busy"))).propose(
      context(),
    );
    expect(proposal.corrected_action).toBeNull();
    expect(proposal.notes).toContain("host is busy");
  });

  it("calls the host exactly once", async () => {
    const handler = vi.fn(async () => null);
    await client(handler).propose(context());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("gives up on a handler that never settles", async () => {
    const proposal = await client(() => new Promise<never>(() => {}), 5).propose(context());
    expect(proposal.corrected_action).toBeNull();
    expect(proposal.notes).toContain("did not answer within 5ms");
    expect(proposal.cost_measured).toBe(false);
  });

  it("survives a handler that rejects after the timeout fired", async () => {
    // A late rejection with no handler attached is an unhandled rejection, and
    // Node's default is to kill the process — mid-run, on someone else's slow
    // agent.
    const proposal = await client(
      () => new Promise((_r, reject) => setTimeout(() => reject(new Error("late")), 20)),
      5,
    ).propose(context());
    expect(proposal.corrected_action).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
  });

  it("honours a disabled ceiling", async () => {
    const proposal = await client(async () => ({ corrected_action: GOOD_ACTION }), 0).propose(
      context(),
    );
    expect(proposal.corrected_action).toEqual(GOOD_ACTION);
  });
});

describe("the frozen assertion is not negotiable (#189)", () => {
  it.each(["assertion", "expected", "timeout_ms"])(
    "drops a proposal carrying %s, whole",
    async (field) => {
      const proposal = await client(async () => ({
        corrected_action: { ...GOOD_ACTION, [field]: "anything" },
      })).propose(context());
      // Not merged, not partially honoured — null.
      expect(proposal.corrected_action).toBeNull();
      expect(proposal.notes).toContain("attempted to modify the assertion");
    },
  );

  it("drops an action with no locator chain", async () => {
    const proposal = await client(async () => ({
      corrected_action: { type: "click" },
    })).propose(context());
    expect(proposal.corrected_action).toBeNull();
    expect(proposal.notes).toContain("locator_fallback_chain");
  });

  it("keeps the host's own notes alongside the rejection reason", async () => {
    const proposal = await client(async () => ({
      corrected_action: null,
      notes: "no matching element",
    })).propose(context());
    expect(proposal.notes).toContain("no matching element");
  });
});

describe("the host is a third party (#189, ADR-0012)", () => {
  it("hands the handler the authorized payload and nothing else", async () => {
    let seen: unknown;
    await client(async (request) => {
      seen = request;
      return null;
    }).propose(context());

    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain(canaryValue);
    expect(serialized).not.toContain("password");
    // Counter-check: a payload that leaked nothing because it carried nothing
    // would pass the two assertions above and make repair impossible.
    expect((seen as { page: { url: string } }).page.url).toContain("127.0.0.1");
    expect((seen as { step: { action_type: string } }).step.action_type).toBe("click");
  });
});
