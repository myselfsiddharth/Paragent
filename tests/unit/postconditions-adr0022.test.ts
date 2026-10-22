/**
 * ADR-0022 (#211): post-conditions that churn cannot break for the wrong reason.
 *
 * The first live matrix (docs/gate/gate-result-2026-10-17.md) failed every pin
 * after 9.5.21 on a post-condition, never on an action:
 *  - 10.x–11.0: an element check pinned to a structural CSS path;
 *  - 11.5.2+:   a URL regex anchored on the whole query, rejecting view state.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { urlRegexTemplate } from "../../src/compiler/assertions.js";
import { executeAction } from "../../src/runner/actions.js";
import { evaluateAssertion } from "../../src/runner/assertions.js";
import type { Assertion, CompiledAction } from "../../src/runner/types.js";

const trajectory = JSON.parse(
  readFileSync("experiments/gate-v1/trajectories/grafana-create-stat-dashboard-from-testdata-9.5.21-r2.json", "utf8"),
);
const H = "http://127.0.0.1:3000";
const re = (tpl: string) => new RegExp(urlRegexTemplate(tpl, trajectory));

describe("url-matches: recorded keys required, state-bearing keys enforced, view state ignored", () => {
  const DASH = "http://{host}:{port}/dashboard/new?orgId=1";
  const EDIT = "http://{host}:{port}/dashboard/new?orgId=1&editPanel=1";

  it("accepts the recorded URL", () => {
    expect(re(DASH).test(`${H}/dashboard/new?orgId=1`)).toBe(true);
  });

  it("accepts view state the recording never distinguished (Grafana 11.5.2+)", () => {
    expect(re(DASH).test(`${H}/dashboard/new?orgId=1&from=now-6h&to=now&timezone=browser`)).toBe(true);
  });

  it("REJECTS a state-bearing key the step did not record — a failed Apply still fails", () => {
    // The recording saw /dashboard/new both with and without editPanel, so it
    // distinguishes states there. This is the weakening a plain subset match
    // would have introduced.
    expect(re(DASH).test(`${H}/dashboard/new?orgId=1&editPanel=1`)).toBe(false);
    expect(re(DASH).test(`${H}/dashboard/new?from=now-6h&orgId=1&editPanel=1&to=now`)).toBe(false);
  });

  it("requires every recorded key with its recorded value", () => {
    expect(re(EDIT).test(`${H}/dashboard/new?orgId=1`)).toBe(false);
    expect(re(DASH).test(`${H}/dashboard/new?orgId=2`)).toBe(false);
    expect(re(DASH).test(`${H}/dashboard/new?orgId=10`)).toBe(false);
    expect(re(EDIT).test(`${H}/dashboard/new?orgId=1&editPanel=1&from=now-6h`)).toBe(true);
  });

  it("keeps the path exact, holes included", () => {
    expect(re(DASH).test(`${H}/dashboard/newer?orgId=1`)).toBe(false);
    const D = "http://{host}:{port}/d/{dashboard_uid}/{dashboard_slug}?orgId=1";
    expect(re(D).test(`${H}/d/abc123/gate-1?orgId=1&from=now-6h`)).toBe(true);
    expect(re(D).test(`${H}/d/abc123?orgId=1`)).toBe(false);
  });

  it("a query-less path tolerates view state but not a deeper path", () => {
    const L = "http://{host}:{port}/dashboards";
    expect(re(L).test(`${H}/dashboards`)).toBe(true);
    expect(re(L).test(`${H}/dashboards?orgId=1`)).toBe(true);
    expect(re(L).test(`${H}/dashboards/f/abc`)).toBe(false);
  });
});

describe("element-visible { locator_ref: action_target }", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const visible = (v: boolean): Assertion =>
    ({
      schema_version: "1.0.0", assertion_id: "a", type: "element-visible", strength: "weak",
      target: { locator_ref: "action_target" }, expected: { visible: v },
      timeout_ms: 1500, failure_classification: "assertion_failed",
    }) as unknown as Assertion;

  it("survives a layout change that would break a copied structural path", async () => {
    // Same control, wrapped in an extra div: a body-rooted path no longer matches.
    await page.setContent(`<main><div><div><button>Change Visualization</button></div></div></main>`);
    const action: CompiledAction = {
      type: "click",
      locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Change Visualization" }],
    };
    const r = await executeAction(page, action, {});
    expect(r.ok).toBe(true);
    expect((await evaluateAssertion(page, visible(true), {}, { actionTarget: r.target! })).outcome).toBe("PASS");
  });

  it("follows a REPAIRED action — the check is about whatever element the action now targets", async () => {
    await page.setContent(`<button>Change Visualization</button>`);
    const repaired: CompiledAction = {
      type: "click",
      locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Change Visualization" }],
    };
    const r = await executeAction(page, repaired, {});
    expect((await evaluateAssertion(page, visible(true), {}, { actionTarget: r.target! })).outcome).toBe("PASS");
  });

  it("'gone' means THAT element no longer matches — not that some fallback element is hidden", async () => {
    await page.setContent(`
      <div aria-label="Plugin visualization item Stat" style="cursor:pointer" onclick="this.remove()">Stat</div>
      <div class="card">a visible decoy a looser strategy could find</div>`);
    const action: CompiledAction = {
      type: "click",
      locator_fallback_chain: [
        { strategy: "label", label: "Plugin visualization item Stat" },
        { strategy: "css_vocab", css: ".card" },
      ],
    };
    const r = await executeAction(page, action, {});
    expect((await evaluateAssertion(page, visible(false), {}, { actionTarget: r.target! })).outcome).toBe("PASS");
  });

  it("still FAILS when the acted-on control did not disappear — not weakened", async () => {
    await page.setContent(`<button>Stays</button>`);
    const r = await executeAction(page, { type: "click", locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Stays" }] }, {});
    // Reported as TIMEOUT (the wait for "hidden" ran out), exactly as a copied-
    // locator visibility check reports it. What matters: it does not PASS.
    const res = await evaluateAssertion(page, visible(false), {}, { actionTarget: r.target! });
    expect(res.outcome).not.toBe("PASS");
    expect(res.outcome).toBe("TIMEOUT");
  });

  it("fails closed when no action target was resolved", async () => {
    await page.setContent(`<button>x</button>`);
    const res = await evaluateAssertion(page, visible(true), {});
    expect(res.outcome).toBe("ASSERTION_FAILED");
    expect(res.message).toContain("resolved no locator");
  });
});
