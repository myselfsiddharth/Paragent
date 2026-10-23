/**
 * The one thing a repair client may send (ADR-0012, issue #125).
 *
 * `RepairContext` is an in-process object. It holds the frozen assertion, the
 * compiled step, the page snapshot — and `params`, which is
 * `Record<string, string | number | boolean>`: the runtime bindings, including
 * whatever a caller named like a secret. Handing that object to a model client
 * and trusting each client to send only the safe parts is not a boundary, it is
 * a convention.
 *
 * #27 will wire a real Anthropic client. When it does, the repair prompt becomes
 * a **new egress path** — the first one in this codebase that sends page-derived
 * content to a third party — and today nothing asserts what would leave. This
 * module is that assertion: `serializeRepairContext()` is the only authorized
 * shape, it is built by naming fields rather than by removing them, and
 * `tests/canary/repair-egress.test.ts` is merge-blocking.
 *
 * ## Allowlist, not denylist
 *
 * Every field below is written out explicitly. Nothing is spread, nothing is
 * deleted from a copy. A denylist would let a field added to `RepairContext`
 * next year ride out by default; this way a new field is invisible to the model
 * until someone adds a line here, and adding that line is a diff a reviewer
 * sees.
 *
 * ## What is deliberately excluded
 *
 * | Excluded | Why |
 * | --- | --- |
 * | `params` | The runtime bindings. Values a caller supplied, including secrets. Never leaves. |
 * | `assertion.expected.template` | Carries typed holes *and*, if a compiler bug ever let one through, a literal |
 * | `step.compiled_action.param_refs` | Names of the caller's slots. Structure, but no reason for the model to need it |
 * | `error_message` | Playwright text that can quote page content and, on a `fill`, the value it tried |
 *
 * `task_goal` (ADR-0025) is **included** when the caller set one: developer-
 * authored prose, the same text the fresh baseline is given. It is not page
 * content, and `ReplayRunner.run` refuses a goal containing a bound value.
 *
 * `error_message` is the one worth pausing on: it reads like diagnostics, and it
 * is the field a well-meaning change would add first. A Playwright locator error
 * can include the resolved selector and surrounding text, so it is page content
 * arriving through a channel nobody classified.
 */

import type { ContextElement, ContextLevel } from "../shared/page-context.js";
import type { RepairContext } from "./types.js";

/**
 * Exactly what may be sent to a repair model.
 *
 * Flat and boring on purpose: a reviewer should be able to read this interface
 * and know the full extent of the egress without following a call graph.
 */
export interface RepairEgressPayload {
  /** Which budget produced `page`, so a self-heal rate is reproducible. */
  context_level: ContextLevel;
  failed_outcome: string;
  attempt: number;
  step: {
    step_index: number;
    /** What the step was trying to do, e.g. "click". Not what it was given. */
    action_type: string;
    /** The locator that failed, so the model knows what to replace. */
    failed_locators: Array<Record<string, string | boolean>>;
  };
  assertion: {
    /** Type and strength only — never `expected`. */
    type: string;
    strength: string;
  };
  page: {
    url: string;
    title: string;
    visible_landmarks: string[];
    elements: ContextElement[];
  };
  /** What the whole task is for (ADR-0025). Present only when the caller set one. */
  task_goal?: string;
}

/**
 * Locator fields a repair may see.
 *
 * `text` is absent: a free-text locator is page content by definition, and the
 * cache's own boundary already treats it as tenant-tainted
 * (`src/cache/allowlist.ts`). A model that cannot see the old text locator can
 * still propose a better one from `page.elements`.
 */
const LOCATOR_FIELD_ALLOWLIST = [
  "strategy",
  "role",
  "name",
  "label",
  "testid",
  "structural_path",
  "tenant_scoped",
] as const;

function safeLocator(
  locator: Record<string, unknown>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of LOCATOR_FIELD_ALLOWLIST) {
    const value = locator[field];
    if (typeof value === "string" || typeof value === "boolean") out[field] = value;
  }
  return out;
}

/**
 * Build the authorized payload.
 *
 * The only supported way to turn a `RepairContext` into something sendable. A
 * client that reaches past this and serializes the context itself is outside
 * the boundary, and `tests/canary/repair-egress.test.ts` asserts no client in
 * the tree does.
 */
export function serializeRepairContext(ctx: RepairContext): RepairEgressPayload {
  const page = ctx.page_state;
  const payload: RepairEgressPayload = {
    context_level: page.context_level ?? "landmarks",
    failed_outcome: ctx.failed_outcome,
    attempt: ctx.attempt,
    step: {
      step_index: ctx.step.step_index,
      action_type: ctx.step.compiled_action.type,
      failed_locators: (ctx.step.compiled_action.locator_fallback_chain ?? []).map(
        (l) => safeLocator(l as unknown as Record<string, unknown>),
      ),
    },
    assertion: {
      type: ctx.assertion.type,
      strength: ctx.assertion.strength,
    },
    page: {
      url: page.url,
      title: page.title,
      visible_landmarks: page.visible_landmarks,
      elements: page.elements ?? [],
    },
  };
  if (typeof ctx.task_goal === "string" && ctx.task_goal !== "") {
    payload.task_goal = ctx.task_goal;
  }
  return payload;
}
