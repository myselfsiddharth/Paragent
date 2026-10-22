/**
 * The repair client that owns no API key (issue #189).
 *
 * `AnthropicRepairModelClient` (#27) makes Paragent buy its own inference. That
 * imposes a shape the thesis does not require: the pitch is giving an agent
 * *that already exists* the ability to drive a browser without paying full
 * reasoning cost every run — and such an agent already has model access. Making
 * it provision a second credential means the user pays twice and manages a key
 * they did not need. With `npx paragent` as the advertised Quick Start, that is
 * the difference between "works out of the box" and "works after you provision
 * a key".
 *
 * So: this client does not call a model. `propose()` hands the **caller** the
 * authorized repair request and takes back a proposal. The host does the
 * reasoning on its own budget.
 *
 * ## A callback, not a protocol
 *
 * An injected async function is the smallest thing that works, and it is the
 * primitive an MCP tool would wrap rather than replace. The transport question
 * (#189, design question 1) is therefore deferred, not answered — no wire
 * format is frozen here.
 *
 * ## The egress boundary is unchanged
 *
 * The handler receives `serializeRepairContext()`'s output and nothing else
 * (ADR-0012, #125). Delegation makes that boundary *more* important, not less:
 * the host is a third party the same way the Anthropic API is, and the
 * `RepairContext` this module never touches carries `params` — the runtime
 * bindings, secrets included. There is no second serializer, which is what
 * `tests/canary/repair-egress.test.ts` is merge-blocking on.
 *
 * ## Tokens are not observable here, and are never estimated
 *
 * The host pays, and a host does not report per-call usage back to a library.
 * So `tokens_in` / `tokens_out` are `0` with `cost_measured: false` — a flag,
 * not a comment, because a zero that means "unmeasured" and a zero that means
 * "no inference ran" are indistinguishable in a `Cost`. Folded into §9 as zeros
 * they would deflate `mean(cost_repair)` and manufacture a *passing* kill-line
 * ratio, which is the most damaging error this project can make (#189
 * constraint 1, CONTRIBUTING rule 3). `ADR-0020` carries the field and the
 * exclusion; `repairCostVsFresh()` and `amortizedTokensOverN()` enforce it.
 *
 * **This does not unblock #39.** A measured denominator still needs a real
 * `usage` block, which is exactly what a delegated client cannot produce.
 */

import { sanitizeProposal, type RepairModelClient } from "./repair.js";
import { serializeRepairContext, type RepairEgressPayload } from "./repair-egress.js";
import type { RepairContext, RepairProposal } from "./types.js";

/**
 * What the host may send back.
 *
 * `corrected_action` is `unknown` on purpose: it crosses a trust boundary and
 * is validated by `sanitizeProposedAction`, the same gate the model client's
 * structured output goes through. Typing it as `CompiledAction` here would
 * assert a shape nobody checked.
 *
 * There is no token field. Accepting one would invite a host to supply a
 * plausible number, and a plausible number is an estimate.
 */
export interface DelegatedRepairResponse {
  corrected_action?: unknown;
  /** ADR-0024: up to `MAX_PRE_ACTIONS` actions to run first. Validated like `corrected_action`. */
  pre_actions?: unknown;
  /** What the host used, if it cares to say. Recorded for reproducibility only. */
  model_id?: string;
  notes?: string;
}

/**
 * The host's repair function.
 *
 * Returning `null` or `undefined` is an explicit decline and is a first-class
 * answer — a host that cannot or will not repair says so, and the run records
 * `REPAIR_EXHAUSTED`.
 */
export type RepairRequestHandler = (
  request: RepairEgressPayload,
) =>
  | Promise<DelegatedRepairResponse | null | undefined>
  | DelegatedRepairResponse
  | null
  | undefined;

/**
 * Marks every proposal this client produces.
 *
 * Machine-readable state lives in `cost_measured`; this string is for the human
 * reading an NDJSON row and wondering why a repair cost nothing.
 */
export const DELEGATED_COST_NOTE =
  "delegated repair: the host paid for inference; tokens are not observable and are NOT estimated";

/**
 * Two minutes.
 *
 * A host agent's repair is a whole model turn, possibly behind its own tool
 * loop or a human, so the ceiling is generous. It exists because a handler that
 * never settles would hang the run past its own wall-clock budget with no row
 * to show for it — the budget guard (#84, ADR-0011) is checked *between* steps
 * and cannot interrupt an in-flight `propose()`.
 */
export const DEFAULT_DELEGATED_TIMEOUT_MS = 120_000;

export interface DelegatedRepairClientOptions {
  handler: RepairRequestHandler;
  /** `<= 0` disables the ceiling. Use only where the caller has its own. */
  timeoutMs?: number;
}

export class DelegatedRepairModelClient implements RepairModelClient {
  readonly timeoutMs: number;
  private readonly handler: RepairRequestHandler;

  constructor(options: DelegatedRepairClientOptions) {
    if (typeof options.handler !== "function") {
      throw new TypeError(
        "DelegatedRepairModelClient requires a handler function. Without one " +
          "there is nobody to delegate to — use StubRepairModelClient if you " +
          "want repair to propose nothing.",
      );
    }
    this.handler = options.handler;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DELEGATED_TIMEOUT_MS;
  }

  async propose(context: RepairContext): Promise<RepairProposal> {
    // The only authorized view of the context (ADR-0012). Never `context`.
    const request = serializeRepairContext(context);

    let response: DelegatedRepairResponse | null | undefined;
    try {
      response = await this.withTimeout(request);
    } catch (err) {
      // A host declining loudly is still a decline. Reported, never retried:
      // a silent retry loop is both a hidden cost and an unbounded one, and
      // #189 requires a non-answer to land on REPAIR_EXHAUSTED like any other
      // failed proposal.
      return this.proposal(null, `repair handler failed: ${errText(err)}`);
    }

    if (response === null || response === undefined) {
      return this.proposal(null, "host declined to propose a repair");
    }
    if (typeof response !== "object") {
      return this.proposal(null, "host returned a non-object response");
    }

    const { action, pre_actions, rejected } = sanitizeProposal(response);
    const note = [rejected, response.notes].filter(Boolean).join("; ");
    const proposal = this.proposal(action, note);
    if (pre_actions.length > 0) proposal.pre_actions = pre_actions;
    if (typeof response.model_id === "string" && response.model_id.length > 0) {
      // Reproducibility only. It never makes the cost measured — see the
      // module note and ADR-0020.
      proposal.model_id = response.model_id;
    }
    return proposal;
  }

  /**
   * Race the handler against the ceiling.
   *
   * A timeout cannot cancel the host's work, so the losing promise is given a
   * no-op rejection handler: a handler that rejects after the race is settled
   * would otherwise surface as an unhandled rejection and, under Node's
   * default, take the process down mid-run.
   */
  private async withTimeout(
    request: RepairEgressPayload,
  ): Promise<DelegatedRepairResponse | null | undefined> {
    const pending = Promise.resolve(this.handler(request));
    if (this.timeoutMs <= 0) return pending;

    pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`host did not answer within ${this.timeoutMs}ms`),
              ),
            this.timeoutMs,
          );
          // Never hold the process open for a repair ceiling.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Every exit builds its proposal here, so no path can forget the flag. */
  private proposal(
    action: RepairProposal["corrected_action"],
    note?: string,
  ): RepairProposal {
    return {
      corrected_action: action,
      tokens_in: 0,
      tokens_out: 0,
      cost_measured: false,
      notes: note ? `${DELEGATED_COST_NOTE}; ${note}` : DELEGATED_COST_NOTE,
    };
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 200);
}
