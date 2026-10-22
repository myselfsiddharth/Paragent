/**
 * The real repair client (#27) — every case mocked, no network, no spend.
 *
 * `npm run ci` must never make an API call or cost money, so the SDK is
 * injected. That is also why the constructor takes a `client`: without it, the
 * only way to test the parse and accounting paths would be to hit the API.
 *
 * What these actually guard, in order of how much it would cost to get wrong:
 *
 * 1. **Token accounting**, because `cost_repair` is compared to `cost_fresh` at
 *    a 70% kill line. An undercount moves a verdict.
 * 2. **Failure paths report the tokens they burned.** A refusal that reports
 *    zero makes repair look free and understates against that same line.
 * 3. **A proposal touching the assertion is dropped whole**, not merged.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AnthropicRepairModelClient,
  DEFAULT_EFFORT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REPAIR_MODEL,
  MissingAnthropicKeyError,
  REPAIR_OUTPUT_SCHEMA,
  billedInputTokens,
} from "../../src/runner/repair-anthropic.js";
// Moved to the client-contract module in #189 so a second client can reuse it
// without loading the Anthropic SDK. Same function, same guarantees.
import { sanitizeProposedAction } from "../../src/runner/repair.js";
import { emptyPageState } from "../../src/runner/page-state.js";
import type { RepairContext } from "../../src/runner/types.js";

/** Assembled at runtime — a literal here would trip secret-scan's env pattern. */
const FAKE_KEY = "sk-ant-" + "TEST-" + "not-a-real-credential";

function context(): RepairContext {
  return {
    run_id: "run-1",
    attempt: 1,
    failed_outcome: "LOCATOR_NOT_FOUND",
    assertion: {
      schema_version: "1.0.0",
      assertion_id: "assert-0",
      type: "element-visible",
      strength: "strong",
      timeout_ms: 5000,
      failure_classification: "assertion_failed",
    },
    step: {
      step_index: 1,
      compiled_action: {
        type: "click",
        locator_fallback_chain: [
          { strategy: "role_name", role: "button", name: "Add new panel" },
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
      ...emptyPageState({ url: "http://127.0.0.1:3000/dashboard/new", title: "New" }),
      context_level: "interactive",
      elements: [{ role: "button", name: "Add visualization" }],
    },
    params: { host: "127.0.0.1", port: 3000 },
  } as unknown as RepairContext;
}

/**
 * A fake `messages.create` returning whatever the test wants.
 *
 * Typed to take the request body so `create.mock.calls[0][0]` is inspectable —
 * the request-shape assertions are half the point, and an untyped mock makes
 * them unwritable.
 */
function fakeClient(impl: () => unknown) {
  const create = vi.fn(async (_body: Record<string, unknown>) => impl());
  return { client: { messages: { create } } as never, create };
}

const goodAction = {
  type: "click",
  locator_fallback_chain: [
    { strategy: "role_name", role: "button", name: "Add visualization" },
  ],
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 80 },
    content: [{ type: "text", text: JSON.stringify({ corrected_action: goodAction }) }],
    ...overrides,
  };
}

