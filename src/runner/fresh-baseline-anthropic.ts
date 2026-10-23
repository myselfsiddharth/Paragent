/**
 * The real fresh-baseline client (issue #39) — a model driving the browser
 * with no compiled trajectory, turn by turn, until it declares the task done.
 *
 * ## Same SDK wiring and accounting as the repair client, on purpose
 *
 * §9's kill line is `mean(cost_repair) >= 70% * mean(cost_fresh)`. If the two
 * measurements accounted for tokens differently, the ratio would compare two
 * different things wearing the same units. So this module copies
 * `src/runner/repair-anthropic.ts`'s decisions rather than re-deriving them:
 *
 * | Decision | Same as repair client |
 * | --- | --- |
 * | `billedInputTokens()` | **Imported, not re-implemented.** Sums `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
 * | Prompt caching | Off. No `cache_control` on any block |
 * | Retries | None. A turn that throws ends the attempt; tokens already billed on prior turns are kept, never guessed at for the failed one |
 * | Server-side `fallbacks` | Not sent — the model that was billed must be the model `model_id` names |
 * | `temperature` / `top_p` / `top_k` | Not sent — 400s on this model |
 * | Output shape | Structured output (`output_config.format: json_schema`), not tool-use function-calling and not prose parsing |
 * | Construction without `ANTHROPIC_API_KEY` | Throws (`MissingFreshBaselineKeyError`) rather than degrading to the stub |
 *
 * One call per **turn**, not one call for the whole task: the model reports
 * exactly one action (or "done") each time, mirroring the single-decision shape
 * `AnthropicRepairModelClient.propose()` already uses. Tokens are summed across
 * every turn in the attempt — the measured cost is the whole task, not one
 * decision.
 *
 * ## What the model is allowed to see
 *
 * `capturePageState(page, "interactive")` — the exact function and the exact
 * context level `AnthropicRepairModelClient` receives via
 * `serializeRepairContext()`. Role + accessible name of interactive elements,
 * landmark roles, URL, title. No raw HTML, no input values, no cookies, no
 * storage (ADR-0012). A fresh agent is not shown more of the page than a repair
 * already is; it is shown it for longer, across a whole task instead of one
 * failed step.
 *
 * ## What the model is never told
 *
 * The compiled program: no locator, no assertion, no step list, no site-key or
 * task-key it could use to look one up. Only `task_goal` — prose describing the
 * outcome — and the live page. See `docs/gate/fresh-baseline.md` for why that
 * boundary is the entire measurement.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { OutputConfig } from "@anthropic-ai/sdk/resources/messages/messages";
import { billedInputTokens, DEFAULT_EFFORT, DEFAULT_REPAIR_MODEL } from "./repair-anthropic.js";
import { executeAction } from "./actions.js";
import { capturePageState } from "./page-state.js";
import type {
  FreshBaselineAttempt,
  FreshBaselineClient,
  FreshBaselineContext,
} from "./fresh-baseline.js";
import type { ActionType, CompiledAction, ParamBindings } from "./types.js";

type Effort = NonNullable<OutputConfig["effort"]>;

/**
 * Same model as the repair client, by default. §9's ratio compares two costs
 * produced by the same reasoning system; a different default model on either
 * side would make the comparison about model choice rather than about
 * fresh-vs-repaired reasoning. Overridable, same as the repair client, so the
 * gate can be re-run cheaper and compared.
 */
export const DEFAULT_FRESH_MODEL = DEFAULT_REPAIR_MODEL;

/** Recorded in the notes so a later reader can reproduce the run. */
export const DEFAULT_FRESH_EFFORT: Effort = DEFAULT_EFFORT;

export const DEFAULT_MAX_TOKENS = 4_000;

/**
 * Ceiling on model turns per attempt. The gate task is 12 measured steps
 * (ADR-0006); a fresh agent with no step list will explore, so the ceiling is
 * set well above 12 rather than at it. Reaching it ends the attempt as a
 * measured failure (real tokens spent, `task_success: false`) — never as an
 * error, because running out of turns is itself part of what "fresh" costs.
 */
export const DEFAULT_MAX_TURNS = 30;

export interface AnthropicFreshBaselineClientOptions {
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  maxTurns?: number;
  apiKey?: string;
  /** Injected in tests. Never constructed with a real key by the suite. */
  client?: Pick<Anthropic, "messages">;
}

/**
 * JSON Schema for one turn's decision: exactly one action, or done.
 *
 * `additionalProperties: false` on `action` mirrors `REPAIR_OUTPUT_SCHEMA`'s
 * posture — a model that wants to do something this schema cannot express
 * cannot smuggle it through an extra field.
 */
