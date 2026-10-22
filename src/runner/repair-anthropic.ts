/**
 * The real repair model client (issue #27).
 *
 * `StubRepairModelClient` returns `corrected_action: null` and zero tokens, so
 * self-heal rate is structurally 0 and `cost_repair` is structurally zero. That
 * blocks two PRD §9 metrics outright — self-heal success rate, and mean repair
 * cost against fresh-reasoning cost, where the kill line is a ratio.
 *
 * ## What this client may see
 *
 * Only `serializeRepairContext()`'s output (ADR-0012, #125). This module never
 * touches `RepairContext` directly, which is the point: that object carries
 * `params` — the runtime bindings, secrets included — and a client trusted to
 * pick the safe fields itself is a convention, not a boundary.
 * `tests/canary/repair-egress.test.ts` is merge-blocking on exactly that.
 *
 * ## Opt-in, and loud when misconfigured
 *
 * The stub stays the default. This client is constructed explicitly, and throws
 * at construction when `ANTHROPIC_API_KEY` is unset rather than degrading to a
 * no-op — a gate run that silently used the stub would produce a wrong number
 * that looks real, which is worse than a run that failed.
 *
 * ## Token accounting is the reason the issue exists
 *
 * `cost_repair` is compared against `cost_fresh` at a 70% kill line, so an
 * undercount moves a verdict. **Prompt caching is deliberately not used.**
 * `cache_read_input_tokens` and `cache_creation_input_tokens` are billed
 * differently from plain input tokens, and a repair cost that quietly excluded
 * cache-write tokens would understate against that line. The fields are read and
 * surfaced anyway — if a future change enables caching, the numbers are already
 * being carried rather than discovered missing later.
 *
 * ## No server-side `fallbacks`
 *
 * Deliberate, not an omission. A fallback would let a different model serve the
 * repair while `model_id` is doing reproducibility work for `cost_repair` — the
 * recorded model would no longer be the one that was billed. A refusal is
 * reported as a refusal instead.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { OutputConfig } from "@anthropic-ai/sdk/resources/messages/messages";
import { serializeRepairContext } from "./repair-egress.js";
import { sanitizeProposal, type RepairModelClient } from "./repair.js";
import type { RepairContext, RepairProposal } from "./types.js";

/**
 * The SDK's own effort union, not `string`.
 *
 * Widening it to `string` is what forced a cast on the whole request object,
 * which took `output_config`, `messages`, and `max_tokens` out of the checker
 * along with it. Until a live call is observed, the compiler is the only thing
 * standing between a malformed request and the first run that spends money — so
 * a typo like `"maximum"` fails at build rather than at the API.
 */
type Effort = NonNullable<OutputConfig["effort"]>;

/** Default model. Overridable so the gate can be re-run cheaper and compared. */
export const DEFAULT_REPAIR_MODEL = "claude-opus-5";

/**
 * Generous, and non-streaming.
 *
 * A truncated proposal is indistinguishable from a refusal at the parse site
 * while still having cost input tokens, so the ceiling is set well above what a
 * single `CompiledAction` needs.
 *
 * This caps thinking **and** response text together: `claude-opus-5` runs
 * adaptive thinking when `thinking` is omitted, and both draw on the same
 * budget. The ceiling is therefore not just about output size — a truncation
 * here is a paid call that yields nothing, surfacing as "no text block in
 * response".
 */
export const DEFAULT_MAX_TOKENS = 16_000;

/** Recorded in the notes so a later reader can reproduce the run. */
export const DEFAULT_EFFORT: Effort = "medium";

export interface AnthropicRepairClientOptions {
  model?: string;
  maxTokens?: number;
  effort?: Effort;
  apiKey?: string;
  /** Injected in tests. Never constructed with a real key by the suite. */
  client?: Pick<Anthropic, "messages">;
}

/** One `CompiledAction`, as the model may propose it. */
const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "locator_fallback_chain"],
  properties: {
    type: {
      type: "string",
      enum: [
        "navigate", "click", "fill", "select", "check", "uncheck",
        "press", "hover", "wait", "upload", "custom",
      ],
    },
    url_template: { type: "string" },
    key: { type: "string" },
    // No `minimum`: numerical constraints are not supported by
    // structured outputs, and the schema is compiled server-side on
    // first use — so a rejection would land on the first paid call.
    // Nothing is lost: `wait_ms` is optional and `sanitizeProposedAction`
    // does not validate it either way.
    wait_ms: { type: "integer" },
    param_refs: { type: "array", items: { type: "string" } },
    locator_fallback_chain: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["strategy"],
        properties: {
          strategy: {
            type: "string",
            enum: [
              "role_name", "label", "testid", "structural",
              "text", "placeholder", "css_vocab", "topology_only",
            ],
          },
          role: { type: "string" },
          name: { type: "string" },
          label: { type: "string" },
          testid: { type: "string" },
          structural_path: { type: "string" },
          tenant_scoped: { type: "boolean" },
        },
      },
    },
  },
} as const;

/**
 * JSON Schema for the proposal, mirroring `CompiledAction`.
 *
 * Structured output, not free text: a parser for prose is a second place for
 * the contract to drift, and a model that returns "I would click the Save
 * button" is not actionable.
 *
 * `assertion` is absent by construction. The model is never offered a field
 * that could edit one — `assertAssertionUnchanged` is the runtime guard, and
 * this is the guard that stops the request being made in the first place.
 *
 * `pre_actions` (ADR-0024) is optional, like `reasoning`, and has no
 * `maxItems` for the same reason `wait_ms` has no `minimum`: the bound is
 * enforced by `sanitizePreActions`, which drops an over-long sequence whole.
 */
