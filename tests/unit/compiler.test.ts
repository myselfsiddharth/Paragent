import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLocatorFallbackChain,
  compileTrajectory,
  decidePoolEligibility,
  DEFAULT_ASSERTION_TIMEOUT_MS,
  looksLikeTenantLiteral,
  looksLikeTenantSelector,
  orderLocatorCandidates,
  PACKAGE,
  validateCompiledBundle,
  type Trajectory,
} from "../../src/compiler/index.js";

describe("compiler package", () => {
  it("exports package id", () => {
    expect(PACKAGE).toBe("compiler");
  });
});

describe("locator preference order", () => {
  it("orders by B2 preference then rank", () => {
    const ordered = orderLocatorCandidates([
      { strategy: "structural", rank: 1 },
      { strategy: "role_name", rank: 2 },
      { strategy: "testid", rank: 1 },
      { strategy: "label", rank: 1 },
      { strategy: "text", rank: 1 },
    ]);
    expect(ordered.map((c) => c.strategy)).toEqual([
      "role_name",
      "label",
      "testid",
      "structural",
      "text",
    ]);
  });
});

describe("tenant literal heuristics", () => {
  it("flags emails and uuids; allows chrome labels and holes", () => {
    expect(looksLikeTenantLiteral("user@example.com")).toBe(true);
    expect(
      looksLikeTenantLiteral("550e8400-e29b-41d4-a716-446655440000"),
    ).toBe(true);
    expect(looksLikeTenantLiteral("Username")).toBe(false);
    expect(looksLikeTenantLiteral("http://{host}:{port}/login")).toBe(false);
  });
});

// All three of these were found by compiling the live 12-step recording
// (issue #25). None of them could fire on contracts/examples/trajectory.example.json,
// whose locators are short and whose assertions carry no expected.template.
describe("selectors are topology, not prose", () => {
  const REAL_PATH =
    "body > div:nth-of-type(2) > div:nth-of-type(3) > div > div:nth-of-type(1) > div > div > button";

  it("does not read a descendant combinator as three words of tenant text", () => {
    // looksLikeTenantLiteral ends with "3+ whitespace-separated words is prose".
    // A CSS path is nothing but whitespace-separated tokens.
    expect(looksLikeTenantLiteral(REAL_PATH)).toBe(true);
    expect(looksLikeTenantSelector(REAL_PATH)).toBe(false);
    expect(looksLikeTenantSelector("body > button")).toBe(false);
  });

  it("still flags identifier-shaped tenant data inside a selector", () => {
    expect(
      looksLikeTenantSelector('div[data-uid="d82e967e-cef0-482a-9456-2a3429353824"]'),
    ).toBe(true);
    expect(looksLikeTenantSelector('a[href*="user@example.com"]')).toBe(true);
  });

  it("keeps a structural candidate out of the tainted pile, so the chain is not degraded", () => {
    const { chain, topologyOnly } = buildLocatorFallbackChain([
      { strategy: "role_name", rank: 1, role: "button", name: "Add new panel", tenant_scoped: true },
      { strategy: "structural", rank: 2, structural_path: REAL_PATH, tenant_scoped: false },
    ]);
    // Before the fix every candidate looked tainted, so the chain gained a
    // topology_only entry and 11 of 12 live rows reported topology_only_degraded.
    expect(topologyOnly).toBe(false);
    expect(chain.map((l) => l.strategy)).toEqual(["role_name", "structural"]);
  });
});

