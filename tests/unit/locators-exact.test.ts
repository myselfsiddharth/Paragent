/**
 * Exact matching in `resolveLocator` — a regression test for the first live
 * replay of the gate bundle on 9.5.21, where `label: "Series count"` resolved
 * to a container `<div aria-label="TestData series count">` instead of the
 * input, because Playwright's default is case-insensitive substring matching
 * and `resolveWithFallback` takes `.first()`.
 *
 * The fixtures reproduce the real DOM shapes: the containing element comes
 * FIRST in document order, which is what made the loose match pick it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { resolveWithFallback, LocatorNotFoundError } from "../../src/runner/locators.js";

describe("resolveWithFallback matches recorded names exactly", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("label: a container whose aria-label CONTAINS the recorded label is not chosen over the input", async () => {
    await page.setContent(`
      <div aria-label="TestData series count">
        <label for="sc">Series count</label><input id="sc">
      </div>`);
    const loc = await resolveWithFallback(page, [{ strategy: "label", label: "Series count" }]);
    expect(await loc.evaluate((el) => el.tagName)).toBe("INPUT");
    await loc.fill("5"); // the call that threw PAGE_ERROR on 9.5.21
    expect(await loc.inputValue()).toBe("5");
  });

  it("role_name: a longer name that contains the recorded one is not a match", async () => {
    await page.setContent(`
      <button>Add new panel from panel library</button>
      <button>Add new panel</button>`);
    const loc = await resolveWithFallback(page, [{ strategy: "role_name", role: "button", name: "Add new panel" }]);
    expect(await loc.textContent()).toBe("Add new panel");
  });

  it("is case-sensitive: a recorded name that changed case is a miss, not a silent re-find", async () => {
    await page.setContent(`<button>save dashboard</button>`);
    await expect(
      resolveWithFallback(page, [{ strategy: "role_name", role: "button", name: "Save dashboard" }]),
    ).rejects.toBeInstanceOf(LocatorNotFoundError);
  });

  it("falls through to the next strategy when an exact match does not exist", async () => {
    await page.setContent(`<div aria-label="TestData series count"><input data-testid="sc"></div>`);
    const loc = await resolveWithFallback(page, [
      { strategy: "label", label: "Series count" },
      { strategy: "testid", testid: "sc" },
    ]);
    expect(await loc.getAttribute("data-testid")).toBe("sc");
  });
});
