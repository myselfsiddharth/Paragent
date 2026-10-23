import { pickPrimaryLocator } from "./locators.js";
import { hasTemplateHoles, looksLikeTenantLiteral } from "./literals.js";
import type {
  Assertion,
  AssertionType,
  CompiledLocator,
  ParamType,
  Trajectory,
  TrajectoryStep,
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

/**
 * `timeout_ms` written onto every synthesized assertion.
 *
 * Was seven separate `5000` literals. Naming it is the change; **the value is
 * deliberately unmoved.**
 *
 * A timeout is part of an assertion's *strength*, not a performance knob: a
 * shorter one is a stricter check, a longer one a laxer one. Lowering this to
 * make replay feel faster would raise the failure rate and move step-level
 * replay-validity — the one number PRD §9 gates on — while looking like a perf
 * tweak. That is the shape `docs/architecture.md` invariant 1 forbids.
 *
 * The runner spends this budget on *failure*
 * (`src/runner/assertions.ts`), so it is also the dominant term in
 * worst-case latency: a 12-step task with three stale locators waits 3 × this
 * before repair even starts. Changing it is therefore a real decision, and it
 * should follow a measurement rather than precede one. Override per-compile via
 * `SynthesizeAssertionOptions.timeoutMs` if you need to explore that.
 */
export const DEFAULT_ASSERTION_TIMEOUT_MS = 5000;

export interface SynthesizeAssertionOptions {
  /** Override for {@link DEFAULT_ASSERTION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

const ASSERTION_TYPES = new Set<AssertionType>([
  "element-visible",
  "text-matches",
  "url-matches",
  "count-equals",
  "network-idle",
  "custom",
]);

function extractParamTypes(
  template: string,
  trajectoryParams: Record<string, ParamType>,
): Record<string, ParamType> | undefined {
  const holes = [...template.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map(
    (m) => m[1]!,
  );
  if (holes.length === 0) return undefined;
  const param_types: Record<string, ParamType> = {};
  for (const name of holes) {
    param_types[name] = trajectoryParams[name] ?? "string";
  }
  return param_types;
}

function urlChanged(step: TrajectoryStep): boolean {
  return step.pre_state.url_template !== step.post_state.url_template;
}

function newLandmarks(step: TrajectoryStep): string[] {
  const pre = new Set(step.pre_state.visible_landmarks ?? []);
  return (step.post_state.visible_landmarks ?? []).filter((l) => !pre.has(l));
}

/**
 * Whole-word match over the recorder's `observed_signals`.
 *
 * Was a substring match, which read a **parameter name** as a page signal:
 * filling the ADR-0006 series-count field emits the signal
 * `"param slot series_count filled"`, whose "count" tripped the `count-equals`
 * branch below. The live compile therefore asserted a count on a text input
 * (issue #25). `_` is a word character, so `\bcount\b` does not match inside
 * `series_count` — which is exactly the distinction wanted here: a signal is a
 * word the recorder observed, not a fragment of an identifier it happens to
 * carry.
 */
function signalMentions(
  signals: string[] | undefined,
  ...needles: string[]
): boolean {
  if (!signals) return false;
  const joined = signals.join(" ").toLowerCase();
  return needles.some((n) =>
    new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
      joined,
    ),
  );
}

function sanitizeTemplate(value: string): string {
  if (looksLikeTenantLiteral(value) && !hasTemplateHoles(value)) {
    return "{observed_text}";
  }
  return value;
}

function pickPreferredLandmark(landmarks: string[]): string | undefined {
  const preferred = ["form", "main", "dialog", "navigation", "banner"];
  for (const p of preferred) {
    if (landmarks.includes(p)) return p;
  }
  return landmarks[0];
}

function landmarkAsLocator(
  landmark: string | undefined,
): CompiledLocator | undefined {
  if (!landmark) return undefined;
  return { strategy: "role_name", role: landmark };
}

function stripTenantFlagForTarget(locator: CompiledLocator): CompiledLocator {
  if (locator.strategy === "topology_only") {
    return { strategy: "structural", structural_path: "body" };
  }
  const { tenant_scoped: _t, ...rest } = locator;
  return rest;
}

interface SynthesisContext {
  trajectory: Trajectory;
  step: TrajectoryStep;
  locatorChain: CompiledLocator[];
}

/** Synthesize one post-condition; expected values are templates with typed holes. */
export function synthesizeAssertion(
  ctx: SynthesisContext,
  options: SynthesizeAssertionOptions = {},
): Assertion {
  const timeout_ms = options.timeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;
  const { trajectory, step, locatorChain } = ctx;
  const hint = step.assertion_hint;
  const primary = pickPrimaryLocator(locatorChain);
  const assertionId = `assert-${trajectory.task_key}-step-${step.step_index}`;

  const suggested =
    hint?.suggested_type && ASSERTION_TYPES.has(hint.suggested_type as AssertionType)
      ? (hint.suggested_type as AssertionType)
      : undefined;

  const preferHintElement =
    suggested === "element-visible" &&
    (signalMentions(
      hint?.observed_signals,
      "visible",
      "appeared",
      "form",
      "login",
    ) ||
      newLandmarks(step).length > 0 ||
      primary !== undefined);

  if (
    suggested === "text-matches" ||
    signalMentions(
      hint?.observed_signals,
      "toast",
      "saved",
      "success",
      "notification",
    )
  ) {
    const template = "{success_message}";
    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "text-matches",
      strength: "strong",
      expected: {
        template,
        param_types: { success_message: "string" },
        regex_template: templateToRegex(template),
      },
      timeout_ms,
      failure_classification: "assertion_failed",
      notes:
        "Recorder signalled toast/success copy. Expected text is a typed hole ({success_message}) — never a tenant/product-message literal. Strong when the runner binds a success-pattern allowlist; otherwise runtime bind quality is MED confidence.",
    };
  }

  if (
    suggested === "count-equals" ||
    signalMentions(hint?.observed_signals, "count", "rows", "items")
  ) {
    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "count-equals",
      strength: "weak",
      target: {
        count_scope: primary?.css ?? primary?.structural_path ?? "main",
      },
      expected: {
        count: 0,
        template: "{item_count}",
        param_types: { item_count: "integer" },
      },
      timeout_ms,
      failure_classification: "assertion_failed",
      notes:
        "Count asserted via template hole. expected.count=0 is a schema placeholder until B2 emits structured counts in post_state; runner must bind the observed count. Labelled weak: absolute counts drift. Not a gate metric.",
    };
  }

  const wantsElement =
    preferHintElement ||
    suggested === "element-visible" ||
    newLandmarks(step).length > 0 ||
    signalMentions(hint?.observed_signals, "visible", "appeared", "form") ||
    (primary !== undefined &&
      ["click", "fill", "select", "check", "uncheck"].includes(
        step.action.type,
      ));

  /**
   * A click that changes the URL is evidenced by where it landed, not by the
   * control that was clicked. Computed here because the two branches below both
   * need it, and their order matters: a navigating click that *also* hides its
   * control (submitting a login form) is better asserted on its destination
   * than on the disappearance, so `url-matches` keeps priority.
   */
  const clickChangedUrl = step.action.type === "click" && urlChanged(step);

  /**
   * ADR-0007. The step acted on a control and the recorder observed it gone
   * afterwards, so assert exactly that: the control is no longer visible.
   *
   * This is the case #70 could not reach. It fixed URL-changing clicks by
   * asserting the destination, but a control that hides itself without touching
   * the URL — dismiss, close, collapse — has no destination to assert, and the
   * old code fell through to "the thing I clicked is still visible", which the
   * step itself falsifies.
   *
   * `strong` is deliberate: for a self-hiding control the disappearance *is*
   * the purpose of the step, and this assertion fails if the click is a no-op.
   * The notes below bound the claim to what was actually observed.
   */
  if (
    step.post_action_target_visible === false &&
    primary !== undefined &&
    !clickChangedUrl &&
    ["click", "check", "uncheck", "press"].includes(step.action.type)
  ) {
    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "element-visible",
      strength: "strong",
      target: { locator_ref: "action_target" },
      expected: { visible: false },
      timeout_ms,
      failure_classification: "assertion_failed",
      notes:
        "Recorder observed the acted-on control was no longer visible after the action (ADR-0007 post_action_target_visible=false). Asserts only that: the control is gone. Proves the step was not a no-op; proves nothing about downstream state.",
    };
  }

  /**
   * Asserting the clicked control is still visible is frequently *false*: the
   * transition routinely hides the surface the control lived on (submitting a
   * login form, closing a modal, navigating away).
   *
   * Falling through to `url-matches` is both correct and stronger: the branch
   * below labels a URL-changing click `strong`.
   *
   * Caught by tests/integration/pipeline.test.ts, which replayed a compiled
   * login step against the fixture and timed out waiting for the submit button
   * to stay visible after it had been clicked. Since ADR-0007 the
   * non-navigating variant is caught directly by the branch above rather than
   * inferred from the URL.
   */
  /**
   * ADR-0026 (#224): a click whose control stays on screen and that revealed
   * new controls when recorded. The old check here, "the clicked control is
   * still visible", describes the recording version's layout, not the step's
   * purpose: on Grafana 10.0.13 the visualization toggle disappears once the
   * picker opens, so the check was false while the step did exactly its job,
   * and frozen under repair, so nothing could pass it.
   *
   * What the step is for is to reveal something, and the recording observed
   * that it did. So assert that: at least one control appears. It is a count,
   * so a renamed control cannot break it and no page text enters the row.
   * Weak, honestly: a wrong menu opening passes too. What it rules out is the
   * click doing nothing, which the old check could not.
   */
  if (
    wantsElement &&
    !clickChangedUrl &&
    step.post_action_target_visible === true &&
    (step.controls_appeared ?? 0) > 0 &&
    ["click", "check", "uncheck", "press"].includes(step.action.type)
  ) {
    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "controls-appeared",
      strength: "weak",
      expected: { count: 1 },
      timeout_ms,
      failure_classification: "assertion_failed",
      notes:
        `Recorder observed ${step.controls_appeared} new control(s) after the action (ADR-0026). Asserts at least one appears: the step revealed something. Weak: a wrong surface opening also passes; rules out a no-op.`,
    };
  }

  if (wantsElement && !clickChangedUrl) {
    const landmarkPick =
      pickPreferredLandmark(newLandmarks(step)) ??
      (preferHintElement
        ? pickPreferredLandmark(step.post_state.visible_landmarks ?? [])
        : undefined);
    const locator = primary ?? landmarkAsLocator(landmarkPick);

    if (locator !== undefined || preferHintElement) {
      let strength: Assertion["strength"] = "weak";
      let notes =
        "Element visibility from hint/post-state; labelled weak unless stronger signals apply.";

      if (step.action.type === "fill" || step.action.type === "select") {
        strength = "weak";
        notes =
          "Fill/select cannot assert the typed value (values are param slots, never stored). Visibility of the target control is only weakly consistent with a successful fill.";
      } else if (
        newLandmarks(step).length > 0 &&
        suggested !== "element-visible"
      ) {
        strength = "weak";
        notes =
          "New landmark(s) in post_state are coarse structural signals — consistent with success but not unambiguous proof. Labelled weak.";
      }

      if (
        step.action.type === "navigate" &&
        (signalMentions(hint?.observed_signals, "form", "login") ||
          suggested === "element-visible")
      ) {
        strength = "strong";
        notes =
          "Presence of the login/control surface after navigate is strong evidence we reached the intended page (chrome locator, not tenant content).";
      }

      const resolved =
        locator ??
        ({ strategy: "role_name", role: "form" } satisfies CompiledLocator);

      // ADR-0022: when the checked element IS the action's own target, point
      // at it instead of copying a locator. A copied locator was whichever
      // chain entry was not tenant-tagged — in practice a structural path — so
      // the check broke on any layout change and, being frozen under repair,
      // could never be healed (#211: 3 of 8 pins failed this way). A reference
      // follows a repaired action and carries no page text into the row.
      const target: NonNullable<Assertion["target"]> =
        primary !== undefined && locator === primary
          ? { locator_ref: "action_target" }
          : { locator: stripTenantFlagForTarget(resolved) };

      return {
        schema_version: SCHEMA_VERSION,
        assertion_id: assertionId,
        type: "element-visible",
        strength,
        target,
        expected: { visible: true },
        timeout_ms,
        failure_classification: "assertion_failed",
        notes,
      };
    }
  }

  if (urlChanged(step) || suggested === "url-matches") {
    const url_template = sanitizeTemplate(step.post_state.url_template);
    const param_types = extractParamTypes(url_template, trajectory.parameters);
    const strong =
      step.action.type === "navigate" ||
      (urlChanged(step) && step.action.type === "click");

    const expected: NonNullable<Assertion["expected"]> = {
      template: url_template,
      regex_template: urlRegexTemplate(url_template, trajectory),
    };
    if (param_types) expected.param_types = param_types;

    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "url-matches",
      strength: strong ? "strong" : "weak",
      target: { url_template },
      expected,
      timeout_ms,
      failure_classification: "assertion_failed",
      notes: strong
        ? "URL template changed (or navigate completed); matching post_state.url_template is strong evidence the step reached the intended surface."
        : "URL match observed but action type does not strongly imply navigation; labelled weak.",
    };
  }

  if (suggested === "network-idle" || step.post_state.network_idle === true) {
    return {
      schema_version: SCHEMA_VERSION,
      assertion_id: assertionId,
      type: "network-idle",
      strength: "weak",
      timeout_ms,
      failure_classification: "timeout",
      notes:
        "network_idle in post_state is weakly consistent with success — idle also occurs on error pages and no-ops. Labelled weak.",
    };
  }

  return {
    schema_version: SCHEMA_VERSION,
    assertion_id: assertionId,
    type: "custom",
    strength: "weak",
    expected: {
      custom_predicate_id: "post_digest_changed_or_stable",
      template: "{dom_digest}",
      param_types: { dom_digest: "string" },
    },
    timeout_ms: 5000,
    failure_classification: "unknown",
    notes:
      "No URL/landmark/toast/count/network signal strong enough to specialize. Weak custom digest check — blind spot: digests are not semantic assertions.",
  };
}

