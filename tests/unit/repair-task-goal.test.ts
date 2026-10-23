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
import { ReplayRunner, TaskGoalCarriesParamError } from "../../src/runner/replay.js";
import {
  paramInTaskGoal,
  taskGoalDigest,
  TASK_GOAL_MIN_PARAM_LENGTH,
} from "../../src/runner/task-goal.js";
import { serializeRepairContext } from "../../src/runner/repair-egress.js";
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
    // Identified, not just flagged: runs told different goals are not comparable.
    expect(run.repair_task_goal_sha256).toBe(taskGoalDigest("Create a stat dashboard from TestData."));
    expect(run.repair_task_goal_sha256).toMatch(/^[0-9a-f]{12}$/);
  });

  it("without a goal, nothing changes: no field in the context, none on the row", async () => {
    const { repair, run } = await runOnce();
    expect(repair.seen[0]?.task_goal).toBeUndefined();
    expect(run.repair_task_goal_sha256).toBeUndefined();
  });

  it("a blank goal is no goal", async () => {
    const { repair } = await runOnce("   ");
    expect(repair.seen[0]?.task_goal).toBeUndefined();
  });

  it("the guard's boundary: 3 characters pass, 4 refuse, numbers and case included", () => {
    expect(TASK_GOAL_MIN_PARAM_LENGTH).toBe(4);
    const goal = "Enter PIN 482913, set count to 5, use Abc and the WIDGET.";
    expect(paramInTaskGoal(goal, { count: "5" })).toBeUndefined();
    expect(paramInTaskGoal(goal, { three: "Abc" })).toBeUndefined();
    expect(paramInTaskGoal(goal, { four: "the " })).toBe("four");
    expect(paramInTaskGoal(goal, { pin: 482913 })).toBe("pin");
    expect(paramInTaskGoal(goal, { item: "widget" })).toBe("item");
    expect(paramInTaskGoal(goal, { flag: true })).toBeUndefined();
  });

  it("the runner refuses a numeric binding in the goal, before step 0", async () => {
    const runner = new ReplayRunner({ dryRun: true, taskGoal: "Enter PIN 482913." });
    await expect(runner.run({ ...program, steps: [] }, { pin: 482913 })).rejects.toBeInstanceOf(
      TaskGoalCarriesParamError,
    );
  });

  it("the egress enforces it too, for a context no runner checked", () => {
    const ctx = {
      run_id: "r",
      step: program.steps[0]!,
      assertion: program.steps[0]!.assertion,
      failed_outcome: "LOCATOR_NOT_FOUND",
      page_state: { url: "", title: "", visible_landmarks: [], network_idle: false, captured_at: "" },
      attempt: 1,
      params: { pin: 482913 },
    } as unknown as RepairContext;
    expect(serializeRepairContext({ ...ctx, task_goal: "Enter PIN 482913." }).task_goal).toBeUndefined();
    expect(serializeRepairContext({ ...ctx, task_goal: "   " }).task_goal).toBeUndefined();
    expect(serializeRepairContext({ ...ctx, task_goal: "  Open billing.  " }).task_goal).toBe("Open billing.");
  });

  it("the prompt tells the model what the goal is for, and what it is not", () => {
    expect(REPAIR_SYSTEM_PROMPT).toContain("task_goal");
    expect(REPAIR_SYSTEM_PROMPT).toMatch(/never as a source of element names/);
  });

  it("--gate-task-goal and --task-goal are exclusive; the gate flag resolves to the shared text", async () => {
    const { parseArgs } = await import("../../experiments/gate-v1/run-matrix.js");
    expect(parseArgs(["--gate-task-goal"]).taskGoal).toBe(DEFAULT_TASK_GOAL);
    expect(parseArgs(["--task-goal", "Do X."]).taskGoal).toBe("Do X.");
    expect(() => parseArgs(["--task-goal", "Do X.", "--gate-task-goal"])).toThrow(/mutually exclusive/);
  });

  it("reads the goal a fresh baseline was measured with, so the matrix can compare", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { loadBaselineTaskGoal } = await import("../../experiments/gate-v1/run-matrix.js");
    const dir = await mkdtemp(path.join(tmpdir(), "paragent-goal-"));
    const file = path.join(dir, "baseline.json");
    await writeFile(file, JSON.stringify({ task_goal: DEFAULT_TASK_GOAL }));
    expect(await loadBaselineTaskGoal(file)).toBe(DEFAULT_TASK_GOAL);
    await writeFile(file, JSON.stringify({}));
    expect(await loadBaselineTaskGoal(file)).toBeUndefined();
  });

  it("the gate's goal is the fresh baseline's goal, from one definition", async () => {
    const fresh = await import("../../experiments/gate-v1/fresh-baseline.js");
    expect(fresh.DEFAULT_TASK_GOAL).toBe(DEFAULT_TASK_GOAL);
    expect(DEFAULT_TASK_GOAL).toContain("TestData");
  });
});
