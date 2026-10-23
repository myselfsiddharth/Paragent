/**
 * Repair-loop invariants under scripted fake RepairModelClients.
 *
 * `tests/unit/runner.test.ts` exercises ReplayRunner only against
 * StubRepairModelClient, which always returns `corrected_action: null` — a
 * client that never proposes anything cannot test what happens when a
 * proposal is hostile, or when the budget must be exhausted across several
 * real proposals. This file drives ReplayRunner with a real (headless)
 * Playwright page and fully scripted clients so both are covered.
 *
 * No network, no API key: every client here is a local class implementing
 * `RepairModelClient`. The only browser involved is a local Chromium
 * instance navigating to `about:blank` and `data:` URLs.
 */
import { type Browser, type Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReplayRunner } from "../../src/runner/replay.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import type {
  Assertion,
  CompiledAction,
  CompiledProgram,
  RepairContext,
  RepairProposal,
} from "../../src/runner/types.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchTestBrowser();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  page = await browser.newPage();
});

afterEach(async () => {
  await page.close();
});

/** Never satisfies `TARGET_ASSERTION` — resets the page to a blank document. */
const NOOP_NAVIGATE: CompiledAction = {
  type: "navigate",
  url_template: "about:blank",
  locator_fallback_chain: [],
};

/** The only action that satisfies `TARGET_ASSERTION`. */
const FIX_NAVIGATE: CompiledAction = {
  type: "navigate",
  url_template:
    'data:text/html,<div id="repair-target" style="width:10px;height:10px;">x</div>',
  locator_fallback_chain: [],
};

function targetAssertion(overrides: Partial<Assertion> = {}): Assertion {
  return {
    schema_version: "1.0.0",
    assertion_id: "assert-repair-invariant",
    type: "element-visible",
    strength: "strong",
    target: { locator: { strategy: "css_vocab", css: "#repair-target" } },
    expected: { visible: true },
    // Short and deterministic: the element either exists after navigation or
    // it never will, so there is nothing worth a longer budget here.
    timeout_ms: 150,
    failure_classification: "assertion_failed",
    ...overrides,
  };
}

function oneStepProgram(assertion: Assertion): CompiledProgram {
  return {
    schema_version: "1.0.0",
    program_id: "repair-invariants",
    site_key: "local-test",
    task_key: "single-step",
    testbed_version: "test",
    steps: [{ step_index: 0, compiled_action: NOOP_NAVIGATE, assertion }],
  };
}

function twoStepProgram(a0: Assertion, a1: Assertion): CompiledProgram {
  return {
    schema_version: "1.0.0",
    program_id: "repair-invariants",
    site_key: "local-test",
    task_key: "two-step",
    testbed_version: "test",
    steps: [
      { step_index: 0, compiled_action: NOOP_NAVIGATE, assertion: a0 },
      { step_index: 1, compiled_action: NOOP_NAVIGATE, assertion: a1 },
    ],
  };
}

function makeRunner(opts: {
  maxRepairsPerRun: number;
  repairClient: RepairModelClient;
}): ReplayRunner {
  return new ReplayRunner({ dryRun: false, page, ...opts });
}

/** Tamper case 1a: reassigns `ctx.assertion` to a different object entirely. */
class ReassignCtxAssertionClient implements RepairModelClient {
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    (ctx as { assertion: Assertion }).assertion = {
      ...ctx.assertion,
      assertion_id: "tampered-via-ctx-reassignment",
    };
    return { corrected_action: FIX_NAVIGATE, tokens_in: 1, tokens_out: 1 };
  }
}

/** Tamper case 1b: mutates the live, non-frozen `step.assertion` in place. */
class MutateStepAssertionClient implements RepairModelClient {
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    (ctx.step.assertion as { assertion_id: string }).assertion_id =
      "tampered-via-step-mutation";
    return { corrected_action: FIX_NAVIGATE, tokens_in: 1, tokens_out: 1 };
  }
}

/** Tamper case 2: the specific attack the contract language names. */
class DowngradeStrengthClient implements RepairModelClient {
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    (ctx.step.assertion as { strength: string }).strength = "weak";
    return { corrected_action: FIX_NAVIGATE, tokens_in: 1, tokens_out: 1 };
  }
}

/**
 * Always proposes a real action, and burns real tokens doing it. Fixes the
 * page (satisfies `targetAssertion`) only on the attempt number named by
 * `fixOnAttempt` (1-indexed) — `null` means it never fixes it.
 */
class ScriptedClient implements RepairModelClient {
  readonly calls: RepairContext[] = [];
  constructor(
    private readonly fixOnAttempt: number | null,
    private readonly tokens = { in: 3, out: 4 },
  ) {}

  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.calls.push(ctx);
    const corrected_action =
      this.fixOnAttempt !== null && ctx.attempt === this.fixOnAttempt
        ? FIX_NAVIGATE
        : NOOP_NAVIGATE;
    return {
      corrected_action,
      tokens_in: this.tokens.in,
      tokens_out: this.tokens.out,
    };
  }
}

