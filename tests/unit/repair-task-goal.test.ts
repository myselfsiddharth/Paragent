/**
 * ADR-0025 (#225): the repair model is told what the task is for.
 *
 * Found live on Grafana 10.0.13: with the data-source dialog in front of the
 * editor, the model put the dialog's action first (ADR-0024) but closed it
 * instead of choosing TestData. Nothing it was given said what the task needed,
 * while the fresh baseline, the other side of the §9 ratio, was told.
 */

import { describe, expect, it } from "vitest";

import { MetricsEmitter } from "../../src/metrics/emitter.js";
import type { RunMetric } from "../../src/metrics/types.js";
import { REPAIR_SYSTEM_PROMPT } from "../../src/runner/repair-anthropic.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import { ReplayRunner, TASK_GOAL_MIN_PARAM_LENGTH } from "../../src/runner/replay.js";
import type { CompiledProgram, RepairContext, RepairProposal } from "../../src/runner/types.js";
import { DEFAULT_TASK_GOAL } from "../../experiments/gate-v1/task-goal.js";

const program: CompiledProgram = {
  schema_version: "1.0.0",
  program_id: "p",
  site_key: "s",
  task_key: "t",
  testbed_version: "v",
  steps: [
    {
      step_index: 0,
      compiled_action: {
        type: "click",
        locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Go" }],
      },
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "element-visible",
        strength: "weak",
        target: { locator_ref: "action_target" },
        expected: { visible: true },
        timeout_ms: 1000,
        failure_classification: "assertion_failed",
      },
    },
  ],
};

class Recording implements RepairModelClient {
  readonly seen: RepairContext[] = [];
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.seen.push(ctx);
    return { corrected_action: null, tokens_in: 1, tokens_out: 1 };
  }
}

async function runOnce(taskGoal?: string) {
  const repair = new Recording();
  const metrics = new MetricsEmitter();
  await new ReplayRunner({
    dryRun: true,
    dryRunOutcomes: ["LOCATOR_NOT_FOUND"],
    maxRepairsPerRun: 1,
    repairClient: repair,
    metrics,
    ...(taskGoal !== undefined ? { taskGoal } : {}),
  }).run(program);
  const run = metrics.getRows().find((r) => r.metric_kind === "run") as RunMetric;
  return { repair, run };
}

describe("the repair model is told the task's goal (ADR-0025)", () => {
  it("hands the goal to every repair, and records on the run row that it did", async () => {
    const { repair, run } = await runOnce("  Create a stat dashboard from TestData.  ");
    expect(repair.seen[0]?.task_goal).toBe("Create a stat dashboard from TestData.");
    expect(run.repair_task_goal).toBe(true);
  });

  it("without a goal, nothing changes: no field in the context, none on the row", async () => {
    const { repair, run } = await runOnce();
    expect(repair.seen[0]?.task_goal).toBeUndefined();
    expect(run.repair_task_goal).toBeUndefined();
  });

  it("a blank goal is no goal", async () => {
    const { repair } = await runOnce("   ");
    expect(repair.seen[0]?.task_goal).toBeUndefined();
  });

  it("short bound values do not refuse ordinary prose", async () => {
    // "5" occurs in plenty of goals; a value that short is not worth the check.
    const runner = new ReplayRunner({ dryRun: true, taskGoal: "Set the series count to 5." });
    await expect(runner.run({ ...program, steps: [] }, { series_count: "5" })).resolves.toBeDefined();
    expect("5".length).toBeLessThan(TASK_GOAL_MIN_PARAM_LENGTH);
  });

  it("the prompt tells the model what the goal is for, and what it is not", () => {
    expect(REPAIR_SYSTEM_PROMPT).toContain("task_goal");
    expect(REPAIR_SYSTEM_PROMPT).toMatch(/never as a source of element names/);
  });

  it("the gate's goal is the fresh baseline's goal, from one definition", async () => {
    const fresh = await import("../../experiments/gate-v1/fresh-baseline.js");
    expect(fresh.DEFAULT_TASK_GOAL).toBe(DEFAULT_TASK_GOAL);
    expect(DEFAULT_TASK_GOAL).toContain("TestData");
  });
});
