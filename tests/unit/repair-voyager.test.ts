/**
 * The Voyager repair client and its OpenAI-spec transport — every call mocked,
 * no network, no spend. Mirrors `tests/unit/repair-anthropic.test.ts`.
 *
 * What these guard, in order of how much it would cost to get wrong:
 *
 * 1. **Token accounting.** OpenAI-spec `prompt_tokens` already INCLUDES cached
 *    tokens; the Anthropic client's "sum every cache field" rule would
 *    double-count here and inflate `cost_repair` against the 70% kill line.
 * 2. **The egress boundary** (ADR-0012) holds for a second provider.
 * 3. **The credential never leaks** into an error message or a note.
 * 4. **One contract, two providers** — the schema and prompt are the Anthropic
 *    client's own objects, not copies.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ChatHttpError,
  ChatTransportError,
  OpenAICompatChatClient,
  billedCompletionTokens,
  billedPromptTokens,
  cachedPromptTokens,
  parseJsonReply,
  type ChatRequest,
  type ChatResponse,
} from "../../src/runner/chat-openai.js";
import { REPAIR_OUTPUT_SCHEMA, REPAIR_SYSTEM_PROMPT } from "../../src/runner/repair-anthropic.js";
import {
  DEFAULT_VOYAGER_MAX_TOKENS,
  DEFAULT_VOYAGER_MODEL,
  MissingVoyagerKeyError,
  VOYAGER_TEMPERATURE,
  VoyagerRepairModelClient,
} from "../../src/runner/repair-voyager.js";
import { emptyPageState } from "../../src/runner/page-state.js";
import type { RepairContext } from "../../src/runner/types.js";

/** Assembled at runtime — a literal here would trip secret-scan's env pattern. */
const FAKE_KEY = "vk-" + "TEST-" + "not-a-real-credential";

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
        locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Add new panel" }],
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
    params: { host: "127.0.0.1", port: 3000, secret_value: "do-not-leak-this" },
  } as unknown as RepairContext;
}

function fakeClient(impl: () => ChatResponse) {
  const complete = vi.fn(async (_req: ChatRequest) => impl());
  return { client: { complete }, complete };
}

const goodAction = {
  type: "click",
  locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "Add visualization" }],
};

function reply(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } },
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify({ corrected_action: goodAction }), refusal: null },
      },
    ],
    ...overrides,
  };
}

describe("construction", () => {
  it("throws when VOYAGER_API_KEY is unset — never degrades to the stub", () => {
    const saved = process.env["VOYAGER_API_KEY"];
    delete process.env["VOYAGER_API_KEY"];
    try {
      expect(() => new VoyagerRepairModelClient()).toThrow(MissingVoyagerKeyError);
    } finally {
      if (saved !== undefined) process.env["VOYAGER_API_KEY"] = saved;
    }
  });

  it("accepts an explicit key without reading the environment", () => {
    expect(() => new VoyagerRepairModelClient({ apiKey: FAKE_KEY })).not.toThrow();
  });

  it("defaults to the documented model and ceiling", () => {
    const c = new VoyagerRepairModelClient({ apiKey: FAKE_KEY });
    expect(c.model).toBe(DEFAULT_VOYAGER_MODEL);
    expect(c.maxTokens).toBe(DEFAULT_VOYAGER_MAX_TOKENS);
  });
});

describe("request shape", () => {
  it("pins temperature and asks for strict json_schema output", async () => {
    const { client, complete } = fakeClient(reply);
    await new VoyagerRepairModelClient({ client }).propose(context());
    const req = complete.mock.calls[0]![0];
    expect(req.temperature).toBe(VOYAGER_TEMPERATURE);
    expect(req.max_tokens).toBe(DEFAULT_VOYAGER_MAX_TOKENS);
    expect(req.response_format?.type).toBe("json_schema");
    expect(req.response_format?.json_schema.strict).toBe(true);
  });

  it("uses the Anthropic client's schema and prompt objects — one contract, two providers", async () => {
    const { client, complete } = fakeClient(reply);
    await new VoyagerRepairModelClient({ client }).propose(context());
    const req = complete.mock.calls[0]![0];
    expect(req.response_format?.json_schema.schema).toBe(REPAIR_OUTPUT_SCHEMA);
    expect(req.messages[0]).toEqual({ role: "system", content: REPAIR_SYSTEM_PROMPT });
  });

  it("sends only the authorized egress payload — never params or the raw context", async () => {
    // ADR-0012's boundary, for a second third-party gateway.
    const { client, complete } = fakeClient(reply);
    await new VoyagerRepairModelClient({ client }).propose(context());
    const req = complete.mock.calls[0]![0];
    const sent = req.messages.map((m) => m.content).join("\n");
    expect(sent).not.toContain("do-not-leak-this");
    expect(sent).not.toContain("secret_value");
    const user = JSON.parse(req.messages[1]!.content);
    expect(user).toHaveProperty("context_level", "interactive");
    expect(user).not.toHaveProperty("params");
  });
});

describe("token accounting", () => {
  it("maps prompt/completion tokens and records model_id", async () => {
    const { client } = fakeClient(reply);
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.tokens_in).toBe(1200);
    expect(p.tokens_out).toBe(80);
    expect(p.model_id).toBe(DEFAULT_VOYAGER_MODEL);
    // Measured: the delegated client's `cost_measured: false` must NOT appear.
    expect(p).not.toHaveProperty("cost_measured");
  });

  it("does NOT add cached tokens on top of prompt_tokens — they are a subset", () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } };
    expect(billedPromptTokens(usage)).toBe(1000);
    expect(cachedPromptTokens(usage)).toBe(800);
    expect(billedCompletionTokens(usage)).toBe(50);
  });

  it("treats missing usage as zero, not NaN", () => {
    expect(billedPromptTokens(undefined)).toBe(0);
    expect(billedPromptTokens(null)).toBe(0);
    expect(billedCompletionTokens({})).toBe(0);
    expect(cachedPromptTokens({ prompt_tokens: 5 })).toBe(0);
  });

  it("surfaces the cached share and provenance in the notes", async () => {
    const { client } = fakeClient(() =>
      reply({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 640 } } }),
    );
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.tokens_in).toBe(1000);
    expect(p.notes).toContain("provider=voyager");
    expect(p.notes).toContain("temperature=0");
    expect(p.notes).toContain("cached_prompt_tokens=640");
  });
});

