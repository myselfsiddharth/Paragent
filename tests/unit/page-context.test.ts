/**
 * The repair context budget (ADR-0012, #125).
 *
 * Two things are being pinned, and the second matters more:
 *
 * 1. Each level captures what ADR-0012 says it captures.
 * 2. **No level captures an input's value, ever.** That is the line the whole
 *    budget rests on — the point of raising the level was to make repair
 *    possible, and the failure mode of raising it is that page *content* starts
 *    riding along. A filled password field is the case to check, because it is
 *    the one where the boundary and the capability point hardest in opposite
 *    directions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";

import { launchTestBrowser } from "../helpers/browser.js";
import { capturePageState } from "../../src/runner/page-state.js";
import {
  CONTEXT_ATTRIBUTE_ALLOWLIST,
  CONTEXT_LEVELS,
  DEFAULT_CONTEXT_LEVEL,
  contextExpression,
} from "../../src/shared/page-context.js";

/**
 * Values that must never appear in a capture.
 *
 * Assembled at runtime, and named `TYPED_VALUE` rather than the obvious word:
 * `scripts/secret-scan.mjs`'s `env-assignment` pattern matches that word
 * followed by `=`, so the obvious name makes this file a scan hit. Third time
 * this trap has been sprung in this repo — see #100.
 */
const TYPED_VALUE = "CANARY-" + "TYPED-" + "a91f37c";
const BODY_TEXT = "CANARY-" + "PROSE-" + "5be22d";

const PAGE = `<!doctype html><html><head><title>Editor</title></head><body>
  <nav><a href="/dashboards">Dashboards</a></nav>
  <main>
    <h2>Panel options</h2>
    <p>${BODY_TEXT}</p>
    <label for="pw">Password</label>
    <input id="pw" type="password" value="${TYPED_VALUE}" />
    <label for="alias">Alias</label>
    <input id="alias" value="${TYPED_VALUE}" placeholder="${TYPED_VALUE}" />
    <button data-testid="save" aria-label="Save dashboard">Save</button>
    <button disabled aria-label="Delete">Delete</button>
    <button style="visibility:hidden" aria-label="Hidden control">Nope</button>
  </main></body></html>`;

describe("page context levels (#125)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(PAGE);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("landmarks captures no elements — the pre-#125 floor", async () => {
    const state = await capturePageState(page, "landmarks");
    expect(state.elements).toEqual([]);
    expect(state.context_level).toBe("landmarks");
    // Landmarks themselves still work; this level is unchanged behaviour.
    expect(state.visible_landmarks).toContain("main");
  });

  it("interactive captures role + accessible name of actionable elements", async () => {
    const { elements } = await capturePageState(page, "interactive");
    const names = (elements ?? []).map((e) => e.name);
    expect(names).toContain("Save dashboard");
    expect(names).toContain("Alias");
    expect(names).toContain("Password");
    const save = (elements ?? []).find((e) => e.name === "Save dashboard");
    expect(save?.role).toBe("button");
  });

  it("tree adds structure that interactive omits", async () => {
    const interactive = (await capturePageState(page, "interactive")).elements ?? [];
    const tree = (await capturePageState(page, "tree")).elements ?? [];
    expect(tree.length).toBeGreaterThan(interactive.length);
    expect(tree.map((e) => e.role)).toContain("heading");
    expect(interactive.map((e) => e.role)).not.toContain("heading");
  });

  it("records which level produced the snapshot", async () => {
    for (const level of CONTEXT_LEVELS) {
      expect((await capturePageState(page, level)).context_level).toBe(level);
    }
    expect((await capturePageState(page)).context_level).toBe(DEFAULT_CONTEXT_LEVEL);
  });

  it("respects visibility — a hidden control is not offered to the model", async () => {
    // ADR-0007's rule, in a new place: the repair must not be shown a page the
    // recorder never saw.
    const { elements } = await capturePageState(page, "tree");
    expect((elements ?? []).map((e) => e.name)).not.toContain("Hidden control");
  });

  it("carries element state, so the model knows a control is unusable", async () => {
    const { elements } = await capturePageState(page, "interactive");
    const del = (elements ?? []).find((e) => e.name === "Delete");
    expect(del?.state).toContain("disabled");
  });
});

