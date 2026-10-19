/**
 * The fresh-baseline client for ASU's Voyager gateway (issue #39).
 *
 * The other half of `VoyagerRepairModelClient`: §9's kill line is
 * `mean(cost_repair) >= 70% * mean(cost_fresh)`, so both arms have to be
 * produced by the same model on the same gateway or the ratio compares model
 * choice instead of fresh-vs-repaired reasoning. `DEFAULT_VOYAGER_MODEL` is
 * shared for exactly that reason.
 *
 * ## Same loop, same boundary, same failure posture
 *
 * The turn schema, system prompt, `toCompiledAction`, and `isValidTurnDecision`
 * are imported from `fresh-baseline-anthropic.ts`, so the model is shown the
 * same page state, offered the same actions, and its decisions run through the
 * same `executeAction()` as in the Anthropic arm. A difference in outcome is a
 * difference in reasoning, never in execution. See that file's header for the
 * full list of what the model is and is not told (never the compiled program).
 *
 * One call per turn; no retries (a turn that throws ends the attempt and keeps
 * the tokens already billed on prior turns); no fallback model; construction
 * without `VOYAGER_API_KEY` throws rather than degrading to the stub.
 *
 * Token accounting is `chat-openai.ts`'s, not `billedInputTokens()`'s:
 * OpenAI-spec `prompt_tokens` already includes cached tokens, so summing cache
 * fields as the Anthropic client does would double-count. Read that file's
 * header before comparing the two arms' numbers.
 *
 * One honest limit: every turn resends the whole transcript, so `tokens_in`
 * grows quadratically with turn count. Server-side prefix caching on the fleet
 * makes this cheap in wall-clock terms but not in `prompt_tokens`, which counts
 * cached tokens too — the cached share is written into the notes.
 */

import {
  ChatTransportError,
  billedCompletionTokens,
  billedPromptTokens,
  cachedPromptTokens,
  parseJsonReply,
  type ChatClient,
  type ChatMessage,
  type ChatResponse,
} from "./chat-openai.js";
import { executeAction } from "./actions.js";
import {
  FRESH_SYSTEM_PROMPT,
  FRESH_TURN_SCHEMA,
  DEFAULT_MAX_TURNS,
  isValidTurnDecision,
  toCompiledAction,
} from "./fresh-baseline-anthropic.js";
import type {
  FreshBaselineAttempt,
  FreshBaselineClient,
  FreshBaselineContext,
} from "./fresh-baseline.js";
import { capturePageState } from "./page-state.js";
import {
  DEFAULT_VOYAGER_MAX_TOKENS,
  DEFAULT_VOYAGER_MODEL,
  VOYAGER_TEMPERATURE,
  buildVoyagerChatClient,
} from "./repair-voyager.js";

export interface VoyagerFreshBaselineClientOptions {
  model?: string;
  maxTokens?: number;
  maxTurns?: number;
  baseUrl?: string;
  apiKey?: string;
  /** Injected in tests. Never constructed with a real key by the suite. */
  client?: ChatClient;
}

export class VoyagerFreshBaselineClient implements FreshBaselineClient {
  readonly model: string;
  readonly maxTokens: number;
  readonly maxTurns: number;
  private readonly client: ChatClient;

  constructor(options: VoyagerFreshBaselineClientOptions = {}) {
    this.model = options.model ?? DEFAULT_VOYAGER_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_VOYAGER_MAX_TOKENS;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.client = options.client ?? buildVoyagerChatClient(options);
  }

  async attempt(context: FreshBaselineContext): Promise<FreshBaselineAttempt> {
    if (!context.page) {
      // Mirrors the Anthropic client and ReplayRunner: a live attempt with
      // nothing to drive is a caller error, reported as a measured zero rather
      // than a crash. Nothing was ever sent to the model.
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
    let cachedIn = 0;
    const messages: ChatMessage[] = [{ role: "system", content: FRESH_SYSTEM_PROMPT }];

    const provenance = (): string =>
      `provider=voyager temperature=${VOYAGER_TEMPERATURE} cached_prompt_tokens=${cachedIn}`;

    const snapshot = async (): Promise<string> => {
      const state = await capturePageState(page, "interactive");
      // Same fields serializeRepairContext() allows across the boundary: never
      // `params`, never raw HTML, never a value.
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
      // The page itself could not be read — nothing was sent, nothing billed.
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

    const failed = (turns: number, why: string): FreshBaselineAttempt => ({
      task_success: false,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model_id: this.model,
      turns,
      notes: `${why} (${provenance()})`,
    });

    for (let turn = 1; turn <= this.maxTurns; turn++) {
      let response: ChatResponse;
      try {
        response = await this.client.complete({
          model: this.model,
          max_tokens: this.maxTokens,
          temperature: VOYAGER_TEMPERATURE,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: { name: "fresh_turn", strict: true, schema: FRESH_TURN_SCHEMA },
          },
        });
      } catch (err) {
        // Never retried silently. Tokens billed on prior turns are real and are
        // kept; this turn billed nothing because the call never returned. A
        // transport failure is tagged so the summary can tell a truncated
        // attempt from one the model actually finished or gave up on.
        const attempt = failed(turn - 1, `fresh-baseline request failed on turn ${turn}: ${errText(err)}`);
        return err instanceof ChatTransportError ? { ...attempt, aborted: "transport" } : attempt;
      }

      tokensIn += billedPromptTokens(response.usage);
      tokensOut += billedCompletionTokens(response.usage);
      cachedIn += cachedPromptTokens(response.usage);
      const choice = response.choices?.[0];

      if (choice?.message?.refusal) {
        return failed(turn, `model refused on turn ${turn}; tokens consumed are recorded`);
      }
      const text = choice?.message?.content;
      if (!text) {
        return failed(
          turn,
          `no content in response on turn ${turn} (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
        );
      }

      let parsed: unknown;
      try {
        parsed = parseJsonReply(text);
      } catch {
        return failed(
          turn,
          `structured output did not parse as JSON on turn ${turn} (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
        );
      }
      if (!isValidTurnDecision(parsed)) {
        return failed(turn, `turn ${turn} decision did not match the expected shape`);
      }

      if (parsed.done) {
        return {
          task_success: parsed.success === true,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model_id: this.model,
          turns: turn,
          notes: `done on turn ${turn} (${provenance()})`,
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
        return failed(turn, `could not capture page state after turn ${turn}: ${errText(err)}`);
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

    return failed(this.maxTurns, `max turns (${this.maxTurns}) exhausted without a done decision`);
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 200);
}