export function templateToRegex(template: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i);
      if (end === -1) {
        parts.push(escapeRegex(template.slice(i)));
        break;
      }
      parts.push("[^/?#]+");
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < template.length && template[j] !== "{") j++;
    parts.push(escapeRegex(template.slice(i, j)));
    i = j;
  }
  return `^${parts.join("")}$`;
}

/**
 * `url-matches` regex for a recorded URL template (ADR-0022, #211).
 *
 * The old regex anchored the whole query string, so a page that appended view
 * state failed a correct navigation: from Grafana 11.5.2 `/dashboard/new` lands
 * on `?orgId=1&from=now-6h&to=now&timezone=browser`, and step 0 failed on 4 of
 * 8 pins with repair (correctly) unable to help.
 *
 * Simply allowing extra keys would be a real weakening. Step 7 ("Apply, back to
 * the dashboard") expects `?orgId=1`; a failed Apply leaves you on
 * `?orgId=1&editPanel=1`, which a subset match would pass. So the recording
 * decides which keys carry state:
 *
 * - every key recorded on this step's URL must be present with its recorded
 *   value (holes match any value) — as strict as before;
 * - a key is STATE-BEARING for a path if the recording saw that path both with
 *   and without it, or with different values (`editPanel` on `/dashboard/new`).
 *   A state-bearing key absent from this step's URL must be absent at replay;
 * - any other extra key was never part of what the recording distinguished —
 *   view state — and is ignored.
 *
 * Product-agnostic: no list of Grafana parameter names, only the trajectory.
 */