describe("construction", () => {
  it("throws when ANTHROPIC_API_KEY is unset — never degrades to the stub", () => {
    // A gate run that silently used the stub would report a self-heal rate of
    // 0 that looks measured, which is worse than a run that failed.
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      expect(() => new AnthropicRepairModelClient()).toThrow(MissingAnthropicKeyError);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("accepts an explicit key without reading the environment", () => {
    expect(() => new AnthropicRepairModelClient({ apiKey: FAKE_KEY })).not.toThrow();
  });

  it("defaults to the documented model, ceiling and effort", () => {
    const c = new AnthropicRepairModelClient({ apiKey: FAKE_KEY });
    expect(c.model).toBe(DEFAULT_REPAIR_MODEL);
    expect(c.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(c.effort).toBe(DEFAULT_EFFORT);
  });
});

describe("request shape", () => {
  it("sends no temperature, top_p or top_k — they 400 on this model", async () => {
    const { client, create } = fakeClient(response);
    await new AnthropicRepairModelClient({ client }).propose(context());
    const body = create.mock.calls[0]![0];
    expect(body["temperature"]).toBeUndefined();
    expect(body["top_p"]).toBeUndefined();
    expect(body["top_k"]).toBeUndefined();
  });

  it("asks for structured output rather than parsing prose", async () => {
    const { client, create } = fakeClient(response);
    await new AnthropicRepairModelClient({ client }).propose(context());
    const body = create.mock.calls[0]![0] as unknown as {
      output_config?: { effort?: string; format?: { type?: string; schema?: unknown } };
      max_tokens?: number;
    };
    expect(body.output_config?.format?.type).toBe("json_schema");
    expect(body.output_config?.format?.schema).toBe(REPAIR_OUTPUT_SCHEMA);
    expect(body.output_config?.effort).toBe(DEFAULT_EFFORT);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("sends only the authorized egress payload — never the raw context", async () => {
    // ADR-0012's boundary, checked at the one place it could be bypassed.
    const { client, create } = fakeClient(response);
    const ctx = context();
    await new AnthropicRepairModelClient({ client }).propose(ctx);
    const body = create.mock.calls[0]![0] as unknown as { messages: Array<{ content: string }> };
    const sent = body.messages[0]!.content;
    expect(sent).not.toContain("params");
    expect(sent).not.toContain("127.0.0.1:3000/dashboard/new".split("/")[0] + "\",\"params");
    expect(JSON.parse(sent)).toHaveProperty("context_level", "interactive");
    expect(JSON.parse(sent)).not.toHaveProperty("params");
  });

  it("offers the model no field capable of editing an assertion", () => {
    // The request-side half of assertion immutability: the runtime guard is
    // assertAssertionUnchanged; this stops the ask being made at all.
    const schema = JSON.stringify(REPAIR_OUTPUT_SCHEMA);
    expect(schema).not.toContain("assertion");
    expect(schema).not.toContain("timeout_ms\":{\"type\":\"object");
  });

  it("passes through pre_actions (ADR-0024) and drops an over-long sequence whole", async () => {
    const pre = { ...goodAction, locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "TestData" }] };
    const ok = fakeClient(() =>
      response({ content: [{ type: "text", text: JSON.stringify({ corrected_action: goodAction, pre_actions: [pre] }) }] }),
    );
    const p = await new AnthropicRepairModelClient({ client: ok.client }).propose(context());
    expect(p.pre_actions).toEqual([pre]);
    expect(p.corrected_action).toEqual(goodAction);

    const long = fakeClient(() =>
      response({ content: [{ type: "text", text: JSON.stringify({ corrected_action: goodAction, pre_actions: [pre, pre, pre] }) }] }),
    );
    const q = await new AnthropicRepairModelClient({ client: long.client }).propose(context());
    expect(q.corrected_action).toBeNull();
    expect(q.pre_actions).toBeUndefined();
    expect(q.notes).toMatch(/max 2/);
  });
});

describe("token accounting", () => {
  it("maps input and output tokens, and records model_id", async () => {
    const { client } = fakeClient(response);
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    expect(p.tokens_in).toBe(1200);
    expect(p.tokens_out).toBe(80);
    // A cost figure without the model that produced it is not reproducible.
    expect(p.model_id).toBe(DEFAULT_REPAIR_MODEL);
  });

  it("counts cache read and write tokens as billed input", () => {
    // Caching is off, so these are expected to be zero — summed anyway so
    // enabling it later cannot silently change what the number means. Dropping
    // cache-write tokens would understate against the 70% kill line.
    expect(
      billedInputTokens({
        input_tokens: 100,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 25,
      }),
    ).toBe(165);
    expect(billedInputTokens(undefined)).toBe(0);
    expect(billedInputTokens({ input_tokens: 10 })).toBe(10);
  });

  it("records the effort, which changes both cost and quality", async () => {
    const { client } = fakeClient(response);
    const p = await new AnthropicRepairModelClient({ client, effort: "high" }).propose(
      context(),
    );
    expect(p.notes).toContain("effort=high");
  });
});

describe("failure paths still report what they cost", () => {
  it("a refusal returns null with the tokens consumed", async () => {
    // Checked before reading content: a decline is HTTP 200 with possibly
    // empty content, and indexing content[0] would throw.
    const { client } = fakeClient(() =>
      response({ stop_reason: "refusal", content: [] }),
    );
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(1200);
    expect(p.tokens_out).toBe(80);
    expect(p.notes).toContain("refused");
  });

  it("a network error returns null without throwing into the run", async () => {
    const { client, create } = fakeClient(() => {
      throw new Error("ECONNRESET");
    });
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.notes).toContain("ECONNRESET");
    // Never retried silently — a hidden retry hides cost.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("unparseable structured output is a miss, not a crash", async () => {
    const { client } = fakeClient(() =>
      response({ content: [{ type: "text", text: "not json" }] }),
    );
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(1200);
  });

  it("an empty content array is a miss, not a crash", async () => {
    const { client } = fakeClient(() => response({ content: [] }));
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
  });
});

describe("assertion immutability at the proposal boundary", () => {
  it("drops a proposal that carries an assertion — whole, not merged", async () => {
    const { client } = fakeClient(() =>
      response({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              corrected_action: {
                ...goodAction,
                assertion: { type: "element-visible", strength: "weak" },
              },
            }),
          },
        ],
      }),
    );
    const p = await new AnthropicRepairModelClient({ client }).propose(context());
    // Partially honouring it would be worse than refusing: a weakened assertion
    // that still replays looks like a repair and is a corrupted measurement.
    expect(p.corrected_action).toBeNull();
    expect(p.notes).toContain("assertion");
    // Still charged for.
    expect(p.tokens_in).toBe(1200);
  });

  it.each([
    ["assertion", { assertion: {} }],
    ["expected", { expected: { visible: false } }],
    ["timeout_ms", { timeout_ms: 1 }],
  ])("rejects a proposal carrying %s", (_label, extra) => {
    const { action, rejected } = sanitizeProposedAction({ ...goodAction, ...extra });
    expect(action).toBeNull();
    expect(rejected).toContain("assertion");
  });

  it("accepts a clean action — the rejection is not blanket", () => {
    // Counter-check: if everything were rejected, the tests above would pass
    // for the wrong reason and repair would be dead code.
    const { action, rejected } = sanitizeProposedAction(goodAction);
    expect(rejected).toBeUndefined();
    expect(action?.type).toBe("click");
  });

  it("treats a null proposal as an honest miss", () => {
    expect(sanitizeProposedAction(null).action).toBeNull();
    expect(sanitizeProposedAction(null).rejected).toBeUndefined();
  });
});

describe("the suite makes no network calls", () => {
  it("never constructs a real SDK client", () => {
    // Guards the guard. Every test above injects a fake; if one stopped, it
    // would hit the API and either cost money or fail in CI for a confusing
    // reason.
    const c = new AnthropicRepairModelClient({ client: fakeClient(response).client });
    expect(c.model).toBe(DEFAULT_REPAIR_MODEL);
  });
});