describe("count-equals is not triggered by a parameter name", () => {
  const fillStep = {
    step_index: 0,
    intent: "Set how many series the query returns",
    action: { type: "fill" as const, param_refs: ["series_count"] },
    locator_candidates: [
      {
        strategy: "structural" as const,
        rank: 1,
        structural_path: "body > form > input",
        tenant_scoped: false,
      },
    ],
    pre_state: {
      url_template: "http://{host}:{port}/dashboard/new",
      title_template: "New dashboard",
      dom_digest: "aaaa",
      visible_landmarks: ["main"],
      network_idle: true,
    },
    post_state: {
      url_template: "http://{host}:{port}/dashboard/new",
      title_template: "New dashboard",
      dom_digest: "bbbb",
      visible_landmarks: ["main"],
      network_idle: true,
    },
    timing_ms: { started_offset_ms: 0, duration_ms: 1 },
    assertion_hint: {
      suggested_type: "element-value-bound" as const,
      // The recorder's real signal. "series_count" contains "count".
      observed_signals: ["param slot series_count filled"],
    },
  };

  const wrapFill = (step: typeof fillStep): Trajectory => ({
    schema_version: "1.0.0",
    trajectory_id: "traj-count",
    site_key: "fixture@local",
    task_key: "count-task",
    recorded_at: "2026-07-25T00:00:00.000Z",
    base_url_template: "http://{host}:{port}",
    provenance: { recorder: "test", agent_model: "human", testbed_version: "fixture-v1" },
    parameters: { series_count: "integer" },
    steps: [step],
  });

  it("does not assert a count because the slot is named *_count", () => {
    const assertion = compileTrajectory(wrapFill(fillStep), {
      compiledAt: "2026-07-25T00:00:00.000Z",
    }).rows[0]!.assertion;
    // Was count-equals with expected.count = 0 — an assertion about a text
    // input that could never be satisfied.
    expect(assertion.type).toBe("element-visible");
    expect(assertion.strength).toBe("weak");
  });

  it("still honours a real count signal", () => {
    const withCount = {
      ...fillStep,
      assertion_hint: {
        suggested_type: "element-value-bound" as const,
        observed_signals: ["3 rows rendered"],
      },
    };
    expect(
      compileTrajectory(wrapFill(withCount), {
        compiledAt: "2026-07-25T00:00:00.000Z",
      }).rows[0]!.assertion.type,
    ).toBe("count-equals");
  });
});

describe("pool pre-check never outruns the B5 authority", () => {
  const chain = [
    { strategy: "structural" as const, structural_path: "body > button", tenant_scoped: false },
  ];

  it("refuses a URL assertion whose template has a literal path", () => {
    // B5's assertionHasTenantLiteral treats anything left after the holes as a
    // literal, so a url-matches row it would reject must not be claimed here.
    const decision = decidePoolEligibility({
      chain,
      topologyOnly: false,
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "url-matches",
        strength: "strong",
        expected: { template: "http://{host}:{port}/dashboard/new?orgId=1" },
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    });
    expect(decision.pool_eligible).toBe(false);
    expect(decision.pool_ineligible_reason).toBe("literal_in_assertion");
  });

  it("still pools an assertion whose template is only holes", () => {
    const decision = decidePoolEligibility({
      chain,
      topologyOnly: false,
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "text-matches",
        strength: "strong",
        expected: { template: "{success_message}" },
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    });
    expect(decision.pool_eligible).toBe(true);
  });

  it("agrees with B5 on topology_only degradation (#170)", () => {
    // buildPoolRow pools a locator-less topology row when the chain is all
    // tainted but flow_topology exists. The pre-check used to refuse those
    // as topology_only_degraded, understating pool_eligible on every bundle.
    const decision = decidePoolEligibility({
      chain: [
        {
          strategy: "role_name",
          role: "button",
          name: "Save dashboard",
          tenant_scoped: true,
        },
        { strategy: "topology_only", tenant_scoped: false },
      ],
      topologyOnly: true,
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "element-visible",
        strength: "weak",
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    });
    expect(decision.pool_eligible).toBe(true);
    expect(decision.pool_ineligible_reason).toBeNull();
  });

  it("strips tenant_scoped siblings and pools the surviving structural (#170)", () => {
    // The live gate gap was this shape: a mixed chain where some candidates are
    // tenant_scoped and a structural survives. buildPoolRow keeps structural;
    // the old pre-check refused the whole row on `.some(tenant_scoped)`.
    const decision = decidePoolEligibility({
      chain: [
        {
          strategy: "role_name",
          role: "button",
          name: "Save dashboard",
          tenant_scoped: true,
        },
        {
          strategy: "structural",
          structural_path: "main > button",
          tenant_scoped: false,
        },
      ],
      topologyOnly: false,
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "element-visible",
        strength: "weak",
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    });
    expect(decision.pool_eligible).toBe(true);
    expect(decision.pool_ineligible_reason).toBeNull();
  });

  it("refuses a non-vocabulary testid in the assertion target (#170)", () => {
    // The shape that crashed record -> compile -> cache. B5's
    // assertionHasTenantLiteral runs checkLocatorTaint over
    // assertion.target.locator, and `dismiss-notice` is not in the testid
    // vocabulary — but it is a plain kebab string that no prose heuristic
    // flags. Stripping the tenant_scoped role_name (correct, #170) made this
    // row reachable, and the pre-check called it poolable while B5 refused it.
    const decision = decidePoolEligibility({
      chain: [
        { strategy: "role_name", role: "button", name: "Dismiss", tenant_scoped: true },
        { strategy: "testid", testid: "dismiss-notice", tenant_scoped: false },
        { strategy: "structural", structural_path: "main > button", tenant_scoped: false },
      ],
      topologyOnly: false,
      hasFlowTopology: true,
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "a",
        type: "element-visible",
        strength: "strong",
        target: { locator: { strategy: "testid", testid: "dismiss-notice" } },
        expected: { visible: false },
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    });
    expect(decision.pool_eligible).toBe(false);
    expect(decision.pool_ineligible_reason).toBe("literal_in_assertion");
  });

  it("does not pool an all-tainted chain when the row has no flow_topology (#170)", () => {
    // buildPoolRow degrades to a locator-less topology row only when
    // candidate.flow_topology is present; without it the authority refuses.
    const chainAllTainted = [
      { strategy: "role_name" as const, role: "button", name: "Save dashboard", tenant_scoped: true },
    ];
    const assertion = {
      schema_version: "1.0.0",
      assertion_id: "a",
      type: "element-visible",
      strength: "weak",
      timeout_ms: 5000,
      failure_classification: "assertion_failed",
    } as const;
    expect(
      decidePoolEligibility({ chain: chainAllTainted, assertion, topologyOnly: true, hasFlowTopology: false })
        .pool_eligible,
    ).toBe(false);
    expect(
      decidePoolEligibility({ chain: chainAllTainted, assertion, topologyOnly: true, hasFlowTopology: true })
        .pool_eligible,
    ).toBe(true);
  });
});