describe("failure paths still report what they cost", () => {
  it("a refusal returns null with the tokens consumed", async () => {
    const { client } = fakeClient(() =>
      reply({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] }),
    );
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(1200);
    expect(p.notes).toContain("refused");
  });

  it("a transport error returns null without throwing, and is never retried", async () => {
    const complete = vi.fn(async () => {
      throw new ChatHttpError(503, "upstream unavailable");
    });
    const p = await new VoyagerRepairModelClient({ client: { complete } }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(0);
    expect(p.notes).toContain("503");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("truncated JSON (finish_reason: length) is a miss that still reports tokens", async () => {
    const { client } = fakeClient(() =>
      reply({ choices: [{ finish_reason: "length", message: { content: '{"corrected_action": {"type": "cl' } }] }),
    );
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(1200);
    expect(p.notes).toContain("finish_reason: length");
  });

  it("an empty choices array is a miss, not a crash", async () => {
    const { client } = fakeClient(() => reply({ choices: [] }));
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.tokens_in).toBe(1200);
  });

  it("accepts a markdown-fenced reply from a model that ignores the constraint", async () => {
    const fenced = "```json\n" + JSON.stringify({ corrected_action: goodAction }) + "\n```";
    const { client } = fakeClient(() => reply({ choices: [{ message: { content: fenced } }] }));
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action?.type).toBe("click");
  });

  it("a null corrected_action is an honest miss", async () => {
    const { client } = fakeClient(() =>
      reply({ choices: [{ message: { content: JSON.stringify({ corrected_action: null }) } }] }),
    );
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.notes).not.toContain("rejected");
  });

  it("passes through pre_actions (ADR-0024)", async () => {
    const pre = { ...goodAction, locator_fallback_chain: [{ strategy: "role_name", role: "button", name: "TestData" }] };
    const { client } = fakeClient(() =>
      reply({ choices: [{ message: { content: JSON.stringify({ corrected_action: goodAction, pre_actions: [pre] }) } }] }),
    );
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.pre_actions).toEqual([pre]);
  });
});

describe("assertion immutability at the proposal boundary", () => {
  it("drops a proposal that carries an assertion — whole, not merged — and still charges for it", async () => {
    const tampered = { corrected_action: { ...goodAction, assertion: { type: "element-visible", strength: "weak" } } };
    const { client } = fakeClient(() => reply({ choices: [{ message: { content: JSON.stringify(tampered) } }] }));
    const p = await new VoyagerRepairModelClient({ client }).propose(context());
    expect(p.corrected_action).toBeNull();
    expect(p.notes).toContain("assertion");
    expect(p.tokens_in).toBe(1200);
  });
});

describe("OpenAI-spec transport", () => {
  function fetchReturning(status: number, body: string) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status }));
  }
  const request: ChatRequest = {
    model: "m",
    max_tokens: 10,
    temperature: 0,
    messages: [{ role: "user", content: "hi" }],
  };

  it("POSTs to <base>/chat/completions with a bearer header, tolerating a trailing slash", async () => {
    const fetchImpl = fetchReturning(200, JSON.stringify({ choices: [] }));
    const t = new OpenAICompatChatClient({ baseUrl: "https://example.test/v1/", credential: FAKE_KEY, fetchImpl });
    await t.complete(request);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://example.test/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("throws ChatHttpError on non-2xx, with the status", async () => {
    const t = new OpenAICompatChatClient({
      baseUrl: "https://example.test/v1",
      credential: FAKE_KEY,
      fetchImpl: fetchReturning(401, '{"error":"bad key"}'),
    });
    await expect(t.complete(request)).rejects.toMatchObject({ name: "ChatHttpError", status: 401 });
  });

  it("turns a network failure into ChatTransportError carrying the real cause, never the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`other side closed ${FAKE_KEY}`), { code: "UND_ERR_SOCKET" }),
      });
    });
    const t = new OpenAICompatChatClient({ baseUrl: "https://example.test/v1", credential: FAKE_KEY, fetchImpl });
    const err = await t.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTransportError);
    expect((err as Error).message).toContain("UND_ERR_SOCKET");
    expect((err as Error).message).toContain("other side closed");
    expect((err as Error).message).not.toContain(FAKE_KEY);
  });

  it("scrubs the credential from an error body that echoes it", async () => {
    const t = new OpenAICompatChatClient({
      baseUrl: "https://example.test/v1",
      credential: FAKE_KEY,
      fetchImpl: fetchReturning(401, `invalid token ${FAKE_KEY} for request`),
    });
    const err = await t.complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatHttpError);
    expect((err as Error).message).not.toContain(FAKE_KEY);
    expect((err as Error).message).toContain("<redacted>");
  });
});

describe("parseJsonReply", () => {
  it("parses bare JSON, fenced JSON, and rejects prose", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonReply("I would click Save")).toThrow();
  });
});

describe("the suite makes no network calls", () => {
  it("never constructs the real transport", () => {
    const c = new VoyagerRepairModelClient({ client: fakeClient(reply).client });
    expect(c.model).toBe(DEFAULT_VOYAGER_MODEL);
  });
});
