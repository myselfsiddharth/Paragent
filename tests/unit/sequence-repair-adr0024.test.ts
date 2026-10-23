/**
 * ADR-0024 (#213): a repair may insert actions before the step's own.
 *
 * The live case: on Grafana 10.0.13 a "Select data source" modal opens with the
 * panel editor and intercepts the click on "Change Visualization". The repair
 * identified the right control, but one recorded click now needs two actions,
 * and a single-action repair could supply only one. Even when two attempts
 * happened to perform both, write-back kept the last, so the next replay met
 * the modal again.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

import { launchTestBrowser } from "../helpers/browser.js";
import { repairShapeSummary } from "../../src/metrics/aggregate.js";
import { zeroCost } from "../../src/metrics/cost.js";
import { MetricsEmitter } from "../../src/metrics/emitter.js";
import type { StepMetric } from "../../src/metrics/types.js";
import { requiredParams } from "../../src/runner/params.js";
import { rowsToProgram } from "../../src/runner/program.js";
import {
  MAX_PRE_ACTIONS,
  sanitizePreActions,
  sanitizeProposal,
  type RepairModelClient,
} from "../../src/runner/repair.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type {
  Assertion,
  CompiledAction,
  CompiledProgram,
  CompiledStep,
  RepairContext,
  RepairProposal,
  StepOutcomeObservation,
} from "../../src/runner/types.js";

const click = (name: string): CompiledAction => ({
  type: "click",
  locator_fallback_chain: [{ strategy: "role_name", role: "button", name }],
});

const CHANGE_VIZ = click("Change Visualization");
const CHOOSE_DS = click("Data source TestData");

/** "The picker opened": what step 2's click is for. Frozen under repair. */
const PICKER_OPEN: Assertion = {
  schema_version: "1.0.0",
  assertion_id: "picker-open",
  type: "element-visible",
  strength: "strong",
  target: { locator: { strategy: "role_name", role: "heading", name: "Picker" } },
  expected: { visible: true },
  timeout_ms: 1_000,
  failure_classification: "assertion_failed",
} as unknown as Assertion;

const EDITOR = `<main>
  <button aria-label="Change Visualization"
          onclick="document.getElementById('picker').hidden = false">Change Visualization</button>
  <div id="picker" hidden><h2>Picker</h2></div>
</main>`;

/** Grafana 10.0.13's shape: a full-screen dialog over the editor until a source is chosen. */
const MODAL = `<div id="modal" role="dialog" aria-label="Select data source"
     style="position:fixed;inset:0;background:rgba(0,0,0,.4)">
  <button aria-label="Data source TestData"
          onclick="document.getElementById('modal').remove()">TestData</button>
</div>`;

function program(step: Partial<CompiledStep> = {}): CompiledProgram {
  return {
    schema_version: "1.0.0",
    program_id: "adr0024",
    site_key: "local-adr0024",
    task_key: "open-picker",
    testbed_version: "n/a",
    steps: [
      { step_index: 0, compiled_action: CHANGE_VIZ, assertion: PICKER_OPEN, ...step },
    ],
  };
}

/** Proposes fixed answers in turn (the last repeats) and records what it was asked. */
class ScriptedRepair implements RepairModelClient {
  readonly seen: RepairContext[] = [];
  private readonly answers: Partial<RepairProposal>[];
  constructor(...answers: Partial<RepairProposal>[]) {
    this.answers = answers.length > 0 ? answers : [{}];
  }
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.seen.push(ctx);
    const answer = this.answers[Math.min(this.seen.length - 1, this.answers.length - 1)];
    return { corrected_action: null, tokens_in: 10, tokens_out: 5, ...answer };
  }
}

describe("sanitizePreActions / sanitizeProposal", () => {
  it("absent or null means none", () => {
    expect(sanitizePreActions(undefined)).toEqual({ actions: [] });
    expect(sanitizePreActions(null)).toEqual({ actions: [] });
  });

  it("accepts up to MAX_PRE_ACTIONS valid actions, in order", () => {
    const list = Array.from({ length: MAX_PRE_ACTIONS }, (_, i) => click(`b${i}`));
    expect(sanitizePreActions(list)).toEqual({ actions: list });
  });

  it("drops an over-long sequence whole: a bounded repair, not a re-recording", () => {
    const list = Array.from({ length: MAX_PRE_ACTIONS + 1 }, (_, i) => click(`b${i}`));
    const out = sanitizeProposal({ corrected_action: CHANGE_VIZ, pre_actions: list });
    expect(out.action).toBeNull();
    expect(out.pre_actions).toEqual([]);
    expect(out.rejected).toMatch(/max 2/);
  });

  it("drops the whole proposal when one pre-action is malformed or touches an assertion", () => {
    for (const bad of [{ type: "click" }, { ...CHOOSE_DS, assertion: {} }, "click it"]) {
      const out = sanitizeProposal({ corrected_action: CHANGE_VIZ, pre_actions: [CHOOSE_DS, bad] });
      expect(out.action).toBeNull();
      expect(out.rejected).toMatch(/pre_actions\[1\]/);
    }
  });

  it("ignores pre_actions when there is no corrected action", () => {
    expect(sanitizeProposal({ corrected_action: null, pre_actions: [CHOOSE_DS] })).toEqual({
      action: null,
      pre_actions: [],
    });
  });
});

