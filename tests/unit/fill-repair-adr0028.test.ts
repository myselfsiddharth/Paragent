/**
 * ADR-0028: a repaired fill types the step's own value.
 *
 * Found by the first glm-5-3 matrix (2026-10-22): all 36 runs on 10.0.13 to
 * 12.2.1 stopped at step 6 ("Title the panel"). The repair model is never
 * shown the step's param_refs, so its corrected fill had none, and replay
 * failed with "fill missing bound param value" whatever field it chose.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

import { launchTestBrowser } from "../helpers/browser.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type {
  CompiledAction,
  CompiledProgram,
  RepairContext,
  RepairProposal,
  StepOutcomeObservation,
} from "../../src/runner/types.js";

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
        type: "fill",
        param_refs: ["panel_title"],
        locator_fallback_chain: [{ strategy: "role_name", role: "textbox", name: "Old title field" }],
      },
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "element-visible",
        strength: "weak",
        target: { locator_ref: "action_target" },
        expected: { visible: true },
        timeout_ms: 1_000,
        failure_classification: "assertion_failed",
      },
    },
  ],
};

const TITLE_FIELD: CompiledAction = {
  type: "fill",
  locator_fallback_chain: [{ strategy: "role_name", role: "textbox", name: "Panel title" }],
};

class Proposes implements RepairModelClient {
  seen?: RepairContext;
  constructor(private readonly action: CompiledAction) {}
  async propose(ctx: RepairContext): Promise<RepairProposal> {
    this.seen = ctx;
    return { corrected_action: this.action, tokens_in: 1, tokens_out: 1 };
  }
}

describe("a repaired fill is bound to the step's own slots (ADR-0028)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    page.setDefaultTimeout(500);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    ["no param_refs (what the model sends today)", TITLE_FIELD],
    ["a different slot the model made up", { ...TITLE_FIELD, param_refs: ["series_alias"] }],
  ])("types the step's value when the proposal carries %s", async (_label, proposed) => {
    await page.setContent(`<main><label>Panel title <input id="t"></label><label>Alias <input id="a"></label></main>`);
    const observed: StepOutcomeObservation[] = [];
    const result = await new ReplayRunner({
      page,
      repairClient: new Proposes(proposed as CompiledAction),
      onStepOutcome: (o) => observed.push(o),
    }).run(program, { panel_title: "Gate Panel", series_alias: "gate" });

    expect(result.step_results[0]?.outcome).toBe("REPAIRED_PASS");
    expect(await page.inputValue("#t")).toBe("Gate Panel");
    expect(await page.inputValue("#a")).toBe("");
    // And it is persisted bound to the step's slot, so the cached row replays.
    expect(observed[0]?.repair?.corrected_action.param_refs).toEqual(["panel_title"]);
  }, 30_000);

  it("leaves a corrected click alone", async () => {
    await page.setContent(`<main><button aria-label="Go">go</button></main>`);
    const click: CompiledAction = {
      type: "click",
      locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Go" }],
    };
    const observed: StepOutcomeObservation[] = [];
    await new ReplayRunner({
      page,
      repairClient: new Proposes(click),
      onStepOutcome: (o) => observed.push(o),
    }).run({ ...program, steps: [{ ...program.steps[0]!, compiled_action: { ...click, locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Gone" }] } }] });
    expect(observed[0]?.repair?.corrected_action).toEqual(click);
  }, 30_000);
});