describe("click assertion target", () => {
  const fingerprint = (url: string, landmarks: string[]) => ({
    url_template: url,
    title_template: "Fixture",
    dom_digest: "digest",
    visible_landmarks: landmarks,
    network_idle: true,
  });

  const clickStep = (from: string, to: string) => ({
    step_index: 0,
    intent: "Submit login form",
    action: { type: "click" as const },
    locator_candidates: [
      { strategy: "role_name" as const, rank: 0, role: "button", name: "Log in" },
    ],
    pre_state: fingerprint(from, ["main", "form"]),
    post_state: fingerprint(to, ["main", "form"]),
    timing_ms: { started_offset_ms: 0, duration_ms: 5 },
    assertion_hint: {
      suggested_type: "element-visible",
      observed_signals: ["click target resolved"],
    },
  });

  const wrap = (step: Trajectory["steps"][number]): Trajectory => ({
    schema_version: "1.0.0",
    trajectory_id: "traj-click",
    site_key: "fixture@local",
    task_key: "click-task",
    recorded_at: "2026-07-25T00:00:00.000Z",
    base_url_template: "http://{host}:{port}/app",
    provenance: {
      recorder: "test",
      agent_model: "human",
      testbed_version: "fixture-v1",
    },
    parameters: { host: "string", port: "integer" },
    steps: [step],
  });

  it("uses the destination URL, not the clicked control, when a click navigates", () => {
    // Regression: the clicked control is routinely hidden by the very
    // transition being asserted (login submit hides the login form), so
    // "the button I clicked is still visible" is both weak and often false.
    const bundle = compileTrajectory(
      wrap(clickStep("http://{host}:{port}/app", "http://{host}:{port}/app#home")),
      { compiledAt: "2026-07-25T00:00:00.000Z" },
    );
    const assertion = bundle.rows[0]!.assertion;
    expect(assertion.type).toBe("url-matches");
    expect(assertion.strength).toBe("strong");
    expect(assertion.target?.url_template).toBe("http://{host}:{port}/app#home");
  });

  it("still asserts the control for a click that does not navigate", () => {
    const bundle = compileTrajectory(
      wrap(clickStep("http://{host}:{port}/app", "http://{host}:{port}/app")),
      { compiledAt: "2026-07-25T00:00:00.000Z" },
    );
    const assertion = bundle.rows[0]!.assertion;
    expect(assertion.type).toBe("element-visible");
    // ADR-0022: the clicked control, by reference to the action's resolved
    // element — not a copied locator, which was a structural path in practice.
    expect(assertion.target).toEqual({ locator_ref: "action_target" });
    expect(assertion.expected?.visible).toBe(true);
  });

  // ADR-0007
  it("asserts the control is GONE when a non-navigating click hides it", () => {
    const step = {
      ...clickStep("http://{host}:{port}/app", "http://{host}:{port}/app"),
      post_action_target_visible: false,
    };
    const assertion = compileTrajectory(wrap(step), {
      compiledAt: "2026-07-25T00:00:00.000Z",
    }).rows[0]!.assertion;

    expect(assertion.type).toBe("element-visible");
    expect(assertion.expected?.visible).toBe(false);
    expect(assertion.target).toEqual({ locator_ref: "action_target" });
    // Disappearance IS the purpose of a dismiss-shaped click, and this fails
    // on a no-op — so it is load-bearing, not merely consistent with success.
    expect(assertion.strength).toBe("strong");
  });

  it("prefers the destination when a click both navigates and hides its control", () => {
    const step = {
      ...clickStep("http://{host}:{port}/app", "http://{host}:{port}/app#home"),
      post_action_target_visible: false,
    };
    const assertion = compileTrajectory(wrap(step), {
      compiledAt: "2026-07-25T00:00:00.000Z",
    }).rows[0]!.assertion;

    // Where it landed is better evidence than what vanished.
    expect(assertion.type).toBe("url-matches");
    expect(assertion.strength).toBe("strong");
  });

  it("leaves fill steps alone even when the field is hidden afterwards", () => {
    const step = {
      ...clickStep("http://{host}:{port}/app", "http://{host}:{port}/app"),
      action: { type: "fill" as const, param_refs: ["q"] },
      post_action_target_visible: false,
    };
    const assertion = compileTrajectory(wrap(step), {
      compiledAt: "2026-07-25T00:00:00.000Z",
    }).rows[0]!.assertion;

    // The new branch is scoped to click-like actions; a fill that hides its
    // own field is not a pattern we have observed, so do not invent a rule.
    expect(assertion.expected?.visible).not.toBe(false);
  });

  // ADR-0026 (#224)
  describe("a click that revealed controls asserts that, not that it stayed visible", () => {
    const compile = (over: Record<string, unknown>) =>
      compileTrajectory(
        wrap({ ...clickStep("http://{host}:{port}/app", "http://{host}:{port}/app"), ...over }),
        { compiledAt: "2026-07-25T00:00:00.000Z" },
      ).rows[0]!.assertion;

    it("emits a weak controls-appeared with no target and no page text", () => {
      const assertion = compile({ post_action_target_visible: true, controls_appeared: 7 });
      expect(assertion.type).toBe("controls-appeared");
      expect(assertion.strength).toBe("weak");
      expect(assertion.expected).toEqual({ count: 1 });
      expect(assertion.target).toBeUndefined();
    });

    it("keeps the old check when the recording saw nothing appear, or could not tell", () => {
      for (const over of [{ controls_appeared: 0 }, {}]) {
        const assertion = compile({ post_action_target_visible: true, ...over });
        expect(assertion.type).toBe("element-visible");
        expect(assertion.expected?.visible).toBe(true);
      }
    });

    it("leaves the disappearing-control check (ADR-0007) and fills alone", () => {
      expect(compile({ post_action_target_visible: false, controls_appeared: 4 }).expected?.visible).toBe(false);
      const fill = compile({
        action: { type: "fill", param_refs: ["q"] },
        post_action_target_visible: true,
        controls_appeared: 4,
      });
      expect(fill.type).toBe("element-visible");
    });

    it("prefers the destination when the click navigated", () => {
      const assertion = compileTrajectory(
        wrap({
          ...clickStep("http://{host}:{port}/app", "http://{host}:{port}/app#home"),
          post_action_target_visible: true,
          controls_appeared: 4,
        }),
        { compiledAt: "2026-07-25T00:00:00.000Z" },
      ).rows[0]!.assertion;
      expect(assertion.type).toBe("url-matches");
    });
  });
});

