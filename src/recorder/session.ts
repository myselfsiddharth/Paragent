import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { countAppeared, settledControlKeys, visibleControlKeys } from "../shared/controls.js";
import { captureFingerprint } from "./fingerprint.js";
import { collectLocatorCandidates } from "./locators.js";
import {
  assertNoLiteralSecrets,
  inferParamType,
  resolveTemplate,
  templatizeText,
  templatizeUrl,
} from "./redact.js";
import {
  TRAJECTORY_SCHEMA_VERSION,
  type AssertionHint,
  type ParamType,
  type RecordSessionOptions,
  type Step,
  type Trajectory,
} from "./types.js";

export const PACKAGE = "recorder" as const;
export const RECORDER_VERSION = "0.1.0-b2" as const;

/**
 * How long a step may wait for the URL to change before `post_state` is taken.
 *
 * Why this exists (issue #24, measured on 9.5.21): clicking **Save** in the
 * dashboard drawer saves over XHR and *then* routes to `/d/{uid}/{slug}`. The
 * first live recording captured `post_state` in between, so the most important
 * step in the ADR-0006 task recorded "URL unchanged" — and the compiler, seeing
 * no navigation, would synthesize a weak `element-visible` for a step whose
 * real post-condition is a URL and a success toast.
 *
 * The runner does not have this problem: its assertions carry a 5s budget
 * (`DEFAULT_ASSERTION_TIMEOUT_MS`), so it sees the settled page. Capturing the
 * unsettled one means recording a state the replay will never assert against.
 * This closes that gap.
 *
 * It can only ever *wait* for a change, never invent one: if the URL does not
 * move within the budget, `post_state` records the URL that is actually there,
 * exactly as before. Bounded for the same reason every other wait here is —
 * the timeout means "no change observed", not failure.
 */
export const POST_ACTION_URL_SETTLE_MS = 1_000;

/**
 * Once the URL has moved, how long it must stay put before `post_state` is
 * taken.
 *
 * Returning on the *first* change was not enough (#224, measured on 9.5.21):
 * after Save, Grafana routes to `/d/{uid}/{slug}` and then rewrites it to
 * `/d/{uid}/{slug}?orgId=1`. A recording that caught the first URL taught the
 * compiler, through ADR-0022's state-bearing rule, that `orgId` must be
 * *absent* there, and every replay on the recording version failed that step.
 */
export const POST_ACTION_URL_QUIET_MS = 300;

/**
 * Poll until the URL differs from `before` and then stops moving for
 * `POST_ACTION_URL_QUIET_MS`, each phase bounded by `POST_ACTION_URL_SETTLE_MS`.
 * A URL that never moves returns after the first budget, exactly as before.
 */
export async function settleUrl(page: Page, before: string): Promise<void> {
  const firstDeadline = Date.now() + POST_ACTION_URL_SETTLE_MS;
  while (page.url() === before) {
    if (Date.now() >= firstDeadline) return;
    await page.waitForTimeout(50);
  }
  const deadline = Date.now() + POST_ACTION_URL_SETTLE_MS;
  let last = page.url();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(50);
    const now = page.url();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= POST_ACTION_URL_QUIET_MS) {
      return;
    }
  }
}

/**
 * Instruments a Playwright Page into contracts/trajectory.schema.json.
 * Typed values drive Playwright only — never written to JSON.
 */
export class TrajectoryRecorder {
  readonly page: Page;
  private readonly options: RecordSessionOptions;
  private readonly parameters: Record<string, ParamType>;
  private readonly bindings: Record<string, string | number | boolean>;
  private readonly steps: Step[] = [];
  private readonly startedAt = Date.now();
  private stepIndex = 0;

  constructor(page: Page, options: RecordSessionOptions) {
    this.page = page;
    this.options = options;
    this.parameters = { ...(options.parameters ?? {}) };
    this.bindings = { ...(options.bindings ?? {}) };
  }

  declareParam(name: string, type: ParamType, binding?: string | number | boolean): void {
    this.parameters[name] = type;
    if (binding !== undefined) this.bindings[name] = binding;
  }

  private ensureParam(name: string, sample?: unknown): void {
    if (!(name in this.parameters)) {
      this.parameters[name] = inferParamType(name, sample);
    }
  }