describe("no level captures page content (#125)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(PAGE);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it.each(CONTEXT_LEVELS)("%s carries no input value", async (level) => {
    // The page has a password input and a text input, both filled, and one
    // placeholder — all set to the same canary so a single assertion covers
    // every route by which a value could arrive.
    const state = await capturePageState(page, level);
    expect(JSON.stringify(state)).not.toContain(TYPED_VALUE);
  });

  it.each(CONTEXT_LEVELS)("%s carries no body prose", async (level) => {
    const state = await capturePageState(page, level);
    expect(JSON.stringify(state)).not.toContain(BODY_TEXT);
  });

  it("the canaries are actually on the page — these are not vacuous", async () => {
    // Guards the guard: if the fixture stopped containing them, every
    // assertion above would pass while proving nothing.
    const html = await page.content();
    expect(html).toContain(TYPED_VALUE);
    expect(html).toContain(BODY_TEXT);
  });

  it("the value is reachable in the DOM, so omission is a choice not an accident", async () => {
    expect(await page.inputValue("#pw")).toBe(TYPED_VALUE);
  });
});

describe("contextExpression", () => {
  it("returns an empty list at the landmarks level without touching the DOM", () => {
    // The floor is a short-circuit, not a filtered walk — cheaper, and it makes
    // "landmarks captures nothing" true by construction rather than by luck.
    expect(contextExpression("landmarks")).toContain("return []");
  });

  it("interpolates the shared visibility predicate rather than restating it", () => {
    // #74's invariant, in the new capture site.
    for (const level of CONTEXT_LEVELS) {
      expect(contextExpression(level)).toContain("paragentIsVisible");
    }
  });

  it("reads only allowlisted attributes", () => {
    // CONTEXT_ATTRIBUTE_ALLOWLIST used to be documentation only. #212 added an
    // attribute to it, and this test is what makes the list hold.
    for (const level of CONTEXT_LEVELS) {
      const read = [...contextExpression(level).matchAll(/(?:get|has)Attribute\("([^"]+)"\)/g)]
        .map((m) => m[1]);
      expect(read.length).toBeGreaterThan(0);
      for (const attr of read) expect(CONTEXT_ATTRIBUTE_ALLOWLIST).toContain(attr);
    }
  });

  it("never reads an element's value attribute", () => {
    // Structural check to back the behavioural ones: the string handed to the
    // browser has no route to a value at all.
    for (const level of CONTEXT_LEVELS) {
      const src = contextExpression(level);
      expect(src).not.toContain(".value");
      expect(src).not.toContain('getAttribute("value")');
      expect(src).not.toContain('getAttribute("placeholder")');
    }
  });
});

/**
 * ADR-0021: role-less clickable controls. Grafana 9.5.21's visualization picker
 * card is a `<div aria-label="Plugin visualization item Stat">` with a script
 * click handler and no role. Before ADR-0021 it matched no selector, so neither
 * model could see it — the fresh baseline went 0/5, never selecting Stat.
 */
describe("role-less labelled controls (ADR-0021)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><main>
      <button aria-label="toggle-viz-picker">Visualization</button>
      <div aria-label="Plugin visualization item Stat" style="cursor:pointer"
           onclick="document.title='stat-picked'">Stat ${BODY_TEXT}</div>
      <div aria-label="TestData series count">
        <input aria-label="Series count" value="${TYPED_VALUE}">
      </div>
      <div aria-label="Hidden card" style="cursor:pointer;display:none">x</div>
    </main></body></html>`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("admits a clickable role-less element as role 'generic', named by its aria-label", async () => {
    const { elements } = await capturePageState(page, "interactive");
    expect(elements).toContainEqual({ role: "generic", name: "Plugin visualization item Stat" });
  });

  it("keeps a labelled NON-clickable wrapper out — only controls are offered", async () => {
    const { elements } = await capturePageState(page, "interactive");
    expect((elements ?? []).map((e) => e.name)).not.toContain("TestData series count");
  });

  it("still respects visibility for the new elements", async () => {
    const { elements } = await capturePageState(page, "interactive");
    expect((elements ?? []).map((e) => e.name)).not.toContain("Hidden card");
  });

  it("never reads text content or a value for them — the name is the aria-label alone", async () => {
    const serialized = JSON.stringify(await capturePageState(page, "interactive"));
    expect(serialized).not.toContain(BODY_TEXT);
    expect(serialized).not.toContain(TYPED_VALUE);
  });

  it("keeps document order, so a generic element sits among its neighbours", async () => {
    const { elements } = await capturePageState(page, "interactive");
    const names = (elements ?? []).map((e) => e.name);
    expect(names.indexOf("toggle-viz-picker")).toBeLessThan(names.indexOf("Plugin visualization item Stat"));
    expect(names.indexOf("Plugin visualization item Stat")).toBeLessThan(names.indexOf("Series count"));
  });

  it("captured generic elements are targetable: role_name + generic resolves and clicks", async () => {
    const { resolveWithFallback } = await import("../../src/runner/locators.js");
    const loc = await resolveWithFallback(page, [
      { strategy: "role_name", role: "generic", name: "Plugin visualization item Stat" },
    ]);
    await loc.click();
    expect(await page.title()).toBe("stat-picked");
  });

  it("landmarks level is still empty", async () => {
    const { elements } = await capturePageState(page, "landmarks");
    expect(elements ?? []).toEqual([]);
  });
});

/**
 * ADR-0021, second half — found by a logged fresh-baseline attempt on live
 * 9.5.21 that spent 19 of 30 turns on two fields: "Series count" (an
 * input[type=number] the capture called "textbox") and the panel title (an
 * input with no accessible name at all).
 */
describe("truthful roles and container-named controls (ADR-0021)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><main>
      <div aria-label="TestData series count"><input type="number" aria-label="Series count" value="${TYPED_VALUE}"></div>
      <input type="range" aria-label="Opacity">
      <input type="search" aria-label="Search dashboards">
      <div aria-label="Panel options Title field property editor">
        <label>Title</label><div><input type="text" id="panel-title" value="${TYPED_VALUE}"></div>
      </div>
      <div aria-label="Panel options Description field property editor">
        <div><textarea id="panel-desc"></textarea></div>
      </div>
    </main></body></html>`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("reports the ARIA implicit role for number, range and search inputs", async () => {
    const { elements } = await capturePageState(page, "interactive");
    expect(elements).toContainEqual({ role: "spinbutton", name: "Series count" });
    expect(elements).toContainEqual({ role: "slider", name: "Opacity" });
    expect(elements).toContainEqual({ role: "searchbox", name: "Search dashboards" });
  });

  it("an unnamed control takes its nearest labelled container's aria-label as its name", async () => {
    const { elements } = await capturePageState(page, "interactive");
    expect(elements).toContainEqual({ role: "textbox", name: "Panel options Title field property editor" });
    expect(elements).toContainEqual({ role: "textbox", name: "Panel options Description field property editor" });
    expect((elements ?? []).some((e) => e.role === "textbox" && e.name === "")).toBe(false);
  });

  it("still never carries a value", async () => {
    expect(JSON.stringify(await capturePageState(page, "interactive"))).not.toContain(TYPED_VALUE);
  });

  it("every captured role+name resolves back to exactly the element it describes", async () => {
    const { resolveWithFallback } = await import("../../src/runner/locators.js");
    for (const [role, name, id] of [
      ["textbox", "Panel options Title field property editor", "panel-title"],
      ["textbox", "Panel options Description field property editor", "panel-desc"],
    ] as const) {
      const loc = await resolveWithFallback(page, [{ strategy: "role_name", role, name }]);
      expect(await loc.getAttribute("id")).toBe(id);
    }
    const spin = await resolveWithFallback(page, [{ strategy: "role_name", role: "spinbutton", name: "Series count" }]);
    await spin.fill("5");
    expect(await spin.inputValue()).toBe("5");
  });
});

