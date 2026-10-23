/**
 * Repair proposals may correct actions only — never assertions.
 * Source: contracts/assertion.schema.json description (repair MUST NOT weaken).
 */

import { assertionsEqual } from "./templates.js";
import type { Assertion, CompiledAction, RepairContext, RepairProposal } from "./types.js";

export interface RepairModelClient {
  propose(context: RepairContext): Promise<RepairProposal>;
}

/**
 * Stub until a real model client is wired.
 * Returns corrected_action: null and zero tokens — never invents repair success.
 */
export class StubRepairModelClient implements RepairModelClient {
  async propose(_context: RepairContext): Promise<RepairProposal> {
    // TODO(model-wiring): plug in LLM / agent repair that proposes corrected_action only.
    return {
      corrected_action: null,
      tokens_in: 0,
      tokens_out: 0,
      notes: "StubRepairModelClient — no model wired",
    };
  }
}

/**
 * Strip anything that is not a corrected action.
 *
 * A proposal that carries an `assertion` key is not merged and not
 * partially honoured — it is dropped whole. `assertAssertionUnchanged` would
 * catch a mutation after the fact; this refuses to carry one forward at all,
 * which is the difference between detecting a violation and not committing one.
 *
 * Lives here, next to the client contract, rather than beside one client (#189).
 * It was written for `AnthropicRepairModelClient`, but it guards the *invariant*,
 * not that client's parse path — and a second client that re-implemented it
 * would be a second place for the frozen-assertion rule to drift. Importing it
 * from `repair-anthropic.ts` would also make a client whose whole purpose is
 * needing no API key load the Anthropic SDK.
 */
export function sanitizeProposedAction(raw: unknown): {
  action: CompiledAction | null;
  rejected?: string;
} {
  if (raw === null || raw === undefined) return { action: null };
  if (typeof raw !== "object") return { action: null, rejected: "not an object" };

  const obj = raw as Record<string, unknown>;
  if ("assertion" in obj || "expected" in obj || "timeout_ms" in obj) {
    return {
      action: null,
      rejected: "proposal attempted to modify the assertion; dropped whole",
    };
  }
  if (typeof obj["type"] !== "string") {
    return { action: null, rejected: "no action type" };
  }
  if (!Array.isArray(obj["locator_fallback_chain"])) {
    return { action: null, rejected: "no locator_fallback_chain" };
  }
  return { action: obj as unknown as CompiledAction };
}

/**
 * The most actions a step may run before its own (ADR-0024, #213). A step is
 * then at most three actions under one post-condition. The bound is what keeps
 * a "repair" from becoming a re-recording of the task under a step's name.
 */
export const MAX_PRE_ACTIONS = 2;

/**
 * Validate a proposal's `pre_actions`.
 *
 * Absent or null is "none". Anything malformed, or longer than
 * `MAX_PRE_ACTIONS`, rejects the **whole proposal**, the same posture
 * `sanitizeProposedAction` takes: a sequence missing one of its actions would
 * replay a different task than the one proposed.
 */
export function sanitizePreActions(raw: unknown): {
  actions: CompiledAction[];
  rejected?: string;
} {
  if (raw === null || raw === undefined) return { actions: [] };
  if (!Array.isArray(raw)) return { actions: [], rejected: "pre_actions is not an array" };
  if (raw.length > MAX_PRE_ACTIONS) {
    return {
      actions: [],
      rejected: `pre_actions has ${raw.length} actions (max ${MAX_PRE_ACTIONS}); dropped whole`,
    };
  }
  const actions: CompiledAction[] = [];
  for (const [i, item] of raw.entries()) {
    const { action, rejected } = sanitizeProposedAction(item);
    if (!action) {
      return {
        actions: [],
        rejected: `pre_actions[${i}]: ${rejected ?? "null"}; dropped whole`,
      };
    }
    actions.push(action);
  }
  return { actions };
}

/**
 * The model's whole structured output → a proposal's action fields.
 *
 * One place for every client (Anthropic, Voyager, delegated) so the
 * pre-action rule cannot drift between providers while a ratio is computed
 * across them.
 */
export function sanitizeProposal(raw: unknown): {
  action: CompiledAction | null;
  pre_actions: CompiledAction[];
  rejected?: string;
} {
  const obj = (raw ?? {}) as { corrected_action?: unknown; pre_actions?: unknown };
  const { action, rejected } = sanitizeProposedAction(obj.corrected_action);
  if (!action) {
    const out: { action: null; pre_actions: CompiledAction[]; rejected?: string } = {
      action: null,
      pre_actions: [],
    };
    if (rejected !== undefined) out.rejected = rejected;
    return out;
  }
  const pre = sanitizePreActions(obj.pre_actions);
  if (pre.rejected !== undefined) {
    return { action: null, pre_actions: [], rejected: pre.rejected };
  }
  return { action, pre_actions: pre.actions };
}

/** Throws if repair mutated the frozen assertion. */
export function assertAssertionUnchanged(
  original: Assertion,
  current: Assertion,
): void {
  if (!assertionsEqual(original, current)) {
    throw new Error(
      "repair violated invariant: assertion must not change (never weaken assertions)",
    );
  }
}