  private offsetMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }

  private async fingerprint(awaitNetworkIdle = false) {
    return captureFingerprint(this.page, {
      bindings: this.bindings,
      awaitNetworkIdle,
    });
  }

  private async recordStep(args: {
    intent: string;
    action: Step["action"];
    locator?: Locator;
    run: () => Promise<void>;
    assertion_hint?: AssertionHint;
    awaitNetworkIdle?: boolean;
  }): Promise<void> {
    const started = this.offsetMs();
    const pre_state = await this.fingerprint(false);
    // ADR-0026: which controls were visible before the action, in memory only.
    // Only for click-like steps, the only ones the compiler reads it for.
    // A failed capture records nothing: "could not tell" is never "none".
    const controlsBefore = ["click", "check", "uncheck", "press"].includes(args.action.type)
      ? await settledControlKeys(this.page).catch(() => undefined)
      : undefined;
    const urlBefore = this.page.url();
    const locator_candidates = args.locator
      ? await collectLocatorCandidates(args.locator)
      : [];
    await args.run();

    // ADR-0007: observe whether the acted-on control survived the action, before
    // anything else can change the page. Playwright's isVisible() is used rather
    // than a DOM predicate because src/runner/assertions.ts later checks this
    // same target with waitFor({ state: "hidden" | "visible" }) — recording the
    // observation the runner will make is what keeps the two honest.
    // A control that hides itself (dismiss, close, collapse) is otherwise
    // indistinguishable from one that stays, and gets asserted as still visible.
    // On failure record NOTHING, never `false`. isVisible() throws on a strict
    // mode violation (a locator matching two controls — entirely plausible on
    // real Grafana), and the compiler promotes `false` into a *strong*
    // "the control disappeared" assertion. Turning "I could not tell" into "I
    // proved it vanished" is the exact shape CONTRIBUTING rule 3 forbids.
    // Leaving it undefined omits the field and falls back to prior behaviour.
    let post_action_target_visible: boolean | undefined;
    if (args.locator) {
      post_action_target_visible = await args.locator
        .isVisible()
        .catch(() => undefined);
    }

    // Only after the ADR-0007 observation above: give a client-side route change
    // a bounded chance to land, so post_state is the page the runner will
    // actually assert against. See POST_ACTION_URL_SETTLE_MS.
    await settleUrl(this.page, urlBefore);

    const post_state = await this.fingerprint(args.awaitNetworkIdle ?? true);
    const controlsAfter = controlsBefore
      ? await visibleControlKeys(this.page).catch(() => undefined)
      : undefined;
    const duration_ms = Math.max(0, this.offsetMs() - started);
    const step: Step = {
      step_index: this.stepIndex++,
      intent: args.intent,
      action: args.action,
      locator_candidates,
      pre_state,
      post_state,
      timing_ms: { started_offset_ms: started, duration_ms },
    };
    if (args.assertion_hint) step.assertion_hint = args.assertion_hint;
    if (post_action_target_visible !== undefined) {
      step.post_action_target_visible = post_action_target_visible;
    }
    // A count, never the names: the trajectory records that the step revealed
    // something, not what the page said.
    if (controlsBefore && controlsAfter) {
      step.controls_appeared = countAppeared(controlsBefore, controlsAfter);
    }
    this.steps.push(step);
  }

  async navigate(urlTemplate: string, intent: string, paramRefs: string[] = []): Promise<void> {
    for (const p of paramRefs) this.ensureParam(p);
    const resolved = resolveTemplate(urlTemplate, this.bindings);
    const holeRefs = [...urlTemplate.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!);
    const refs = [...new Set([...paramRefs, ...holeRefs])];
    for (const p of refs) this.ensureParam(p);
    await this.recordStep({
      intent,
      action: { type: "navigate", url_template: urlTemplate, param_refs: refs },
      awaitNetworkIdle: true,
      assertion_hint: {
        suggested_type: "url-matches",
        observed_signals: ["navigation completed"],
      },
      run: async () => {
        await this.page.goto(resolved, { waitUntil: "domcontentloaded" });
      },
    });
  }

  async click(locator: Locator, intent: string): Promise<void> {
    await this.recordStep({
      intent,
      action: { type: "click" },
      locator,
      assertion_hint: {
        suggested_type: "element-visible",
        observed_signals: ["click target resolved"],
      },
      run: async () => {
        await locator.click();
      },
    });
  }

  async fill(locator: Locator, paramName: string, value: string, intent: string): Promise<void> {
    this.ensureParam(paramName, value);
    // Bind, so the value can be lifted back out of anything the page echoes it
    // into. Bindings drive Playwright and redaction only — `toTrajectory` never
    // serializes them.
    this.bindings[paramName] = value;
    await this.recordStep({
      intent,
      action: { type: "fill", param_refs: [paramName] },
      locator,
      assertion_hint: {
        suggested_type: "element-value-bound",
        observed_signals: [`param slot ${paramName} filled`],
      },
      run: async () => {
        await locator.fill(value);
      },
    });
  }

  async select(locator: Locator, paramName: string, value: string, intent: string): Promise<void> {
    this.ensureParam(paramName, value);
    this.bindings[paramName] = value;
    await this.recordStep({
      intent,
      action: { type: "select", param_refs: [paramName] },
      locator,
      run: async () => {
        await locator.selectOption(value);
      },
    });
  }

  async check(locator: Locator, intent: string): Promise<void> {
    await this.recordStep({
      intent,
      action: { type: "check" },
      locator,
      run: async () => {
        await locator.check();
      },
    });
  }

  async uncheck(locator: Locator, intent: string): Promise<void> {
    await this.recordStep({
      intent,
      action: { type: "uncheck" },
      locator,
      run: async () => {
        await locator.uncheck();
      },
    });
  }

  async press(key: string, intent: string, locator?: Locator): Promise<void> {
    const args: {
      intent: string;
      action: Step["action"];
      locator?: Locator;
      run: () => Promise<void>;
    } = {
      intent,
      action: { type: "press", key },
      run: async () => {
        if (locator) await locator.press(key);
        else await this.page.keyboard.press(key);
      },
    };
    if (locator) args.locator = locator;
    await this.recordStep(args);
  }

  async hover(locator: Locator, intent: string): Promise<void> {
    await this.recordStep({
      intent,
      action: { type: "hover" },
      locator,
      run: async () => {
        await locator.hover();
      },
    });
  }

  async wait(intent: string, ms: number): Promise<void> {
    await this.recordStep({
      intent,
      action: { type: "wait", wait_ms: ms },
      awaitNetworkIdle: false,
      run: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      },
    });
  }

  /** Measured steps recorded so far. Preamble actions are not among them. */
  stepCount(): number {
    return this.steps.length;
  }

  currentUrlTemplate(): string {
    return templatizeUrl(this.page.url(), this.bindings).template;
  }

  /**
   * Lift bound values out of a captured fingerprint, at emit time.
   *
   * Deferred on purpose: a value is often only *knowable* after the step that
   * observed it. The dashboard uid in `/d/{dashboard_uid}/…` is assigned by the
   * server during the save click, so the step that recorded that URL could not
   * have templatized it while capturing. Running the pass over the finished
   * steps lifts it everywhere it appears, including backwards.
   *
   * This replaces literals with holes and does nothing else — it cannot invent
   * a state, only stop one from naming a run-specific value.
   */
  private liftFingerprint<T extends { url_template: string; title_template: string }>(
    fp: T,
  ): T {
    return {
      ...fp,
      url_template: templatizeText(fp.url_template, this.bindings),
      title_template: templatizeText(fp.title_template, this.bindings),
    };
  }

  toTrajectory(): Trajectory {
    if (this.steps.length === 0) throw new Error("Cannot emit trajectory with zero steps");
    const provenance = { ...this.options.provenance };
    if (!provenance.recorder) provenance.recorder = RECORDER_VERSION;
    return {
      schema_version: TRAJECTORY_SCHEMA_VERSION,
      trajectory_id: this.options.trajectory_id,
      site_key: this.options.site_key,
      task_key: this.options.task_key,
      recorded_at: new Date().toISOString(),
      base_url_template: this.options.base_url_template,
      provenance,
      parameters: { ...this.parameters },
      steps: this.steps.map((s) => {
        const clone = structuredClone(s);
        clone.pre_state = this.liftFingerprint(clone.pre_state);
        clone.post_state = this.liftFingerprint(clone.post_state);
        return clone;
      }),
    };
  }

  async write(outPath: string): Promise<Trajectory> {
    const traj = this.toTrajectory();
    const text = `${JSON.stringify(traj, null, 2)}\n`;
    assertNoLiteralSecrets(text);
    await writeFile(outPath, text, "utf8");
    return traj;
  }
}
