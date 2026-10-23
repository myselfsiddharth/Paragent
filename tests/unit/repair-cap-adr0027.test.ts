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

  describe("the repeat guard (uncapped runs only)", () => {
    const withPage = async (html: string, fn: (page: import("playwright").Page) => Promise<void>) => {
      const { launchTestBrowser } = await import("../helpers/browser.js");
      const browser = await launchTestBrowser();
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(300);
        await page.setContent(html);
        await fn(page);
      } finally {
        await browser.close();
      }
    };

    it("refuses, unexecuted, the action that just failed on a page that has not changed", async () => {
      await withPage("<main><p>nothing to click</p></main>", async (page) => {
        const same = new Same();
        const result = await new ReplayRunner({ page, repairClient: same, maxRepairsPerRun: Number.POSITIVE_INFINITY })
          .run(program(1));
        // The first pass counts as tried, so the very first identical proposal is refused.
        expect(same.calls).toBe(1);
        expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
        expect(result.step_results[0]?.error_message).toMatch(
          /already failed on this unchanged page; last failure: .*no locator matched/,
        );
      });
    }, 60_000);

    it("lets the same proposal run again once the page has changed", async () => {
      // The button appears 600 ms in; the model takes 900 ms to answer.
      const html = `<main></main><script>setTimeout(() => {
        const b = document.createElement("button"); b.setAttribute("aria-label", "b0");
        document.querySelector("main").appendChild(b); }, 600)</script>`;
      await withPage(html, async (page) => {
        class SlowSame extends Same {
          override async propose(ctx: RepairContext): Promise<RepairProposal> {
            await new Promise((r) => setTimeout(r, 900));
            return super.propose(ctx);
          }
        }
        const result = await new ReplayRunner({
          page,
          repairClient: new SlowSame(),
          maxRepairsPerRun: Number.POSITIVE_INFINITY,
        }).run(program(1));
        expect(result.step_results[0]?.outcome).toBe("REPAIRED_PASS");
      });
    }, 60_000);

    it("leaves capped runs exactly as before: identical proposals still execute", async () => {
      await withPage("<main><p>nothing to click</p></main>", async (page) => {
        const same = new Same();
        await new ReplayRunner({ page, repairClient: same, maxRepairsPerRun: 2 }).run(program(1));
        expect(same.calls).toBe(2);
      });
    }, 60_000);
  });

  it("refuses a cap that is not a non-negative integer or Infinity, and uncapped with no time budget", () => {
    for (const bad of [Number.NaN, -1, 2.5]) {
      expect(() => new ReplayRunner({ maxRepairsPerRun: bad })).toThrow(/non-negative integer or Infinity/);
    }
    for (const budget of [0, Number.POSITIVE_INFINITY]) {
      expect(() => new ReplayRunner({ maxRepairsPerRun: Number.POSITIVE_INFINITY, runBudgetMs: budget })).toThrow(
        /needs a finite, positive runBudgetMs/,
      );
    }
    expect(() => new ReplayRunner({ maxRepairsPerRun: 2, runBudgetMs: 0 })).not.toThrow();
  });

  it("the matrix defaults to uncapped, and accepts a number or none", () => {
    expect(parseArgs([]).maxRepairsPerRun).toBe(Number.POSITIVE_INFINITY);
    expect(parseArgs(["--max-repairs-per-run", "6"]).maxRepairsPerRun).toBe(6);
    expect(parseArgs(["--max-repairs-per-run", "none"]).maxRepairsPerRun).toBe(Number.POSITIVE_INFINITY);
    for (const bad of ["-1", "", " ", "0x2", "1e1", "2.5", "None"]) {
      expect(() => parseArgs(["--max-repairs-per-run", bad]), JSON.stringify(bad)).toThrow(/non-negative/);
    }
  });
});