describe("replay with pre-actions (live page)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  beforeEach(() => {
    page.setDefaultTimeout(1_500);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("the gap, before: a single-action repair cannot get past the modal", async () => {
    await page.setContent(EDITOR + MODAL);
    // The right control, alone. The modal still intercepts it.
    const repair = new ScriptedRepair({ corrected_action: CHANGE_VIZ });
    const result = await new ReplayRunner({ page, repairClient: repair, maxRepairsPerRun: 1 })
      .run(program());
    expect(result.task_success).toBe(false);
    expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
  }, 30_000);

  it("one repair inserts the choice and keeps the step's own action last", async () => {
    await page.setContent(EDITOR + MODAL);
    const repair = new ScriptedRepair({ corrected_action: CHANGE_VIZ, pre_actions: [CHOOSE_DS] });
    const observed: StepOutcomeObservation[] = [];
    const metrics = new MetricsEmitter();
    const result = await new ReplayRunner({
      page,
      repairClient: repair,
      maxRepairsPerRun: 1,
      metrics,
      onStepOutcome: (o) => observed.push(o),
    }).run(program());

    expect(result.task_success).toBe(true);
    // One proposal, one attempt: a sequence is one repair in §9's count.
    expect(result.repair_count).toBe(1);
    expect(result.steps_total).toBe(1);
    expect(result.step_results[0]).toMatchObject({ outcome: "REPAIRED_PASS", pre_action_count: 1 });

    // Persisted with the action, so the next replay does not meet the modal.
    expect(observed[0]?.repair).toMatchObject({
      corrected_action: CHANGE_VIZ,
      pre_actions: [CHOOSE_DS],
    });
    // And emitted, so a gate number that depends on insertion says so.
    const step = metrics.getRows().find((r) => r.metric_kind === "step") as StepMetric;
    expect(step.pre_action_count).toBe(1);
  }, 30_000);

  it("the assertion is checked once, after the step's own action — not after the pre-action", async () => {
    // The modal closes on the pre-action, but the picker opens only on the
    // step's action. A sequence ending on the pre-action must not pass.
    await page.setContent(EDITOR + MODAL);
    const repair = new ScriptedRepair({ corrected_action: CHOOSE_DS, pre_actions: [] });
    const result = await new ReplayRunner({ page, repairClient: repair, maxRepairsPerRun: 1 })
      .run(program());
    expect(result.task_success).toBe(false);
  }, 30_000);

  it("a repaired step replays first-pass valid, with no model call", async () => {
    await page.setContent(EDITOR + MODAL);
    const repair = new ScriptedRepair({});
    const metrics = new MetricsEmitter();
    const result = await new ReplayRunner({ page, repairClient: repair, metrics })
      .run(program({ pre_actions: [CHOOSE_DS] }));

    expect(result.task_success).toBe(true);
    expect(result.steps_replay_valid).toBe(1);
    expect(result.repair_count).toBe(0);
    expect(repair.seen).toHaveLength(0);
    const step = metrics.getRows().find((r) => r.metric_kind === "step") as StepMetric;
    expect(step).toMatchObject({ outcome: "PASS", replay_valid: true, pre_action_count: 1 });
  }, 30_000);

  it("when churn takes the inserted action away, a repair clears it", async () => {
    // The modal is gone (say, a version that remembers the default source).
    // The stored pre-action no longer resolves; the step's own action alone works.
    await page.setContent(EDITOR);
    const repair = new ScriptedRepair({ corrected_action: CHANGE_VIZ });
    const observed: StepOutcomeObservation[] = [];
    const result = await new ReplayRunner({
      page,
      repairClient: repair,
      maxRepairsPerRun: 1,
      onStepOutcome: (o) => observed.push(o),
    }).run(program({ pre_actions: [CHOOSE_DS] }));

    expect(result.step_results[0]?.outcome).toBe("REPAIRED_PASS");
    expect(result.step_results[0]?.pre_action_count).toBeUndefined();
    // Empty, not absent: this is what tells the cache to drop the old one.
    expect(observed[0]?.repair?.pre_actions).toEqual([]);
  }, 30_000);

  it("keeps recorded pre-actions that ran before the failure, in front of the repair's", async () => {
    // A second inserted step appeared after the first one was recorded.
    const second = `<div id="tip" role="dialog" style="position:fixed;inset:0">
      <button aria-label="Got it" onclick="document.getElementById('tip').remove()">ok</button></div>`;
    await page.setContent(EDITOR + second + MODAL);
    const repair = new ScriptedRepair({ corrected_action: CHANGE_VIZ, pre_actions: [click("Got it")] });
    const observed: StepOutcomeObservation[] = [];
    const result = await new ReplayRunner({
      page,
      repairClient: repair,
      maxRepairsPerRun: 1,
      onStepOutcome: (o) => observed.push(o),
    }).run(program({ pre_actions: [CHOOSE_DS] }));

    expect(result.step_results[0]?.outcome).toBe("REPAIRED_PASS");
    expect(observed[0]?.repair?.pre_actions).toEqual([CHOOSE_DS, click("Got it")]);
    // The metric counts what the step needed in this run, kept and proposed:
    // the same count the rewritten row records (review of #223).
    expect(result.step_results[0]?.pre_action_count).toBe(2);
  }, 30_000);

  it("an over-bound proposal spends one attempt, not the step", async () => {
    // Review of #223: this used to end the repair loop outright.
    await page.setContent(EDITOR + MODAL);
    const repair = new ScriptedRepair(
      { corrected_action: CHANGE_VIZ, pre_actions: [click("x"), click("y")] },
      { corrected_action: CHANGE_VIZ },
    );
    const result = await new ReplayRunner({ page, repairClient: repair, maxRepairsPerRun: 2 })
      .run(program({ pre_actions: [CHOOSE_DS], compiled_action: click("Missing") }));
    expect(repair.seen).toHaveLength(2);
    expect(result.step_results[0]).toMatchObject({ outcome: "REPAIRED_PASS", repair_attempt: 2 });
  }, 30_000);

  it("refuses a repair that would take the step past the bound", async () => {
    await page.setContent(EDITOR + MODAL);
    const repair = new ScriptedRepair({
      corrected_action: CHANGE_VIZ,
      pre_actions: [click("x"), click("y")],
    });
    // One recorded pre-action ran (TestData), so two more would make three.
    const result = await new ReplayRunner({ page, repairClient: repair, maxRepairsPerRun: 1 })
      .run(program({ pre_actions: [CHOOSE_DS], compiled_action: click("Missing") }));
    expect(result.step_results[0]?.outcome).toBe("REPAIR_EXHAUSTED");
    expect(result.step_results[0]?.error_message).toMatch(/3 pre-actions \(max 2\)/);
  }, 30_000);
});

