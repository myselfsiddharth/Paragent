/**
 * Action execution with locator fallback.
 * Sources: contracts/cache-row.schema.json; Playwright actions docs — access_date: 2026-07-24
 */

import type { Locator, Page } from "playwright";
import {
  LocatorNotFoundError,
  resolveWithFallback,
} from "./locators.js";
import { interpolate } from "./templates.js";
import type { CompiledAction, ParamBindings } from "./types.js";

export interface ActionResult {
  ok: boolean;
  outcome?: "LOCATOR_NOT_FOUND" | "TIMEOUT" | "PAGE_ERROR";
  message?: string;
  /**
   * `wait` steps only: whether the `networkidle` fallback actually fired.
   * `false` means the bound elapsed and the step proceeded anyway — a settling
   * hint that went unanswered, not a failure. See {@link NETWORK_IDLE_WAIT_MS}.
   */
  settled?: boolean;
  /**
   * The locator the action actually resolved and acted on — the strategy in
   * the fallback chain that matched, re-queryable. An assertion whose target is
   * `{ locator_ref: "action_target" }` (ADR-0022) is evaluated against exactly
   * this, so it follows a repaired action and never drifts to a different
   * element through a looser strategy further down the chain.
   */
  target?: Locator;
}

/**
 * Ceiling for the `networkidle` fallback of a parameterless `wait` step.
 *
 * This used to be an unbounded `page.waitForLoadState("networkidle")`, which
 * inherits Playwright's 30s default — a number nobody in this repo chose. On a
 * page that never goes quiet for 500ms, `networkidle` never fires, so the step
 * burned the full 30s and then failed anyway: maximum latency for zero
 * information. Measured at 30.0s in tests/unit/runner-bounded-wait.test.ts.
 *
 * **Honest scope of the risk.** The seeded Grafana dashboard does *not* trigger
 * it — `networkidle` settles there in ~3ms (measured on 11.0.0, /d/paragent-seed,
 * 2026-07-28), because the seed dashboard sets no refresh interval and TestData
 * is generated client-side. So this is a latent worst case rather than one the
 * current test-bed hits: it becomes reachable on any surface with continuous
 * polling, streaming, or websockets. Bounding it is cheap insurance, not a fix
 * for an observed test-bed hang.
 *
 * 5000ms happens to equal the assertion timeout the compiler emits
 * (`DEFAULT_ASSERTION_TIMEOUT_MS` in src/compiler/assertions.ts), which keeps a
 * step's wait and its post-condition the same order of magnitude. Nothing
 * enforces the equality — they are independent constants in different packages,
 * and either can move without the other.
 *
 * **Reaching the bound is not a step failure.** A parameterless `wait` is a
 * settling *hint*; the post-condition is the assertion that runs immediately
 * after it, with its own budget. So when the bound elapses the step proceeds
 * and records `settled: false` — the same posture as the 250ms idle probe in
 * page-state.ts, where a timeout means *no claim* rather than failure.
 *
 * Classifying it as `TIMEOUT` instead would route the step into the repair loop
 * (replay.ts sends every non-PASS outcome there), spending repair budget twice
 * on a condition no `corrected_action` can fix — "this page never goes quiet"
 * is not a locator problem. `success_with_le_2_repairs` would then be reporting
 * a scaffolding condition as churn, which is the one thing the gate number must
 * not do. If the page really is broken, the assertion says so on its own and
 * that failure *is* worth a repair attempt.
 *
 * **This still changes which steps pass.** A page that first goes quiet at, say,
 * 12s used to hold the step until it did; now the step continues at 5s and the
 * assertion decides on whatever is on screen. That is deliberate and is a good
 * trade *now*, while no gate number exists — see docs/gate/runner.md. It would
 * be a bad trade after a measurement had been published against the old value.
 */
export const NETWORK_IDLE_WAIT_MS = 5_000;

export interface ExecuteActionOptions {
  /** Override for {@link NETWORK_IDLE_WAIT_MS}. */
  networkIdleWaitMs?: number;
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  return name.includes("timeout") || msg.includes("timeout");
}

function firstParam(
  action: CompiledAction,
  params: ParamBindings,
): string | number | boolean | undefined {
  const refs = action.param_refs ?? [];
  for (const ref of refs) {
    if (Object.prototype.hasOwnProperty.call(params, ref)) return params[ref];
  }
  return undefined;
}