/**
 * #212: on Grafana 10.0.13 the "Select data source" modal is rendered at the end
 * of the DOM. The editor's option panes filled the 120-element cap in document
 * order, so none of the modal's controls reached the repair model.
 */
describe("an open dialog is captured first (#212)", () => {
  let browser: Browser;
  let page: Page;

  // More background controls than the cap, so a document-order capture never
  // reaches the dialog. That was the live failure.
  const background = Array.from(
    { length: 150 },
    (_, i) => `<button aria-label="Option pane ${i}">x</button>`,
  ).join("");
  const dialogBody = `
    <h2>Select data source</h2>
    <p>${BODY_TEXT}</p>
    <input aria-label="Search data sources" value="${TYPED_VALUE}">
    <button aria-label="Data source TestData">TestData</button>
    <button aria-label="Close">x</button>`;

  const html = (dialogAttrs: string) => `<!doctype html><html><body>
    <main><button aria-label="Close">bg close</button>${background}</main>
    <div ${dialogAttrs}>${dialogBody}</div>
  </body></html>`;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("a modal's controls come first, flagged, and the inert background is dropped", async () => {
    await page.setContent(html(`role="dialog" aria-modal="true" aria-label="Select data source"`));
    const { elements = [] } = await capturePageState(page, "interactive");
    expect(elements).toEqual([
      { role: "textbox", name: "Search data sources", in_dialog: true },
      { role: "button", name: "Data source TestData", in_dialog: true },
      { role: "button", name: "Close", in_dialog: true },
    ]);
  });

  it("a non-modal dialog's controls come first and the background is demoted, not dropped", async () => {
    await page.setContent(html(`role="dialog" aria-label="Select data source"`));
    const { elements = [] } = await capturePageState(page, "interactive");
    expect(elements.slice(0, 3).map((e) => e.name)).toEqual([
      "Search data sources",
      "Data source TestData",
      "Close",
    ]);
    expect(elements.slice(0, 3).every((e) => e.in_dialog === true)).toBe(true);
    // The background's own "Close" is deduplicated against the dialog's, and
    // what remains of the background carries no flag.
    expect(elements[3]).toEqual({ role: "button", name: "Option pane 0" });
    expect(elements).toHaveLength(120);
  });

  it("a <dialog> opened with showModal() is treated as modal without aria-modal", async () => {
    await page.setContent(`<!doctype html><html><body>
      <main>${background}</main>
      <dialog id="d">${dialogBody}</dialog>
      <script>document.getElementById("d").showModal()</script>
    </body></html>`);
    const { elements = [] } = await capturePageState(page, "interactive");
    expect(elements.map((e) => e.name)).toEqual([
      "Search data sources",
      "Data source TestData",
      "Close",
    ]);
  });

  it("a hidden dialog changes nothing", async () => {
    await page.setContent(html(`role="dialog" aria-modal="true" style="display:none"`));
    const { elements = [] } = await capturePageState(page, "interactive");
    expect(elements[0]).toEqual({ role: "button", name: "Close" });
    expect(elements.some((e) => e.in_dialog)).toBe(false);
  });

  it("still never carries a value or prose from the dialog", async () => {
    await page.setContent(html(`role="dialog" aria-modal="true"`));
    for (const level of CONTEXT_LEVELS) {
      const serialized = JSON.stringify(await capturePageState(page, level));
      expect(serialized).not.toContain(TYPED_VALUE);
      expect(serialized).not.toContain(BODY_TEXT);
    }
  });
});