// ---------------------------------------------------------------------------
// #83 / ADR-0008 — a recorded wait's duration must survive compilation
// unchanged, the same way `key` and `url_template` already do, so replay can
// reproduce the recorded sleep instead of falling back to networkidle.
// ---------------------------------------------------------------------------

describe("wait action duration (#83 / ADR-0008)", () => {
  const fp = () => ({
    url_template: "http://{host}:{port}/app",
    title_template: "Fixture",
    dom_digest: "digest",
  });

  const waitTrajectory = (action: Trajectory["steps"][number]["action"]): Trajectory => ({
    schema_version: "1.0.0",
    trajectory_id: "traj-wait",
    site_key: "fixture@local",
    task_key: "wait-task",
    recorded_at: "2026-08-03T00:00:00.000Z",
    base_url_template: "http://{host}:{port}/app",
    provenance: { recorder: "test", agent_model: "human", testbed_version: "fixture-v1" },
    parameters: { host: "string", port: "integer" },
    steps: [
      {
        step_index: 0,
        intent: "Let the toast animation finish",
        action,
        locator_candidates: [],
        pre_state: fp(),
        post_state: fp(),
        timing_ms: { started_offset_ms: 0, duration_ms: 500 },
      },
    ],
  });

  it("carries a recorded wait_ms straight through to the compiled action", () => {
    const bundle = compileTrajectory(
      waitTrajectory({ type: "wait", wait_ms: 500 }),
      { compiledAt: "2026-08-03T00:00:00.000Z" },
    );
    const action = bundle.rows[0]!.compiled_action;
    expect(action.type).toBe("wait");
    expect(action.wait_ms).toBe(500);
  });

  it("does not invent a duration when the recorded step did not carry one", () => {
    const bundle = compileTrajectory(
      waitTrajectory({ type: "wait" }),
      { compiledAt: "2026-08-03T00:00:00.000Z" },
    );
    expect(bundle.rows[0]!.compiled_action.wait_ms).toBeUndefined();
  });

  it("keeps a recorded zero distinguishable from an absent duration", () => {
    // The schemas allow `minimum: 0`, so the compiler must not let a falsy-but-
    // recorded 0 collapse into "no duration" — the runner's precedence chain
    // reads presence, and it can only do that if the compiler preserves it.
    const bundle = compileTrajectory(
      waitTrajectory({ type: "wait", wait_ms: 0 }),
      { compiledAt: "2026-08-03T00:00:00.000Z" },
    );
    expect(bundle.rows[0]!.compiled_action.wait_ms).toBe(0);
  });
});