export async function executeAction(
  page: Page,
  action: CompiledAction,
  params: ParamBindings = {},
  options: ExecuteActionOptions = {},
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "navigate": {
        if (!action.url_template) {
          return {
            ok: false,
            outcome: "PAGE_ERROR",
            message: "navigate missing url_template",
          };
        }
        const url = interpolate(action.url_template, params);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { ok: true };
      }

      case "click": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        await loc.click();
        return { ok: true, target: loc };
      }

      case "fill": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        const value = firstParam(action, params);
        if (value === undefined) {
          return {
            ok: false,
            outcome: "PAGE_ERROR",
            message: "fill missing bound param value",
          };
        }
        await loc.fill(String(value));
        return { ok: true, target: loc };
      }

      case "select": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        const value = firstParam(action, params);
        if (value === undefined) {
          return {
            ok: false,
            outcome: "PAGE_ERROR",
            message: "select missing bound param value",
          };
        }
        await loc.selectOption(String(value));
        return { ok: true, target: loc };
      }

      case "check": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        await loc.check();
        return { ok: true, target: loc };
      }

      case "uncheck": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        await loc.uncheck();
        return { ok: true, target: loc };
      }

      case "press": {
        const key = action.key ? interpolate(action.key, params) : undefined;
        if (!key) {
          return {
            ok: false,
            outcome: "PAGE_ERROR",
            message: "press missing key",
          };
        }
        if (action.locator_fallback_chain.length > 0) {
          const loc = await resolveWithFallback(
            page,
            action.locator_fallback_chain,
          );
          await loc.press(key);
          return { ok: true, target: loc };
        }
        await page.keyboard.press(key);
        return { ok: true };
      }

      case "hover": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        await loc.hover();
        return { ok: true, target: loc };
      }

      case "wait": {
        // A recorded literal (ADR-0008) takes precedence over a runtime-bound
        // param: it is what was actually observed, and must not be silently
        // overridable by a same-named --param binding.
        //
        // PRESENCE decides here, not magnitude. Both schemas allow `wait_ms: 0`
        // and `recorder.wait(intent, 0)` is a legal call, so a recorded zero is
        // an observation — "no wait here" — and replay must reproduce it as an
        // instant no-op. Gating on `> 0` instead would reinterpret it as "no
        // duration given" and fall through to networkidle: a different
        // condition on a different clock, which is the exact drift ADR-0008
        // exists to close. A non-finite or negative value is not an
        // observation, so it falls through as if nothing was recorded.
        const recorded = action.wait_ms;
        if (recorded !== undefined && Number.isFinite(recorded) && recorded >= 0) {
          await page.waitForTimeout(recorded);
          return { ok: true };
        }
        // Runtime-bound duration (pre-existing mechanism, unchanged): unlike a
        // recorded literal this is a slot the caller fills, so an unusable or
        // non-positive binding means the step never specified a duration.
        const msRaw = firstParam(action, params);
        const ms =
          typeof msRaw === "number"
            ? msRaw
            : msRaw !== undefined
              ? Number(msRaw)
              : 0;
        if (Number.isFinite(ms) && ms > 0) {
          await page.waitForTimeout(ms);
          return { ok: true };
        }
        const bound = options.networkIdleWaitMs ?? NETWORK_IDLE_WAIT_MS;
        try {
          await page.waitForLoadState("networkidle", { timeout: bound });
          return { ok: true, settled: true };
        } catch (err) {
          // Only an unanswered settling hint is tolerated here. Anything else
          // (a closed page, a navigation error) is a real failure and falls
          // through to the outer handler.
          if (!isTimeoutError(err)) throw err;
          return {
            ok: true,
            settled: false,
            message: `networkidle not reached within ${bound}ms; proceeded — the assertion is the post-condition`,
          };
        }
      }

      case "upload": {
        const loc = await resolveWithFallback(
          page,
          action.locator_fallback_chain,
        );
        const pathValue = firstParam(action, params);
        if (pathValue === undefined) {
          return {
            ok: false,
            outcome: "PAGE_ERROR",
            message: "upload missing file path param",
          };
        }
        await loc.setInputFiles(String(pathValue));
        return { ok: true, target: loc };
      }

      case "custom": {
        return {
          ok: false,
          outcome: "PAGE_ERROR",
          message: `custom action not wired: ${action.custom_op ?? "unknown"}`,
        };
      }

      default: {
        const _exhaustive: never = action.type;
        return {
          ok: false,
          outcome: "PAGE_ERROR",
          message: `unknown action type: ${String(_exhaustive)}`,
        };
      }
    }
  } catch (err) {
    if (err instanceof LocatorNotFoundError) {
      return { ok: false, outcome: "LOCATOR_NOT_FOUND", message: err.message };
    }
    if (isTimeoutError(err)) {
      return {
        ok: false,
        outcome: "TIMEOUT",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      ok: false,
      outcome: "PAGE_ERROR",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