export function urlRegexTemplate(urlTemplate: string, trajectory: Trajectory): string {
  const [base, query] = splitUrl(urlTemplate);
  if (query === undefined && !trajectoryHasQueryFor(base, trajectory)) {
    return `^${regexBody(base, PATH_HOLE)}(?:\\?[^#]*)?(?:#.*)?$`;
  }
  const own = parseQuery(query ?? "");
  const stateKeys = stateBearingKeys(base, trajectory);
  const required = [...own.entries()].map(
    ([k, v]) => `(?=\\?(?:[^#]*&)?${escapeRegex(k)}=${regexBody(v, QUERY_HOLE)}(?:[&#]|$))`,
  );
  const forbidden = [...stateKeys]
    .filter((k) => !own.has(k))
    .sort()
    .map((k) => `(?!\\?(?:[^#]*&)?${escapeRegex(k)}(?:=|[&#]|$))`);
  return `^${regexBody(base, PATH_HOLE)}${required.join("")}${forbidden.join("")}(?:\\?[^#]*)?(?:#.*)?$`;
}

const PATH_HOLE = "[^/?#]+";
const QUERY_HOLE = "[^&#]+";

function splitUrl(template: string): [string, string | undefined] {
  const noFragment = template.split("#")[0]!;
  const q = noFragment.indexOf("?");
  return q === -1 ? [noFragment, undefined] : [noFragment.slice(0, q), noFragment.slice(q + 1)];
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    out.set(eq === -1 ? pair : pair.slice(0, eq), eq === -1 ? "" : pair.slice(eq + 1));
  }
  return out;
}