/** Proposes nothing, but not before spending tokens on the attempt. */
class TokenBurningNullClient implements RepairModelClient {
  async propose(_ctx: RepairContext): Promise<RepairProposal> {
    return {
      corrected_action: null,
      tokens_in: 111,
      tokens_out: 222,
      notes: "burned tokens, proposed nothing",
    };
  }
}

/** Simulates a model API that errors instead of returning a proposal. */
class ThrowingClient implements RepairModelClient {
  async propose(_ctx: RepairContext): Promise<RepairProposal> {
    throw new Error("simulated model API failure");
  }
}

describe("repair invariants", () => {
  describe("assertion immutability", () => {
    it("rejects a client that reassigns ctx.assertion (the frozen-copy path)", async () => {
      const runner = makeRunner({
        repairClient: new ReassignCtxAssertionClient(),
        maxRepairsPerRun: 2,
      });
      await expect(
        runner.run(oneStepProgram(targetAssertion()), {}),
      ).rejects.toThrow(/assertion must not change/i);
    });

    it("rejects a client that mutates step.assertion in place (the live path)", async () => {
      const runner = makeRunner({
        repairClient: new MutateStepAssertionClient(),
        maxRepairsPerRun: 2,
      });
      await expect(
        runner.run(oneStepProgram(targetAssertion()), {}),
      ).rejects.toThrow(/assertion must not change/i);
    });

    it("rejects a strength downgrade strong -> weak specifically", async () => {
      const runner = makeRunner({
        repairClient: new DowngradeStrengthClient(),
        maxRepairsPerRun: 2,
      });
      await expect(
        runner.run(oneStepProgram(targetAssertion({ strength: "strong" })), {}),
      ).rejects.toThrow(/assertion must not change/i);
    });
  });

  describe("repair budget", () => {
    it("honours maxRepairsPerRun: exactly 2 attempts, REPAIR_EXHAUSTED, repair_count===2", async () => {
      const client = new ScriptedClient(null);
      const runner = makeRunner({ repairClient: client, maxRepairsPerRun: 2 });
      const result = await runner.run(oneStepProgram(targetAssertion()), {});

      expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
      expect(result.repair_count).toBe(2);
      expect(client.calls.length).toBe(2);
    });

    it("shares the budget across steps — a later failing step gets no fresh allowance", async () => {
      const client = new ScriptedClient(2); // fixes step 0 on its 2nd repair attempt
      const program = twoStepProgram(
        targetAssertion({ assertion_id: "s0" }),
        targetAssertion({ assertion_id: "s1" }),
      );
      const runner = makeRunner({ repairClient: client, maxRepairsPerRun: 2 });
      const result = await runner.run(program, {});

      expect(result.step_results[0]?.outcome).toBe("REPAIRED_PASS");
      expect(result.step_results[1]?.outcome).toBe("REPAIR_EXHAUSTED");
      // Step 0 consumed both slots; the run-level counter never exceeds the cap.
      expect(result.repair_count).toBe(2);
      // Step 1 never got to call propose at all — proof the allowance was
      // already gone, not merely that it failed twice more.
      expect(client.calls.length).toBe(2);
    });
  });

  describe("success_with_le_2_repairs", () => {
    it("is true for a run needing exactly 2 repairs and succeeding", async () => {
      const client = new ScriptedClient(2);
      const runner = makeRunner({ repairClient: client, maxRepairsPerRun: 2 });
      const result = await runner.run(oneStepProgram(targetAssertion()), {});

      expect(result.task_success).toBe(true);
      expect(result.repair_count).toBe(2);
      expect(result.success_with_le_2_repairs).toBe(true);
    });

    it("is false for a run needing 3 repairs (raised cap), even though it succeeds", async () => {
      const client = new ScriptedClient(3);
      const runner = makeRunner({ repairClient: client, maxRepairsPerRun: 3 });
      const result = await runner.run(oneStepProgram(targetAssertion()), {});

      expect(result.task_success).toBe(true);
      expect(result.repair_count).toBe(3);
      expect(result.success_with_le_2_repairs).toBe(false);
    });
  });

  describe("cost accounting", () => {
    it("bills repair tokens even when the client proposes nothing", async () => {
      const runner = makeRunner({
        repairClient: new TokenBurningNullClient(),
        maxRepairsPerRun: 2,
      });
      const result = await runner.run(oneStepProgram(targetAssertion()), {});

      expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
      expect(result.cost_repair.tokens_in).toBe(111);
      expect(result.cost_repair.tokens_out).toBe(222);
    });
  });

  describe("repair client failures", () => {
    it("a thrown client error produces a failure outcome, not an escaped exception", async () => {
      const runner = makeRunner({
        repairClient: new ThrowingClient(),
        maxRepairsPerRun: 2,
      });

      const result = await runner.run(oneStepProgram(targetAssertion()), {});

      expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
      expect(result.step_results[0]?.error_message).toMatch(
        /simulated model API failure/,
      );
    });
  });
});
