/**
 * ADR-0027: the gate's runs repair until the task finishes or the run's time
 * budget runs out. The §9 bar ("<=2 repairs/run") is computed separately and
 * does not move; the cap only decided how far a run got, and at 2 it stopped
 * 10.0.13 runs at step 6, leaving steps 7-11 unmeasured and repair cost
 * understated against a fresh run that finishes the task.
 */

import { describe, expect, it } from "vitest";

import { MetricsEmitter } from "../../src/metrics/emitter.js";
import type { RunMetric } from "../../src/metrics/types.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type { CompiledProgram, RepairContext, RepairProposal } from "../../src/runner/types.js";
import { parseArgs } from "../../experiments/gate-v1/run-matrix.js";

const step = (i: number) => ({
  step_index: i,
  compiled_action: {
    type: "click" as const,
    locator_fallback_chain: [{ strategy: "role_name" as const, role: "button", name: `b${i}` }],
  },
  assertion: {
    schema_version: "1.0.0" as const,
    assertion_id: `a${i}`,
    type: "element-visible" as const,
    strength: "weak" as const,
    target: { locator_ref: "action_target" as const },
    expected: { visible: true },
    timeout_ms: 100,
    failure_classification: "assertion_failed" as const,
  },
});

const program = (n: number): CompiledProgram => ({
  schema_version: "1.0.0",
  program_id: "p",
  site_key: "s",
  task_key: "t",
  testbed_version: "v",
  steps: Array.from({ length: n }, (_, i) => step(i)),
});

/** Proposes a new action every call, so no attempt repeats. */
class Fresh implements RepairModelClient {
  calls = 0;
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.calls += 1;
    return {
      corrected_action: { ...ctx.step.compiled_action, locator_fallback_chain: [{ strategy: "testid", testid: `t${this.calls}` }] },
      tokens_in: 1,
      tokens_out: 1,
    };
  }
}

/** Proposes the same action every call. */
class Same implements RepairModelClient {
  calls = 0;
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.calls += 1;
    return { corrected_action: ctx.step.compiled_action, tokens_in: 1, tokens_out: 1 };
  }
}

async function dry(n: number, failing: number[], client: RepairModelClient, maxRepairsPerRun: number) {
  const metrics = new MetricsEmitter();
  const outcomes = Array.from({ length: n }, (_, i) => (failing.includes(i) ? "LOCATOR_NOT_FOUND" : "PASS")) as never;
  const result = await new ReplayRunner({ dryRun: true, dryRunOutcomes: outcomes, repairClient: client, metrics, maxRepairsPerRun })
    .run(program(n));
  const run = metrics.getRows().find((r) => r.metric_kind === "run") as RunMetric;
  return { result, run };
}

describe("uncapped repairs (ADR-0027)", () => {
  it("an uncapped run gets past a third repair; the §9 bar still says no", async () => {
    const { result, run } = await dry(5, [0, 1, 2, 3], new Fresh(), Number.POSITIVE_INFINITY);
    expect(result.task_success).toBe(true);
    expect(result.steps_attempted).toBe(5);
    expect(result.repair_count).toBe(4);
    // The cap moved how far the run got, never the bar.
    expect(result.success_with_le_2_repairs).toBe(false);
    expect(run.repair_cap).toBeNull();
  });

  it("at cap 2 the same run stops at the third failing step, as before", async () => {
    const { result, run } = await dry(5, [0, 1, 2, 3], new Fresh(), 2);
    expect(result.task_success).toBe(false);
    expect(result.steps_attempted).toBe(3);
    expect(run.repair_cap).toBe(2);
  });

  it("a repeated proposal ends the step instead of spending the time budget", async () => {
    const { launchTestBrowser } = await import("../helpers/browser.js");
    const browser = await launchTestBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(300);
      await page.setContent("<main><p>nothing to click</p></main>");
      const same = new Same();
      const result = await new ReplayRunner({
        page,
        repairClient: same,
        maxRepairsPerRun: Number.POSITIVE_INFINITY,
      }).run(program(1));
      // One real attempt, then the identical proposal is refused unexecuted.
      expect(same.calls).toBe(2);
      expect(result.step_results[0]).toMatchObject({
        outcome: "REPAIR_EXHAUSTED",
        error_message: "repair proposed a sequence it already tried on this step",
      });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("the matrix defaults to uncapped, and accepts a number or none", () => {
    expect(parseArgs([]).maxRepairsPerRun).toBe(Number.POSITIVE_INFINITY);
    expect(parseArgs(["--max-repairs-per-run", "6"]).maxRepairsPerRun).toBe(6);
    expect(parseArgs(["--max-repairs-per-run", "none"]).maxRepairsPerRun).toBe(Number.POSITIVE_INFINITY);
    expect(() => parseArgs(["--max-repairs-per-run", "-1"])).toThrow(/non-negative/);
  });
});