/** Every URL the recording observed (pre and post state of every step), split. */
function recordedUrls(trajectory: Trajectory): Array<[string, Map<string, string>]> {
  const urls: string[] = [];
  for (const step of trajectory.steps) {
    if (step.pre_state?.url_template) urls.push(step.pre_state.url_template);
    if (step.post_state?.url_template) urls.push(step.post_state.url_template);
  }
  return urls.map((u) => {
    const [b, q] = splitUrl(u);
    return [b, parseQuery(q ?? "")];
  });
}

function trajectoryHasQueryFor(base: string, trajectory: Trajectory): boolean {
  return recordedUrls(trajectory).some(([b, q]) => b === base && q.size > 0);
}

function stateBearingKeys(base: string, trajectory: Trajectory): Set<string> {
  const samePath = recordedUrls(trajectory).filter(([b]) => b === base).map(([, q]) => q);
  const keys = new Set(samePath.flatMap((q) => [...q.keys()]));
  const out = new Set<string>();
  for (const k of keys) {
    const values = samePath.map((q) => (q.has(k) ? q.get(k) : undefined));
    if (values.some((v) => v === undefined) || new Set(values).size > 1) out.add(k);
  }
  return out;
}

/** A template fragment as an unanchored regex, holes matching `hole`. */
function regexBody(template: string, hole: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i);
      if (end === -1) {
        parts.push(escapeRegex(template.slice(i)));
        break;
      }
      parts.push(hole);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < template.length && template[j] !== "{") j++;
    parts.push(escapeRegex(template.slice(i, j)));
    i = j;
  }
  return parts.join("");
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