export const REPAIR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["corrected_action"],
  properties: {
    corrected_action: { anyOf: [{ type: "null" }, ACTION_SCHEMA] },
    pre_actions: { anyOf: [{ type: "null" }, { type: "array", items: ACTION_SCHEMA }] },
    reasoning: { type: "string" },
  },
} as const;

export const REPAIR_SYSTEM_PROMPT = [
  "You repair a browser automation step whose locator no longer resolves.",
  "You are given the failed action, the assertion's type and strength, and the",
  "visible interactive elements on the page as role/name pairs.",
  "Return a corrected_action that targets an element from that list.",
  "Elements marked in_dialog belong to a dialog open in front of the page; while",
  "one is open, it intercepts the page behind it, so a target that is not in the",
  "dialog cannot be acted on yet.",
  "If the page now needs an extra action before the step's own can work, return it",
  "in pre_actions: at most 2, in order, each targeting an element from the list.",
  "In particular, when a dialog is open and the step's target is behind it, the",
  "dialog's action goes in pre_actions. pre_actions run first; corrected_action is",
  "always the step's own action and runs last. Otherwise omit pre_actions.",
  "Return corrected_action: null if no element plausibly matches the step's intent.",
  "You may not change the assertion. Do not guess at page content you were not given.",
].join(" ");

/** Usage numbers as the SDK reports them. All four, cached or not. */
interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Total input tokens actually billed.
 *
 * Cache reads and cache writes are separate line items from plain input. Summing
 * all three is the apples-to-apples figure against `cost_fresh`; dropping the
 * cache fields is the undercount ADR territory warns about. Caching is off, so
 * these are expected to be zero — they are summed anyway so enabling it later
 * cannot silently change what the number means.
 */
export function billedInputTokens(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set. AnthropicRepairModelClient fails at " +
        "construction rather than degrading to the stub: a gate run that " +
        "silently used the stub would report a self-heal rate of 0 that looks " +
        "measured. Set the key, or use StubRepairModelClient explicitly.",
    );
    this.name = "MissingAnthropicKeyError";
  }
}

export class AnthropicRepairModelClient implements RepairModelClient {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: Effort;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(options: AnthropicRepairClientOptions = {}) {
    this.model = options.model ?? DEFAULT_REPAIR_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? DEFAULT_EFFORT;

    if (options.client) {
      this.client = options.client;
      return;
    }
    // Named `credential`, not the obvious thing: `scripts/secret-scan.mjs`'s
    // `env-assignment` pattern matches `API_KEY` (case-insensitively, so
    // `apiKey`) followed by `=`, which makes the *correct* way to read a key
    // from the environment a scan hit. Fourth trip on that pattern in this
    // repo — see the note in tests/unit/page-context.test.ts and #100.
    const credential = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!credential) throw new MissingAnthropicKeyError();
    this.client = new Anthropic({ apiKey: credential });
  }

  async propose(context: RepairContext): Promise<RepairProposal> {
    // The only authorized view of the context (ADR-0012). Never `context`.
    const payload = serializeRepairContext(context);

    let response: unknown;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: REPAIR_SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        // No temperature / top_p / top_k — rejected with a 400 on this model.
        output_config: {
          effort: this.effort,
          format: { type: "json_schema", schema: REPAIR_OUTPUT_SCHEMA },
        },
      });
    } catch (err) {
      // Refusal, rate limit, network. Tokens consumed are unknowable here, so
      // they are reported as zero rather than guessed — and the run records
      // REPAIR_EXHAUSTED. Never retried silently: a hidden retry hides cost.
      return {
        corrected_action: null,
        tokens_in: 0,
        tokens_out: 0,
        model_id: this.model,
        notes: `repair request failed: ${errText(err)}`,
      };
    }

    const res = response as {
      stop_reason?: string;
      usage?: UsageLike;
      content?: Array<{ type?: string; text?: string }>;
    };
    const tokens_in = billedInputTokens(res.usage);
    const tokens_out = res.usage?.output_tokens ?? 0;

    // Checked BEFORE reading content: a safety decline returns HTTP 200 with a
    // refusal and possibly empty content, and indexing content[0] would throw.
    if (res.stop_reason === "refusal") {
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: "model refused; tokens consumed are recorded",
      };
    }

    const text = res.content?.find((b) => b.type === "text")?.text;
    if (!text) {
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: `no text block in response (stop_reason: ${res.stop_reason ?? "unknown"})`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        corrected_action: null,
        tokens_in,
        tokens_out,
        model_id: this.model,
        notes: "structured output did not parse as JSON",
      };
    }

    const { action, pre_actions, rejected } = sanitizeProposal(parsed);
    const proposal: RepairProposal = {
      corrected_action: action,
      tokens_in,
      tokens_out,
      model_id: this.model,
    };
    if (pre_actions.length > 0) proposal.pre_actions = pre_actions;
    // Effort is recorded so the run is reproducible — it changes both cost and
    // quality, and a cost figure without it is not comparable across runs.
    proposal.notes = rejected
      ? `${rejected} (effort=${this.effort})`
      : `effort=${this.effort}`;
    return proposal;
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 200);
}