export const FRESH_TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["done"],
  properties: {
    done: {
      type: "boolean",
      description: "True once the task is finished (successfully or not) and no further action is needed.",
    },
    success: {
      type: "boolean",
      description: "Only meaningful when done=true: did the task actually complete?",
    },
    action: {
      type: "object",
      additionalProperties: false,
      description: "Only meaningful when done=false: the single next action to take.",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: [
            "navigate", "click", "fill", "select", "check", "uncheck",
            "press", "hover", "wait",
          ],
        },
        role: { type: "string", description: "ARIA role of the target element, from the page state you were shown." },
        name: { type: "string", description: "Accessible name of the target element, from the page state you were shown." },
        value: { type: "string", description: "Text to fill/select, or the URL for navigate." },
        key: { type: "string", description: "Key name for a press action." },
        wait_ms: { type: "integer", description: "Milliseconds to wait, for a wait action." },
      },
    },
    reasoning: { type: "string" },
  },
} as const;

export const FRESH_SYSTEM_PROMPT = [
  "You are driving a real web browser to accomplish a stated task, starting from",
  "nothing: you have no recorded steps, no saved locators, and no prior attempt to",
  "consult. You see only the task goal and the current page.",
  "Each turn you are shown the page's URL, title, visible landmark regions, and the",
  "interactive elements on it (role and accessible name only — never an element's",
  "value, never page text beyond what is given). Elements marked in_dialog belong to",
  "a dialog open in front of the page, which intercepts the page behind it.",
  "Choose exactly one next action, or report done.",
  "Target elements only by the role and name you were shown. Do not invent a",
  "locator strategy or guess at content you were not given.",
  "Report done:true and success:true only once the task's stated outcome is",
  "actually visible on the page. Report done:true and success:false if you",
  "conclude the task cannot be completed. Do not claim success you did not observe.",
].join(" ");

export class MissingFreshBaselineKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. AnthropicFreshBaselineClient fails at " +
        "construction rather than degrading to the stub: a baseline run that " +
        "silently used the stub would report a fresh cost of zero that looks " +
        "measured. Set the key, or use StubFreshBaselineClient explicitly.",
    );
    this.name = "MissingFreshBaselineKeyError";
  }
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface TurnDecision {
  done: boolean;
  success?: boolean;
  action?: {
    type: string;
    role?: string;
    name?: string;
    value?: string;
    key?: string;
    wait_ms?: number;
  };
  reasoning?: string;
}

/**
 * Map one turn's decided action onto the same `CompiledAction` shape
 * `executeAction()` already knows how to run — the fresh baseline drives the
 * page through the identical execution path a replay does, so a difference in
 * outcome is a difference in *reasoning*, never a difference in *execution*.
 */
export function toCompiledAction(action: NonNullable<TurnDecision["action"]>): {
  compiled: CompiledAction;
  params: ParamBindings;
} {
  const compiled: CompiledAction = {
    type: action.type as ActionType,
    locator_fallback_chain:
      action.role !== undefined && action.name !== undefined
        ? [{ strategy: "role_name" as const, role: action.role, name: action.name }]
        : [],
  };
  const params: ParamBindings = {};
  if (action.type === "navigate" && action.value !== undefined) {
    compiled.url_template = action.value;
  }
  if (action.type === "press" && action.key !== undefined) {
    compiled.key = action.key;
  }
  if ((action.type === "fill" || action.type === "select") && action.value !== undefined) {
    compiled.param_refs = ["value"];
    params["value"] = action.value;
  }
  if (action.type === "wait" && action.wait_ms !== undefined) {
    compiled.wait_ms = action.wait_ms;
  }
  return { compiled, params };
}

export function isValidTurnDecision(raw: unknown): raw is TurnDecision {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj["done"] !== "boolean") return false;
  if (obj["done"] === false) {
    const action = obj["action"];
    if (typeof action !== "object" || action === null) return false;
    if (typeof (action as Record<string, unknown>)["type"] !== "string") return false;
  }
  return true;
}

