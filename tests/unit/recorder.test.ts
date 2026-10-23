import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchTestBrowser } from "../helpers/browser.js";
import { describe, expect, it } from "vitest";
import {
  assertNoLiteralSecrets,
  PACKAGE,
  TrajectoryRecorder,
  templatizeText,
  templatizeUrl,
} from "../../src/recorder/index.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("recorder package", () => {
  it("exports package id", () => {
    expect(PACKAGE).toBe("recorder");
  });

  it("templatizes host and port", () => {
    const { template, paramRefs } = templatizeUrl("http://127.0.0.1:3000/login", {
      host: "127.0.0.1",
      port: 3000,
    });
    expect(template).toBe("http://{host}:{port}/login");
    expect(paramRefs.sort()).toEqual(["host", "port"]);
  });

  // Live recording (#24) found the hole this closes: Grafana echoes typed values
  // and server-assigned ids straight back into the URL and the document title,
  // so a fingerprint captured verbatim carries `Paragent Gate Dashboard - …` and
  // `/d/<uid>/<slug>` as literals — a typed value in the artifact, and a field
  // that differs between two recordings of the same task.
  describe("lifting bound values out of captured text", () => {
    const bindings = {
      host: "127.0.0.1",
      port: 3000,
      dashboard_title: "Paragent Gate Dashboard",
      dashboard_uid: "d82e967e-cef0-482a-9456-2a3429353824",
      dashboard_slug: "paragent-gate-dashboard",
      series_count: 3,
    };

    it("replaces typed values echoed into the page title", () => {
      expect(
        templatizeText("Paragent Gate Dashboard - Dashboards - Grafana", bindings),
      ).toBe("{dashboard_title} - Dashboards - Grafana");
    });

    it("replaces server-assigned ids in a saved-dashboard URL", () => {
      expect(
        templatizeText(
          "http://{host}:{port}/d/d82e967e-cef0-482a-9456-2a3429353824/paragent-gate-dashboard?orgId=1",
          bindings,
        ),
      ).toBe("http://{host}:{port}/d/{dashboard_uid}/{dashboard_slug}?orgId=1");
    });

    it("leaves host and port to templatizeUrl instead of double-substituting", () => {
      expect(templatizeText("http://{host}:{port}/dashboards", bindings)).toBe(
        "http://{host}:{port}/dashboards",
      );
    });

    it("ignores values too short to substitute safely", () => {
      // series_count is "3": replacing it would rewrite every digit on the page.
      expect(templatizeText("Last 30 days - 3 series", bindings)).toBe(
        "Last 30 days - 3 series",
      );
    });
  });

  it("records fixture gate task with schema-valid, value-free trajectory", async () => {
    const schema = JSON.parse(
      await readFile(path.join(ROOT, "contracts/trajectory.schema.json"), "utf8"),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const fixturePath = path.join(ROOT, "src/recorder/fixtures/grafana-gate-login.html");
    const fixtureRoot = path.dirname(fixturePath).replace(/\\/g, "/");

    const browser = await launchTestBrowser();
    const page = await browser.newPage();
    try {
      const recorder = new TrajectoryRecorder(page, {
        trajectory_id: "traj-unit-fixture",
        site_key: "grafana-oss@fixture",
        task_key: "login-open-dashboards-list",
        base_url_template: "file://{fixture_root}/grafana-gate-login.html",
        provenance: { recorder: "test", agent_model: "human", testbed_version: "fixture-v1" },
        parameters: {
          fixture_root: "string",
          username: "string",
          password: "secret_ref",
        },
        bindings: { fixture_root: fixtureRoot },
      });

      await recorder.navigate(
        "file://{fixture_root}/grafana-gate-login.html",
        "Open the login page",
        ["fixture_root"],
      );
      await recorder.fill(
        page.getByLabel("Username"),
        "username",
        "canary-user-never-persist",
        "Fill username",
      );
      await recorder.fill(
        page.getByLabel("Password"),
        "password",
        "canary-secret-never-persist",
        "Fill password",
      );
      await recorder.click(page.getByRole("button", { name: "Log in" }), "Submit login");
      await recorder.click(page.getByTestId("nav-dashboards"), "Open dashboards list");
      await recorder.wait("Let the list settle", 50);

      const traj = recorder.toTrajectory();
      const text = JSON.stringify(traj);
      assertNoLiteralSecrets(text);
      expect(text).not.toContain("canary-user-never-persist");
      expect(text).not.toContain("canary-secret-never-persist");
      expect(traj.parameters.username).toBe("string");
      expect(traj.parameters.password).toBe("secret_ref");
      expect(traj.steps.length).toBeGreaterThanOrEqual(5);

      // ADR-0007: the fixture's app view is `hidden` until login, so its
      // banner/navigation landmarks must not be reported on the login page.
      // Before the visibility filter they were, which is what made the
      // landmark fallback useless for assertion synthesis.
      expect(traj.steps[0]!.post_state.visible_landmarks).toEqual([
        "main",
        "form",
      ]);
      // The login click hides the form and reveals the app chrome.
      const loginClick = traj.steps.find(
        (s) => s.action.type === "click" && s.post_action_target_visible === false,
      );
      expect(loginClick).toBeDefined();
      expect(loginClick!.post_state.visible_landmarks).not.toContain("form");
      // ADR-0026: the login click revealed the app's controls, recorded as a
      // count, never the names. Only click-like steps carry one: nothing else
      // is read by the compiler, so nothing else pays for two captures.
      expect(loginClick!.controls_appeared).toBeGreaterThan(0);
      for (const s of traj.steps) {
        const clickLike = ["click", "check", "uncheck", "press"].includes(s.action.type);
        expect(typeof s.controls_appeared).toBe(clickLike ? "number" : "undefined");
      }
      const fillStep = traj.steps.find((s) => s.action.type === "fill");
      expect(fillStep?.locator_candidates.length).toBeGreaterThanOrEqual(2);
      expect(fillStep?.locator_candidates[0]?.strategy).toBe("role_name");

      // #83 / ADR-0008: the recorder must not drop a wait step's duration.
      const waitStep = traj.steps.find((s) => s.action.type === "wait");
      expect(waitStep?.action.wait_ms).toBe(50);

      expect(validate(traj)).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

/**
 * #224: Grafana's Save routes to /d/{uid}/{slug}, then rewrites it to add
 * ?orgId=1. Returning on the first URL change recorded the intermediate URL.
 */
describe("settleUrl waits for the URL to stop moving", () => {
  it("records the final URL of a two-hop client-side route", async () => {
    const { launchTestBrowser } = await import("../helpers/browser.js");
    const { settleUrl } = await import("../../src/recorder/session.js");
    const browser = await launchTestBrowser();
    try {
      const page = await browser.newPage();
      await page.route("http://paragent.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<main>app</main>" }),
      );
      await page.goto("http://paragent.test/dashboard/new?orgId=1");
      const before = page.url();
      // A string, not a callback: no DOM types in this project, and the
      // keepNames trap (PR #73) for serialized functions.
      await page.evaluate(`
        setTimeout(() => history.pushState({}, "", "/d/abc/gate"), 50);
        setTimeout(() => history.replaceState({}, "", "/d/abc/gate?orgId=1"), 200);
      `);
      await settleUrl(page, before);
      expect(page.url()).toBe("http://paragent.test/d/abc/gate?orgId=1");

      // A URL that never moves still returns, after the first budget.
      const started = Date.now();
      await settleUrl(page, page.url());
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
