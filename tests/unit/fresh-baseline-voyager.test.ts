/**
 * The Voyager fresh-baseline client (#39) — chat calls mocked, no network, no
 * spend. Mirrors `tests/unit/fresh-baseline-anthropic.test.ts`, and drives a
 * real headless browser for the same reason that file does: `executeAction` and
 * `capturePageState` only fail in ways that show up inside an actual page.
 *
 * What these guard, in order of how much it would cost to get wrong:
 *
 * 1. **Both §9 arms use one model.** A ratio across two models is about model
 *    choice, not about fresh-vs-repaired reasoning.
 * 2. **Multi-turn accounting does not double-count cached tokens.**
 * 3. **No retries; a failed turn still reports what prior turns billed.**
 * 4. **The model never sees the compiled program or an input's value.**
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Browser, type Page } from "playwright";
import { launchTestBrowser } from "../helpers/browser.js";
import { ChatHttpError, ChatTransportError, type ChatRequest, type ChatResponse } from "../../src/runner/chat-openai.js";
import { FRESH_SYSTEM_PROMPT, FRESH_TURN_SCHEMA } from "../../src/runner/fresh-baseline-anthropic.js";
import { VoyagerFreshBaselineClient } from "../../src/runner/fresh-baseline-voyager.js";
import {
  DEFAULT_VOYAGER_MAX_TOKENS,
  DEFAULT_VOYAGER_MODEL,
  MissingVoyagerKeyError,
  VOYAGER_TEMPERATURE,
} from "../../src/runner/repair-voyager.js";

/** Assembled at runtime — a literal here would trip secret-scan's env pattern. */
const FAKE_KEY = "vk-" + "TEST-" + "not-a-real-credential";

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  cached?: number;
}

function chatReply(decision: unknown, usage: Usage = { prompt_tokens: 100, completion_tokens: 20 }): ChatResponse {
  return {
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
    },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(decision), refusal: null } }],
  };
}

const done = (success: boolean, usage?: Usage) => chatReply({ done: true, success }, usage);
const click = (role: string, name: string, usage?: Usage) =>
  chatReply({ done: false, action: { type: "click", role, name } }, usage);

/** Returns each entry in order, then repeats the last one. */
function sequenceClient(responses: ChatResponse[]) {
  let i = 0;
  const complete = vi.fn(async (_req: ChatRequest) => responses[Math.min(i++, responses.length - 1)]!);
  return { client: { complete }, complete };
}

const goal = { task_goal: "goal", base_url: "http://x" };

describe("construction", () => {
  it("throws when VOYAGER_API_KEY is unset — never degrades to the stub", () => {
    const saved = process.env["VOYAGER_API_KEY"];
    delete process.env["VOYAGER_API_KEY"];
    try {
      expect(() => new VoyagerFreshBaselineClient()).toThrow(MissingVoyagerKeyError);
    } finally {
      if (saved !== undefined) process.env["VOYAGER_API_KEY"] = saved;
    }
  });

  it("defaults to the SAME model as the repair client — a fair ratio needs one reasoning system on both sides", () => {
    const fresh = new VoyagerFreshBaselineClient({ apiKey: FAKE_KEY });
    expect(fresh.model).toBe(DEFAULT_VOYAGER_MODEL);
    expect(fresh.maxTokens).toBe(DEFAULT_VOYAGER_MAX_TOKENS);
  });
});