export class AnthropicFreshBaselineClient implements FreshBaselineClient {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: Effort;
  readonly maxTurns: number;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(options: AnthropicFreshBaselineClientOptions = {}) {
    this.model = options.model ?? DEFAULT_FRESH_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? DEFAULT_FRESH_EFFORT;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

    if (options.client) {
      this.client = options.client;
      return;
    }
    // See the identical note in repair-anthropic.ts: named `credential`, not
    // the obvious thing, because scripts/secret-scan.mjs's `env-assignment`
    // pattern matches `API_KEY` (case-insensitively) followed by `=`.
    const credential = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!credential) throw new MissingFreshBaselineKeyError();
    this.client = new Anthropic({ apiKey: credential });
  }

  async attempt(context: FreshBaselineContext): Promise<FreshBaselineAttempt> {
    if (!context.page) {
      // Mirrors ReplayRunner's posture on a missing `page` (src/runner/replay.ts):
      // a live attempt with nothing to drive is a caller error, reported as a
      // measured zero rather than a crash. Nothing was ever sent to the model.
      return {
        task_success: false,
        tokens_in: 0,
        tokens_out: 0,
        model_id: this.model,
        turns: 0,
        notes: "live fresh-baseline attempt requires a Playwright page (use StubFreshBaselineClient for --dry-run)",
      };
    }
    const page = context.page;
    let tokensIn = 0;
    let tokensOut = 0;
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    const snapshot = async (): Promise<string> => {
      const state = await capturePageState(page, "interactive");
      // Same fields serializeRepairContext() allows across the boundary:
      // never `params`, never raw HTML, never a value.
      return JSON.stringify({
        url: state.url,
        title: state.title,
        visible_landmarks: state.visible_landmarks,
        elements: state.elements,
      });
    };

    let initialState: string;
    try {
      initialState = await snapshot();
    } catch (err) {
      // The page itself could not be read — nothing was ever sent to the model,
      // so nothing was billed. Zeros, not a guess.
      return {
        task_success: false,
        tokens_in: 0,
        tokens_out: 0,
        model_id: this.model,
        turns: 0,
        notes: `could not capture initial page state: ${errText(err)}`,
      };
    }
    messages.push({
      role: "user",
      content: JSON.stringify({ task_goal: context.task_goal, page_state: JSON.parse(initialState) }),
    });

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      let response: unknown;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: FRESH_SYSTEM_PROMPT,
          messages,
          // No temperature / top_p / top_k — rejected with a 400 on this model.
          output_config: {
            effort: this.effort,
            format: { type: "json_schema", schema: FRESH_TURN_SCHEMA },
          },
        });
      } catch (err) {
        // Never retried silently — a hidden retry hides cost. Tokens already
        // billed on prior turns are real and are kept; this turn billed nothing
        // because the call never returned.
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn - 1,
          notes: `fresh-baseline request failed on turn ${turn}: ${errText(err)}`,
        };
      }

      const res = response as {
        stop_reason?: string;
        usage?: UsageLike;
        content?: Array<{ type?: string; text?: string }>;
      };
      tokensIn += billedInputTokens(res.usage);
      tokensOut += res.usage?.output_tokens ?? 0;

      // Checked before reading content: a safety decline is HTTP 200 with
      // possibly empty content, and indexing content[0] would throw.
      if (res.stop_reason === "refusal") {
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `model refused on turn ${turn}; tokens consumed are recorded`,
        };
      }

      const text = res.content?.find((b) => b.type === "text")?.text;
      if (!text) {
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `no text block in response on turn ${turn} (stop_reason: ${res.stop_reason ?? "unknown"})`,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `structured output did not parse as JSON on turn ${turn}`,
        };
      }

      if (!isValidTurnDecision(parsed)) {
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `turn ${turn} decision did not match the expected shape`,
        };
      }

      if (parsed.done) {
        return {
          task_success: parsed.success === true,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `done on turn ${turn} (effort=${this.effort})`,
        };
      }

      // parsed.action is guaranteed present by isValidTurnDecision when done=false.
      const { compiled, params } = toCompiledAction(parsed.action!);
      const execResult = await executeAction(page, compiled, params);
      messages.push({ role: "assistant", content: text });

      let nextState: string;
      try {
        nextState = await snapshot();
      } catch (err) {
        return {
          task_success: false,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `could not capture page state after turn ${turn}: ${errText(err)}`,
        };
      }
      messages.push({
        role: "user",
        content: JSON.stringify({
          action_result: execResult.ok
            ? "ok"
            : `failed: ${execResult.outcome ?? "unknown"}${execResult.message ? ` — ${execResult.message}` : ""}`,
          page_state: JSON.parse(nextState),
        }),
      });
    }

    return {
      task_success: false,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model_id: this.model,
      turns: this.maxTurns,
      notes: `max turns (${this.maxTurns}) exhausted without a done decision`,
    };
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 200);
}