describe("assertion timeout policy", () => {
  // `timeout_ms` is an assertion-STRENGTH knob, not a perf one: a shorter
  // timeout is a stricter check. The runner spends it on failure, so it is also
  // the dominant term in worst-case replay latency. Nothing pinned the emitted
  // value before, which meant it could be "tuned" for speed and silently move
  // step-level replay-validity — the one number PRD §9 gates on.
  const trajectory = (): Trajectory => ({
    schema_version: "1.0.0",
    trajectory_id: "traj-timeout",
    site_key: "fixture@local",
    task_key: "timeout-task",
    recorded_at: "2026-07-25T00:00:00.000Z",
    base_url_template: "http://{host}:{port}/app",
    provenance: {
      recorder: "test",
      agent_model: "human",
      testbed_version: "fixture-v1",
    },
    parameters: { host: "string", port: "integer" },
    steps: [
      {
        step_index: 0,
        intent: "Open the app",
        action: { type: "navigate" as const, url_template: "http://{host}:{port}/app" },
        locator_candidates: [],
        pre_state: {
          url_template: "about:blank",
          title_template: "",
          dom_digest: "d0",
          visible_landmarks: [],
          network_idle: false,
        },
        post_state: {
          url_template: "http://{host}:{port}/app",
          title_template: "App",
          dom_digest: "d1",
          visible_landmarks: ["main"],
          network_idle: true,
        },
        timing_ms: { started_offset_ms: 0, duration_ms: 5 },
      },
    ],
  });

  it("emits the documented default on every assertion", () => {
    expect(DEFAULT_ASSERTION_TIMEOUT_MS).toBe(5000);
    const bundle = compileTrajectory(trajectory());
    for (const row of bundle.rows) {
      expect(row.assertion.timeout_ms).toBe(DEFAULT_ASSERTION_TIMEOUT_MS);
    }
  });

  it("can be overridden per compile without touching the default", () => {
    const bundle = compileTrajectory(trajectory(), { assertionTimeoutMs: 1234 });
    for (const row of bundle.rows) {
      expect(row.assertion.timeout_ms).toBe(1234);
    }
    // The override must not leak into the module-level policy.
    expect(DEFAULT_ASSERTION_TIMEOUT_MS).toBe(5000);
  });
});