describe("fresh-baseline attempt (real browser, mocked chat)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("a missing page is a measured zero, never a crash, and never calls the model", async () => {
    const { client, complete } = sequenceClient([done(true)]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt(goal);
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBe(0);
    expect(result.turns).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });

  it("shares the Anthropic arm's schema and prompt, and pins temperature", async () => {
    await page.setContent(`<button>Go</button>`);
    const { client, complete } = sequenceClient([done(true)]);
    await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    const req = complete.mock.calls[0]![0];
    expect(req.messages[0]).toEqual({ role: "system", content: FRESH_SYSTEM_PROMPT });
    expect(req.response_format?.json_schema.schema).toBe(FRESH_TURN_SCHEMA);
    expect(req.response_format?.json_schema.strict).toBe(true);
    expect(req.temperature).toBe(VOYAGER_TEMPERATURE);
  });

  it("never shows the model the compiled program — only task_goal and page state", async () => {
    await page.setContent(`<button>Go</button>`);
    const { client, complete } = sequenceClient([done(true)]);
    await new VoyagerFreshBaselineClient({ client }).attempt({ task_goal: "the-stated-goal", base_url: "http://x", page });
    const sent = JSON.parse(complete.mock.calls[0]![0].messages[1]!.content);
    expect(sent.task_goal).toBe("the-stated-goal");
    for (const forbidden of ["program_id", "site_key", "task_key", "compiled_action", "locator_fallback_chain", "assertion"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
  });

  it("never leaks an input's value, even when the page has one", async () => {
    await page.setContent(`<input type="password" value="do-not-leak-this" aria-label="Password">`);
    const { client, complete } = sequenceClient([done(true)]);
    await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    const everything = complete.mock.calls[0]![0].messages.map((m) => m.content).join("\n");
    expect(everything).not.toContain("do-not-leak-this");
  });

  it("sums prompt tokens across turns WITHOUT adding the cached subset", async () => {
    await page.setContent(`<button>Go</button>`);
    const { client } = sequenceClient([
      click("button", "Go", { prompt_tokens: 100, completion_tokens: 10, cached: 60 }),
      done(true, { prompt_tokens: 150, completion_tokens: 8, cached: 100 }),
    ]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    // 100 + 150, not 100 + 60 + 150 + 100: cached tokens are already inside prompt_tokens.
    expect(result.tokens_in).toBe(250);
    expect(result.tokens_out).toBe(18);
    expect(result.turns).toBe(2);
    expect(result.model_id).toBe(DEFAULT_VOYAGER_MODEL);
    expect(result.notes).toContain("cached_prompt_tokens=160");
  });

  it("actually drives the page: a click turn changes what the NEXT turn is shown", async () => {
    await page.setContent(`<button onclick="document.title='clicked'">Go</button>`);
    const { client, complete } = sequenceClient([click("button", "Go"), done(true)]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    const messages = complete.mock.calls[1]![0].messages;
    const lastUser = JSON.parse(messages[messages.length - 1]!.content);
    expect(lastUser.action_result).toBe("ok");
    expect(lastUser.page_state.title).toBe("clicked");
  });

  it("reports success:false from a done turn honestly", async () => {
    await page.setContent(`<button>Go</button>`);
    const { client } = sequenceClient([done(false)]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBeGreaterThan(0);
    expect(result.notes).toContain("done on turn 1");
  });

  it("stops at max turns — a measured failure with real tokens, never an error", async () => {
    await page.setContent(`<button>Go</button>`);
    const wait = chatReply({ done: false, action: { type: "wait", wait_ms: 0 } });
    const { client, complete } = sequenceClient([wait]);
    const result = await new VoyagerFreshBaselineClient({ client, maxTurns: 3 }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.turns).toBe(3);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.notes).toContain("max turns (3) exhausted");
    expect(result.tokens_in).toBe(300);
  });
});

describe("failure paths still report what they billed", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchTestBrowser();
    page = await browser.newPage();
    await page.setContent(`<button>Go</button>`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("a transport error ends the attempt without throwing, keeping prior turns' tokens, and is not retried", async () => {
    let calls = 0;
    const complete = vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => {
      calls++;
      if (calls === 1) return click("button", "Go", { prompt_tokens: 100, completion_tokens: 10 });
      throw new ChatHttpError(502, "bad gateway");
    });
    const result = await new VoyagerFreshBaselineClient({ client: { complete } }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBe(100);
    expect(result.tokens_out).toBe(10);
    expect(result.turns).toBe(1);
    expect(result.notes).toContain("failed on turn 2");
    expect(result.notes).toContain("502");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("a TRANSPORT failure is tagged aborted:transport — its cost is a truncation, not a measurement", async () => {
    let calls = 0;
    const complete = vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => {
      if (++calls === 1) return click("button", "Go", { prompt_tokens: 100, completion_tokens: 10 });
      throw new ChatTransportError("fetch failed — UND_ERR_SOCKET other side closed");
    });
    const result = await new VoyagerFreshBaselineClient({ client: { complete } }).attempt({ ...goal, page });
    expect(result.aborted).toBe("transport");
    expect(result.tokens_in).toBe(100);
    expect(result.notes).toContain("UND_ERR_SOCKET");
  });

  it("an HTTP error is NOT tagged — the gateway answered, so the attempt ended for a real reason", async () => {
    const complete = vi.fn(async (): Promise<ChatResponse> => {
      throw new ChatHttpError(502, "bad gateway");
    });
    const result = await new VoyagerFreshBaselineClient({ client: { complete } }).attempt({ ...goal, page });
    expect(result.aborted).toBeUndefined();
  });

  it("a refusal ends the attempt with the tokens consumed", async () => {
    const { client } = sequenceClient([
      { usage: { prompt_tokens: 90, completion_tokens: 5 }, choices: [{ message: { content: null, refusal: "no" } }] },
    ]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBe(90);
    expect(result.notes).toContain("refused");
  });

  it("unparseable output is a miss, not a crash, and still reports tokens", async () => {
    const { client } = sequenceClient([
      { usage: { prompt_tokens: 70, completion_tokens: 9 }, choices: [{ finish_reason: "length", message: { content: '{"done": fal' } }] },
    ]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBe(70);
    expect(result.notes).toContain("did not parse");
  });

  it("a decision missing the required shape is a miss, not a crash", async () => {
    const { client } = sequenceClient([chatReply({ done: false })]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.notes).toContain("expected shape");
  });

  it("an empty choices array is a miss, not a crash", async () => {
    const { client } = sequenceClient([{ usage: { prompt_tokens: 40, completion_tokens: 0 }, choices: [] }]);
    const result = await new VoyagerFreshBaselineClient({ client }).attempt({ ...goal, page });
    expect(result.task_success).toBe(false);
    expect(result.tokens_in).toBe(40);
  });
});
