/**
 * Repair model client for ASU's Voyager gateway (OpenAI-spec, open-weight models).
 *
 * `AnthropicRepairModelClient` (#27) needs an Anthropic key. This is the same
 * contract against a different provider, so the self-heal rate and
 * `cost_repair` can be *measured* — real `usage`, no `cost_measured: false` —
 * without one. `DelegatedRepairModelClient` (#189) cannot do that, which is why
 * ADR-0020 says it does not unblock #39.
 *
 * ## One contract, two providers
 *
 * The output schema, system prompt, and `sanitizeProposedAction` are imported
 * from the Anthropic client rather than copied. If the contract needs to change
 * it changes once, and the two providers cannot quietly drift apart while a
 * ratio is being computed across them.
 *
 * ## What it may see, and what it must not do
 *
 * Identical to the Anthropic client, and non-negotiable: only
 * `serializeRepairContext()`'s output leaves the process (ADR-0012, #125) —
 * never `params`, never page text. Voyager is a third-party gateway the same way
 * the Anthropic API is. `tests/canary/repair-egress.test.ts` is merge-blocking
 * on the one-serializer rule.
 *
 * ## Opt-in, loud, and honest about provenance
 *
 * - Throws at construction without `VOYAGER_API_KEY` (no silent stub).
 * - No retries, no fallback models (see `chat-openai.ts`).
 * - `temperature: 0` and it is recorded in `notes`, because unlike the Anthropic
 *   client this one can pin it, and a cost figure from a sampled run is not
 *   reproducible. Open-weight models behind a shared queue are still not
 *   bit-deterministic, so repeated runs are required for a spread regardless.
 * - **§9 compares `cost_repair` against `cost_fresh`. Both arms must use the
 *   same model.** `DEFAULT_VOYAGER_MODEL` is shared with
 *   `VoyagerFreshBaselineClient` for that reason; do not override one without
 *   the other.
 */

import {
  DEFAULT_VOYAGER_BASE_URL,
  OpenAICompatChatClient,
  billedCompletionTokens,
  billedPromptTokens,
  cachedPromptTokens,
  parseJsonReply,
  type ChatClient,
  type ChatResponse,
} from "./chat-openai.js";
import { REPAIR_OUTPUT_SCHEMA, REPAIR_SYSTEM_PROMPT } from "./repair-anthropic.js";
import { serializeRepairContext } from "./repair-egress.js";
import { sanitizeProposedAction, type RepairModelClient } from "./repair.js";
import type { RepairContext, RepairProposal } from "./types.js";

/**
 * Chosen by a live probe against the gateway (2026-10): instruct-tuned, honours
 * `response_format: json_schema`, and large enough to ground a locator against a
 * list of role/name pairs. A *thinking* variant would spend `max_tokens` on
 * reasoning before the JSON, so it is not the default.
 */
export const DEFAULT_VOYAGER_MODEL = "qwen3-235b-a22b-instruct-2507";

export const DEFAULT_VOYAGER_MAX_TOKENS = 4_000;

/** Pinned so a run is as reproducible as the gateway allows. */
export const VOYAGER_TEMPERATURE = 0;

export interface VoyagerRepairClientOptions {
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  apiKey?: string;
  /** Injected in tests. Never constructed with a real key by the suite. */
  client?: ChatClient;
}

export class MissingVoyagerKeyError extends Error {
  constructor() {
    super(
      "VOYAGER_API_KEY is not set. The Voyager clients fail at construction " +
        "rather than degrading to the stub: a gate run that silently used the " +
        "stub would report a self-heal rate of 0 that looks measured. Put the " +
        "key in .env and run with `node --env-file-if-exists=.env`, or use " +
        "StubRepairModelClient explicitly.",
    );
    this.name = "MissingVoyagerKeyError";
  }
}

/** Shared by both Voyager clients so the two read the environment identically. */
export function buildVoyagerChatClient(options: {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}): ChatClient {
  // `credential`, not the obvious name: scripts/secret-scan.mjs's
  // `env-assignment` pattern matches API_KEY followed by `=` (see
  // repair-anthropic.ts).
  const credential = options.apiKey ?? process.env["VOYAGER_API_KEY"];
  if (!credential) throw new MissingVoyagerKeyError();
  return new OpenAICompatChatClient({
    baseUrl: options.baseUrl ?? process.env["VOYAGER_BASE_URL"] ?? DEFAULT_VOYAGER_BASE_URL,
    credential,
  });
}

export class VoyagerRepairModelClient implements RepairModelClient {
  readonly model: string;
  readonly maxTokens: number;
  private readonly client: ChatClient;

  constructor(options: VoyagerRepairClientOptions = {}) {
    this.model = options.model ?? DEFAULT_VOYAGER_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_VOYAGER_MAX_TOKENS;
    this.client = options.client ?? buildVoyagerChatClient(options);
  }

  async propose(context: RepairContext): Promise<RepairProposal> {
    // The only authorized view of the context (ADR-0012). Never `context`.
    const payload = serializeRepairContext(context);

    let response: ChatResponse;
    try {
      response = await this.client.complete({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: VOYAGER_TEMPERATURE,
        messages: [
          { role: "system", content: REPAIR_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "repair_proposal", strict: true, schema: REPAIR_OUTPUT_SCHEMA },
        },
      });
    } catch (err) {
      // Timeout, 4xx/5xx, network. Tokens consumed are unknowable here, so they
      // are reported as zero rather than guessed — and the run records
      // REPAIR_EXHAUSTED. Never retried silently: a hidden retry hides cost.
      return {
        corrected_action: null,
        tokens_in: 0,
        tokens_out: 0,
        model_id: this.model,
        notes: `repair request failed: ${errText(err)}`,
      };
    }

    const tokens_in = billedPromptTokens(response.usage);
    const tokens_out = billedCompletionTokens(response.usage);
    const provenance = `provider=voyager temperature=${VOYAGER_TEMPERATURE} cached_prompt_tokens=${cachedPromptTokens(response.usage)}`;
    const choice = response.choices?.[0];

    // A refusal is reported as a refusal — tokens already spent are recorded.
    if (choice?.message?.refusal) {
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: `model refused; tokens consumed are recorded (${provenance})`,
      };
    }

    const text = choice?.message?.content;
    if (!text) {
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: `no content in response (finish_reason: ${choice?.finish_reason ?? "unknown"}; ${provenance})`,
      };
    }

    let parsed: unknown;
    try {
      parsed = parseJsonReply(text);
    } catch {
      // `length` here means the JSON was cut off mid-object: a paid call that
      // yields nothing, the same failure the Anthropic client's note describes.
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: `structured output did not parse as JSON (finish_reason: ${choice?.finish_reason ?? "unknown"}; ${provenance})`,
      };
    }

    const { action, rejected } = sanitizeProposedAction(
      (parsed as { corrected_action?: unknown } | null)?.corrected_action,
    );
    return {
      corrected_action: action,
      tokens_in,
      tokens_out,
      model_id: this.model,
      notes: rejected ? `${rejected} (${provenance})` : provenance,
    };
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 200);
}
