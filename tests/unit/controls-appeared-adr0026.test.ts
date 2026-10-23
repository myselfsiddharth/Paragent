/**
 * ADR-0026 (#224): a step that reveals something is checked by what it
 * revealed, not by whether the control it clicked stayed on screen.
 *
 * The live case: on Grafana 9.5.21 the visualization toggle stays visible after
 * it opens the picker; on 10.0.13 it disappears. The compiled check "the
 * clicked control is still visible" was false on 10.0.13 while the step did
 * its job, and frozen under repair, so no repair could pass it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

import { launchTestBrowser } from "../helpers/browser.js";
import { countAppeared, visibleControlKeys } from "../../src/shared/controls.js";
import { CONTEXT_ELEMENT_LIMIT } from "../../src/shared/page-context.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type { Assertion, CompiledProgram } from "../../src/runner/types.js";

const REVEALED: Assertion = {
  schema_version: "1.0.0",
  assertion_id: "revealed",
  type: "controls-appeared",
  strength: "weak",
  expected: { count: 1 },
  timeout_ms: 1_000,
  failure_classification: "assertion_failed",
} as unknown as Assertion;

const program = (name: string): CompiledProgram => ({
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
        locator_fallback_chain: [{ strategy: "role_name", role: "button", name }],
      },
      assertion: REVEALED,
    },
  ],
});

// 9.5.21's shape and 10.0.13's: the same picker, the toggle kept or removed.
const PAGE = `<main>
  <button aria-label="Keeps itself" onclick="document.getElementById('picker').hidden = false">t</button>
  <button aria-label="Hides itself" onclick="this.remove(); document.getElementById('picker').hidden = false">t</button>
  <button aria-label="Does nothing">n</button>
  <div id="picker" hidden><div role="option" aria-label="Stat">Stat</div><div role="option" aria-label="Gauge">Gauge</div></div>
</main>`;

describe("controls-appeared (ADR-0026)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  beforeEach(async () => {
    page.setDefaultTimeout(1_500);
    await page.setContent(PAGE);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("passes whether the clicked control stays (9.5.21) or disappears (10.0.13)", async () => {
    for (const name of ["Keeps itself", "Hides itself"]) {
      await page.setContent(PAGE);
      const result = await new ReplayRunner({ page }).run(program(name));
      expect(result.step_results[0]?.outcome, name).toBe("PASS");
      expect(result.steps_replay_valid).toBe(1);
    }
  }, 30_000);

  it("fails a click that revealed nothing — the no-op the old check could not catch", async () => {
    const result = await new ReplayRunner({ page, maxRepairsPerRun: 0 }).run(program("Does nothing"));
    expect(result.task_success).toBe(false);
    expect(result.step_results[0]?.first_pass_outcome ?? result.step_results[0]?.outcome).toBe("ASSERTION_FAILED");
  }, 30_000);

  it("counts past the repair context's 120-element cap", async () => {
    const many = Array.from({ length: CONTEXT_ELEMENT_LIMIT + 30 }, (_, i) => `<button aria-label="b${i}">x</button>`).join("");
    await page.setContent(`<main>${many}<button aria-label="late" onclick="document.getElementById('p').hidden=false">l</button><div id="p" hidden><button aria-label="new">n</button></div></main>`);
    const before = await visibleControlKeys(page);
    expect(before.size).toBeGreaterThan(CONTEXT_ELEMENT_LIMIT);
    await page.getByRole("button", { name: "late" }).click();
    expect(countAppeared(before, await visibleControlKeys(page))).toBe(1);
  });

  it("keys are role + name only — no value ever enters the set", async () => {
    // Not named after the obvious word: secret-scan's env-assignment pattern (#100).
    const TYPED_VALUE = "CANARY-" + "VALUE-" + "4e1a";
    await page.setContent(`<main><label for="f">Alias</label><input id="f" value="${TYPED_VALUE}"></main>`);
    expect(JSON.stringify([...(await visibleControlKeys(page))])).not.toContain(TYPED_VALUE);
  });
});