describe("pre-actions survive the program adapters and declare their params", () => {
  it("rowsToProgram carries a repaired row's pre-actions", () => {
    const p = rowsToProgram(
      {
        program_id: "p",
        site_key: "s",
        task_key: "t",
        rows: [{ step_index: 0, pre_actions: [CHOOSE_DS], compiled_action: CHANGE_VIZ, assertion: PICKER_OPEN }],
      },
      "v",
    );
    expect(p.steps[0]?.pre_actions).toEqual([CHOOSE_DS]);
  });

  it("refuses a program whose pre-actions break the rule a repair is held to", () => {
    // Review of #223: validated at load, not discovered mid-run.
    const rows = (pre: unknown) => ({
      program_id: "p",
      site_key: "s",
      task_key: "t",
      rows: [{ step_index: 0, pre_actions: pre, compiled_action: CHANGE_VIZ, assertion: PICKER_OPEN }],
    });
    expect(() => rowsToProgram(rows([CHOOSE_DS, CHOOSE_DS, CHOOSE_DS]), "v")).toThrow(/max 2/);
    expect(() => rowsToProgram(rows([{ type: "click" }]), "v")).toThrow(/pre_actions\[0\]/);
    expect(() => rowsToProgram(rows("click it"), "v")).toThrow(/not an array/);
    expect(rowsToProgram(rows(undefined), "v").steps[0]?.pre_actions).toBeUndefined();
  });

  it("a pre-action's param slots are required before the run starts", () => {
    const fill: CompiledAction = { ...click("Search"), type: "fill", param_refs: ["query"] };
    expect(requiredParams(program({ pre_actions: [fill] }))).toEqual(["query"]);
  });
});

describe("the §9 report says how many steps rest on inserted actions", () => {
  const step = (over: Partial<StepMetric>): StepMetric => ({
    schema_version: "1.0.0",
    metric_kind: "step",
    run_id: "r",
    site_key: "s",
    task_key: "t",
    step_index: 0,
    testbed_version: "v",
    outcome: "PASS",
    replay_valid: true,
    mode: "replay",
    cost: zeroCost(),
    recorded_at: "2026-10-22T00:00:00.000Z",
    ...over,
  });

  it("counts repaired steps with and without pre-actions, and first-pass steps that ran them", () => {
    expect(
      repairShapeSummary([
        step({}),
        step({ pre_action_count: 1 }),
        step({ outcome: "REPAIRED_PASS", replay_valid: false, mode: "repair", pre_action_count: 1 }),
        step({ outcome: "REPAIRED_PASS", replay_valid: false, mode: "repair" }),
      ]),
    ).toEqual({
      steps_repaired: 2,
      steps_repaired_with_pre_actions: 1,
      steps_replay_valid_with_pre_actions: 1,
      status: "computed",
    });
  });

  it("is no_data with no step rows, never zeroes that read as measured", () => {
    expect(repairShapeSummary([]).status).toBe("no_data");
  });
});