describe("compileTrajectory example", () => {
  it("emits one asserted cache-row per step with no tenant literals", async () => {
    const trajPath = path.join(
      process.cwd(),
      "contracts/examples/trajectory.example.json",
    );
    const trajectory = JSON.parse(
      await readFile(trajPath, "utf8"),
    ) as Trajectory;

    const bundle = compileTrajectory(trajectory, {
      compiledAt: "2026-07-25T00:00:00.000Z",
      inputPath: "contracts/examples/trajectory.example.json",
    });

    expect(bundle.bundle_kind).toBe("compiled_trajectory");
    expect(bundle.rows).toHaveLength(trajectory.steps.length);

    for (const row of bundle.rows) {
      expect(
        row.assertion.strength === "strong" ||
          row.assertion.strength === "weak",
      ).toBe(true);
      expect(row.assertion.notes).toBeTruthy();
      expect(row.compiled_action.locator_fallback_chain).toBeDefined();
      if (row.pool_eligible === false) {
        expect(row.pool_ineligible_reason).toBeTruthy();
      } else {
        expect(row.pool_ineligible_reason).toBeNull();
      }
    }

    expect(["element-visible", "url-matches"]).toContain(
      bundle.rows[0]!.assertion.type,
    );
    expect(bundle.rows[0]!.assertion.strength).toBe("strong");
    expect(bundle.rows[0]!.compiled_action.locator_fallback_chain).toEqual([]);
    expect(bundle.rows[0]!.pool_eligible).toBe(true);

    expect(bundle.rows[1]!.assertion.type).toBe("element-visible");
    expect(bundle.rows[1]!.assertion.strength).toBe("weak");
    expect(
      bundle.rows[1]!.compiled_action.locator_fallback_chain[0]!.strategy,
    ).toBe("role_name");
    expect(bundle.rows[1]!.pool_eligible).toBe(true);

    const validation = await validateCompiledBundle(bundle);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

// #230 review (ADR-0026): a post_state URL the next step's pre_state
// contradicts on the same path was taken mid-redirect.
describe("settleTransientUrls", () => {
  it("replaces a same-path transient with the settled URL, and leaves navigations alone", async () => {
    const { settleTransientUrls } = await import("../../src/compiler/compile.js");
    const fp = (url: string) => ({ url_template: url, title_template: "", dom_digest: "x", visible_landmarks: [], network_idle: true });
    const step = (i: number, pre: string, post: string) => ({
      step_index: i,
      intent: "s",
      action: { type: "click" as const },
      locator_candidates: [],
      pre_state: fp(pre),
      post_state: fp(post),
      timing_ms: { started_offset_ms: 0, duration_ms: 1 },
    });
    const traj = {
      schema_version: "1.0.0",
      trajectory_id: "t",
      site_key: "s",
      task_key: "k",
      recorded_at: "2026-10-22T00:00:00.000Z",
      base_url_template: "http://{host}:{port}",
      provenance: { recorder: "x", agent_model: "human", testbed_version: "v" },
      parameters: {},
      steps: [
        step(0, "http://{host}:{port}/dashboard/new?orgId=1", "http://{host}:{port}/d/{uid}/{slug}"),
        step(1, "http://{host}:{port}/d/{uid}/{slug}?orgId=1", "http://{host}:{port}/dashboards"),
        step(2, "http://{host}:{port}/somewhere/else", "http://{host}:{port}/somewhere/else"),
      ],
    } as unknown as Parameters<typeof settleTransientUrls>[0];
    const out = settleTransientUrls(traj);
    expect(out.steps[0]!.post_state.url_template).toBe("http://{host}:{port}/d/{uid}/{slug}?orgId=1");
    // A different path is a real navigation, not a transient.
    expect(out.steps[1]!.post_state.url_template).toBe("http://{host}:{port}/dashboards");
    // The input is untouched.
    expect(traj.steps[0]!.post_state.url_template).toBe("http://{host}:{port}/d/{uid}/{slug}");
  });
});
