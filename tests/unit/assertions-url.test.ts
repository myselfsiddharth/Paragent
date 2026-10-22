/**
 * `url-matches` waits for the URL to settle (up to `timeout_ms`) instead of
 * reading it once. Regression test for the gate bundle's step 0 on 9.5.21:
 * Grafana appends `?orgId=1` client-side after the router boots, and the
 * one-shot read failed the step on its own recording version in ~0.4s.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { evaluateAssertion } from "../../src/runner/assertions.js";
import type { Assertion } from "../../src/runner/types.js";

/** Settles its URL 300ms after load, the way Grafana's router does. */
const SPA = `<!doctype html><title>spa</title><script>
  setTimeout(() => history.replaceState(null, "", location.pathname + "?orgId=1"), 300);
</script>`;

function urlAssertion(timeout_ms: number, regex_template: string): Assertion {
  return {
    schema_version: "1.0.0",
    assertion_id: "assert-url",
    type: "url-matches",
    strength: "strong",
    expected: { regex_template },
    timeout_ms,
    failure_classification: "assertion_failed",
  } as unknown as Assertion;
}

describe("url-matches", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.route("http://app.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: SPA }),
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("passes once a client-side router settles the URL within the timeout", async () => {
    await page.goto("http://app.test/dashboard/new");
    expect(page.url()).not.toContain("orgId"); // the state the old one-shot read saw
    const r = await evaluateAssertion(page, urlAssertion(5000, "^http://app\\.test/dashboard/new\\?orgId=1$"));
    expect(r.outcome).toBe("PASS");
  });

  it("still fails a URL that never matches — at the deadline, not before", async () => {
    await page.goto("http://app.test/dashboard/new");
    const started = Date.now();
    const r = await evaluateAssertion(page, urlAssertion(800, "^http://app\\.test/somewhere-else$"));
    expect(r.outcome).toBe("ASSERTION_FAILED");
    expect(r.message).toContain("somewhere-else");
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
  });

  it("passes immediately when the URL already matches", async () => {
    await page.goto("http://app.test/ready");
    await page.waitForURL(/orgId=1/);
    const started = Date.now();
    const r = await evaluateAssertion(page, urlAssertion(5000, "^http://app\\.test/ready\\?orgId=1$"));
    expect(r.outcome).toBe("PASS");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
