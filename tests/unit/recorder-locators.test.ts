/**
 * Recorder locator candidates — the properties the first live replay of the
 * gate bundle on 9.5.21 showed were missing:
 *
 * 1. A structural path cut off at the depth cap must not claim to start at
 *    <body>. Steps 5 and 6 of the gate bundle were both exactly at the cap and
 *    matched nothing on their own recording version.
 * 2. An element with no accessible name gets an anchored `css_vocab` candidate
 *    from its nearest aria-labelled ancestor (Grafana's panel-title input).
 * 3. Every candidate emitted resolves back to the element it came from — the
 *    property that, had it been tested, would have caught (1) at record time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { collectLocatorCandidates } from "../../src/recorder/locators.js";
import { resolveLocator } from "../../src/runner/locators.js";
import type { LocatorSpec } from "../../src/runner/types.js";

/** `depth` nested divs around `inner`, each with a sibling so nth-of-type is exercised. */
function nest(depth: number, inner: string): string {
  let html = inner;
  for (let i = 0; i < depth; i++) html = `<div><span></span>${html}</div>`;
  return html;
}

describe("collectLocatorCandidates", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function roundTrip(selector: string) {
    const target = page.locator(selector);
    const candidates = await collectLocatorCandidates(target);
    for (const c of candidates) {
      const loc = resolveLocator(page, c as unknown as LocatorSpec);
      expect(await loc.count(), `${c.strategy} matched nothing`).toBeGreaterThan(0);
      const same = await loc.first().evaluate((el, id) => el.id === id, "target");
      expect(same, `${c.strategy} resolved to a different element`).toBe(true);
    }
    return candidates;
  }

  it("a SHALLOW element keeps a body-anchored structural path", async () => {
    await page.setContent(`<body>${nest(3, '<input id="target">')}</body>`);
    const c = await roundTrip("#target");
    const structural = c.find((x) => x.strategy === "structural");
    expect(structural?.structural_path?.startsWith("body > ")).toBe(true);
  });

  it("a DEEP element (past the cap) gets an unanchored path that still resolves", async () => {
    await page.setContent(`<body>${nest(20, '<input id="target">')}</body>`);
    const c = await roundTrip("#target");
    const structural = c.find((x) => x.strategy === "structural");
    expect(structural?.structural_path?.startsWith("body")).toBe(false);
  });

  it("an unnamed input gets an anchored css_vocab candidate from its labelled ancestor, ranked before structural", async () => {
    await page.setContent(`<body>${nest(14, `
      <div aria-label="Options group Panel options"><div><div><input id="target"></div></div></div>`)}</body>`);
    const c = await roundTrip("#target");
    const anchored = c.find((x) => x.strategy === "css_vocab");
    expect(anchored?.css).toBe('[aria-label="Options group Panel options"] > div > div > input');
    expect(anchored?.tenant_scoped).toBe(true);
    const order = c.map((x) => x.strategy);
    expect(order.indexOf("css_vocab")).toBeLessThan(order.indexOf("structural"));
  });

  it("escapes quotes and backslashes in an anchor label so the selector still parses and resolves", async () => {
    await page.setContent(`<body><div aria-label='Panel "A" \\ opts'><input id="target"></div></body>`);
    const c = await roundTrip("#target");
    expect(c.some((x) => x.strategy === "css_vocab")).toBe(true);
  });

  it("an element with no labelled ancestor gets no css_vocab candidate", async () => {
    await page.setContent(`<body>${nest(2, '<input id="target">')}</body>`);
    const c = await roundTrip("#target");
    expect(c.some((x) => x.strategy === "css_vocab")).toBe(false);
  });
});