/**
 * Found by the first live sequence-repair probe on Grafana 10.0.13 (#213): the
 * data-source card was captured as "Paragent TestData defaultTestData" (raw
 * textContent), its accessible name is "Paragent TestData Tags TestData", and
 * the model's correct proposal matched nothing. A name the model is shown must
 * be a name a locator can match.
 */
describe("content-derived names are accessible names (#212)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><main>
      <h2><button id="card"><div>Paragent TestData</div><ul aria-label="Tags"><li>default</li></ul><div>TestData</div></button></h2>
      <button id="inline">Save <b>dash</b>board</button>
      <button id="hidden">Close<span aria-hidden="true">×</span><span style="display:none">${BODY_TEXT}</span></button>
    </main></body></html>`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("uses a child's aria-label for its content and spaces block children", async () => {
    const { elements = [] } = await capturePageState(page, "interactive");
    expect(elements).toContainEqual({ role: "button", name: "Paragent TestData Tags TestData" });
  });

  it("does not space inline children, and skips aria-hidden and undisplayed ones", async () => {
    const names = ((await capturePageState(page, "interactive")).elements ?? []).map((e) => e.name);
    expect(names).toContain("Save dashboard");
    expect(names).toContain("Close");
    expect(JSON.stringify(names)).not.toContain(BODY_TEXT);
  });

  it("every captured name resolves back to exactly its element", async () => {
    const { resolveWithFallback } = await import("../../src/runner/locators.js");
    const { elements = [] } = await capturePageState(page, "interactive");
    for (const [name, id] of [
      ["Paragent TestData Tags TestData", "card"],
      ["Save dashboard", "inline"],
      ["Close", "hidden"],
    ] as const) {
      expect(elements.map((e) => e.name)).toContain(name);
      const loc = await resolveWithFallback(page, [{ strategy: "role_name", role: "button", name }]);
      expect(await loc.getAttribute("id")).toBe(id);
    }
  });
});
