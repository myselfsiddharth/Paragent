/**
 * ReplayRunner — execute compiled programs with optional repair loop.
 * Emits step + run metrics via MetricsEmitter. Never invents token costs.
 * Assertion immutability enforced via assertAssertionUnchanged.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import {
  METRICS_SCHEMA_VERSION,
  type Cost,
  type MetricRow,
  type RunMetric,
  type StepMetric,
  type StepOutcome,
} from "../metrics/types.js";
import { addCost, measureWallClock, zeroCost } from "../metrics/cost.js";
import { MetricsEmitter } from "../metrics/emitter.js";
import type { ProgramSource } from "../metrics/types.js";
import { executeAction, NETWORK_IDLE_WAIT_MS } from "./actions.js";
import { evaluateAssertion } from "./assertions.js";
import { capturePageState, emptyPageState } from "./page-state.js";
import { settledControlKeys } from "../shared/controls.js";
import {
  DEFAULT_CONTEXT_LEVEL,
  type ContextLevel,
} from "../shared/page-context.js";
import { assertParamsBound } from "./params.js";
import { normalizeTaskGoal, paramInTaskGoal, taskGoalDigest } from "./task-goal.js";

export { TASK_GOAL_MIN_PARAM_LENGTH } from "./task-goal.js";
import {
  assertAssertionUnchanged,
  MAX_PRE_ACTIONS,
  type RepairModelClient,
  StubRepairModelClient,
} from "./repair.js";
import { deepFreeze } from "./templates.js";
import type {
  CompiledAction,
  CompiledProgram,
  CompiledStep,
  ParamBindings,
  RepairContext,
  RepairProposal,
  RunResult,
  StepAttemptResult,
  StepOutcomeObservation,
} from "./types.js";

const SUCCESS_OUTCOMES: ReadonlySet<StepOutcome> = new Set([
  "PASS",
  "REPAIRED_PASS",
]);

/**
 * Default per-run wall-clock ceiling (#84, ADR-0011).
 *
 * A guard rail, not a scheduler: it must never fire on a healthy run. Derived
 * from the per-step ceilings the runner already enforces — each step is bounded
 * by an assertion timeout (`DEFAULT_ASSERTION_TIMEOUT_MS`, 5s) plus, for a
 * parameterless `wait`, `NETWORK_IDLE_WAIT_MS` (5s) — so the 12-step ADR-0006
 * gate task has a worst case near 120s even when every step is slow. 5 minutes
 * leaves ~2.5× headroom on that, and roughly an order of magnitude on the ~30s
 * a healthy live gate run actually takes.
 *
 * It is deliberately **not** derived from repair latency, which is unmeasured
 * until #27 wires a real model. When that number exists this constant should be
 * revisited against it rather than quietly stretched.
 */
export const DEFAULT_RUN_BUDGET_MS = 300_000;

export interface ReplayRunnerOptions {
  dryRun?: boolean;
  /** Per-step outcomes when dryRun=true (length should match program.steps). */
  dryRunOutcomes?: StepOutcome[];
  maxRepairsPerRun?: number;
  repairClient?: RepairModelClient;
  metrics?: MetricsEmitter;
  runId?: string;
  /**
   * Per-run fresh-reasoning **comparison baseline** — what a fresh run of this
   * task costs now (measured separately, #39). Defaults to zeros, which
   * `repairCostVsFresh` reads as "not measured" and reports as `no_data`.
   *
   * Attaching this to every run row is correct and is what the §9 ratio needs.
   * It is **not** the amortization numerator: pass `costProgramBuild` for that,
   * on the one run that paid it (#123, ADR-0010).
   */
  costFresh?: Cost;
  /**
   * One-time cost of producing the compiled program this run replays.
   *
   * Pass it on the run that consumed the payment, and never afterwards.
   * Omitted means never measured — amortization then reports `no_data` rather
   * than seeding the curve with an assumed first point. Requires
   * `programBuildId`; the runner refuses the pair otherwise, because an
   * unattributable payment cannot be told apart from a second one.
   */
  costProgramBuild?: Cost;
  /** Which compiled build this run replays. A recompile is a new id (ADR-0010). */
  programBuildId?: string;
  page?: Page;
  /**
   * Ceiling for a parameterless `wait` step's `networkidle` fallback.
   * Defaults to `NETWORK_IDLE_WAIT_MS`; see the note on that constant for why
   * it is bounded at all.
   */
  networkIdleWaitMs?: number;
  /**
   * Per-run wall-clock ceiling in ms. Defaults to `DEFAULT_RUN_BUDGET_MS`.
   *
   * Checked at step boundaries and before each repair attempt — never mid-action,
   * so no assertion is ever cut short and nothing about *what* is measured
   * changes (ADR-0011). `<= 0` or a non-finite value disables the guard, which
   * restores the pre-#84 unbounded behaviour and is only ever a deliberate
   * opt-out.
   */
  runBudgetMs?: number;
  /**
   * Clock the budget is measured against. Defaults to `Date.now`.
   *
   * A seam, not a feature: the alternative for testing an elapsed-time guard is
   * a test that actually sleeps for the budget, which is either slow or so
   * short it is flaky. Only the budget reads this — emitted costs stay on the
   * real clock, so a fake here can never fabricate a measurement.
   */
  now?: () => number;
  /**
   * Observer called once per step, after its metric row is emitted (#64).
   *
   * Optional, and a runner without one behaves exactly as it did before #64 —
   * which is what keeps the gate matrix unaffected. It cannot influence the run:
   * it is invoked after the outcome is final and its return value is ignored.
   */
  onStepOutcome?: (observation: StepOutcomeObservation) => void;
  /**
   * Context budget handed to the repair model (ADR-0012, #125). Defaults to
   * `DEFAULT_CONTEXT_LEVEL`; recorded on the run row so a self-heal rate is
   * reproducible.
   */
  repairContextLevel?: ContextLevel;
  /**
   * Where this run's program came from (ADR-0014, #118).
   *
   * Told to the runner rather than discovered by it: the caller is the thing
   * that resolved the program, and a runner that reached into `src/cache/` to
   * ask would invert the dependency the whole package is built around — the
   * cache is written *to* by the runner, never read *by* it.
   *
   * Absent means "not recorded", which is not the same as `"file"`. A run that
   * never consulted a cache belongs in no hit-rate denominator, so the field is
   * simply not emitted rather than defaulted.
   */
  programSource?: ProgramSource;
  /**
   * Whether the resolved program carried an invalidated row (ADR-0009).
   * **Advisory only** — it does not and must not change what is attempted.
   */
  cacheProgramInvalidated?: boolean;
  /**
   * The task's goal in prose, handed to the repair model (ADR-0025, #225).
   * The gate passes the same text the fresh baseline gets. Absent means the
   * repair model is told nothing about what the task is for, as before.
   */
  taskGoal?: string;
}

/**
 * A task goal that contains one of the run's bound values.
 *
 * The goal crosses the egress to a third-party model, and `params` is the bag
 * secrets live in. A goal built by interpolating a binding would carry it
 * out, so the run is refused before step 0, naming the param, never the value.
 */
export class TaskGoalCarriesParamError extends Error {
  readonly code = "TASK_GOAL_CARRIES_PARAM" as const;
  constructor(readonly param: string) {
    super(
      `task goal contains the value bound to param "${param}". The goal is sent ` +
        "to the repair model and must be developer-authored prose, never a binding.",
    );
    this.name = "TaskGoalCarriesParamError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isFailureOutcome(outcome: StepOutcome): boolean {
  return !SUCCESS_OUTCOMES.has(outcome);
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 300);
}

export class ReplayRunner {
  readonly dryRun: boolean;
  readonly dryRunOutcomes: StepOutcome[];
  readonly maxRepairsPerRun: number;
  private readonly repairClient: RepairModelClient;
  private readonly metrics: MetricsEmitter;
  private readonly costFresh: Cost;
  private readonly costProgramBuild?: Cost;
  private readonly programBuildId?: string;
  private readonly page?: Page;
  private readonly networkIdleWaitMs: number;
  readonly runBudgetMs: number;
  private readonly now: () => number;
  private readonly onStepOutcome?: (o: StepOutcomeObservation) => void;
  private readonly repairContextLevel: ContextLevel;
  private readonly programSource?: ProgramSource;
  private readonly cacheProgramInvalidated?: boolean;
  private readonly taskGoal?: string;

  constructor(options: ReplayRunnerOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.dryRunOutcomes = options.dryRunOutcomes ?? [];
    this.maxRepairsPerRun = options.maxRepairsPerRun ?? 2;
    this.repairClient = options.repairClient ?? new StubRepairModelClient();
    this.metrics = options.metrics ?? new MetricsEmitter();
    this.costFresh = options.costFresh ?? zeroCost();
    // Refused at construction, not at emission: a build cost with no id is an
    // unattributable payment, and the aggregate cannot tell one of those from a
    // second payment for the same build (#123). Failing here means no run rows
    // were written under the ambiguity.
    if (options.costProgramBuild !== undefined && options.programBuildId === undefined) {
      throw new Error(
        "ReplayRunner: costProgramBuild requires programBuildId — a one-time " +
          "program cost must say which build it paid for, or the amortization " +
          "window cannot be reconstructed (see ADR-0010).",
      );
    }
    if (options.costProgramBuild !== undefined) {
      this.costProgramBuild = options.costProgramBuild;
    }
    if (options.programBuildId !== undefined) {
      this.programBuildId = options.programBuildId;
    }
    this.networkIdleWaitMs = options.networkIdleWaitMs ?? NETWORK_IDLE_WAIT_MS;
    this.runBudgetMs = options.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS;
    this.now = options.now ?? Date.now;
    if (options.onStepOutcome !== undefined) this.onStepOutcome = options.onStepOutcome;
    this.repairContextLevel = options.repairContextLevel ?? DEFAULT_CONTEXT_LEVEL;
    // Not defaulted: absent means "not recorded", never "file". See the option.
    if (options.programSource !== undefined) this.programSource = options.programSource;
    if (options.cacheProgramInvalidated !== undefined) {
      this.cacheProgramInvalidated = options.cacheProgramInvalidated;
    }
    if (options.page !== undefined) this.page = options.page;
    const goal = normalizeTaskGoal(options.taskGoal);
    if (goal !== undefined) this.taskGoal = goal;
  }

  getMetricsEmitter(): MetricsEmitter {
    return this.metrics;
  }

  /**
   * Replay a program.
   *
   * Throws `UnboundParamsError` when the program declares a param the caller
   * did not bind — before step 0, before the browser is touched, and before any
   * metric is emitted (#122). A binding error is a caller error, and letting it
   * surface as a per-step `PAGE_ERROR` or `ASSERTION_FAILED` would make it
   * indistinguishable from the site churn the gate exists to count. A refused
   * run is not a failed run: it produced no rows, so it contributes to no §9
   * denominator.
   *
   * Stops at the first step boundary past `runBudgetMs` and says so on the run
   * row (`budget_exhausted`, `steps_attempted`) rather than running unbounded
   * (#84, ADR-0011). Steps it never reached emit no rows: they were not
   * attempted, and scoring them would invent a result.
   */
  async run(
    program: CompiledProgram,
    params: ParamBindings = {},
    runId: string = randomUUID(),
  ): Promise<RunResult> {
    // First statement in the method, on purpose: nothing above it can have
    // emitted, mutated, or observed anything by the time a refusal is decided.
    assertParamsBound(program, params);
    // ADR-0025: the goal leaves the process, so it must not carry a binding.
    if (this.taskGoal !== undefined) {
      const leaked = paramInTaskGoal(this.taskGoal, params);
      if (leaked !== undefined) throw new TaskGoalCarriesParamError(leaked);
    }

    const started = Date.now();
    const budgetStarted = this.now();
    const stepResults: StepAttemptResult[] = [];
    let repairCount = 0;
    let stepsReplayValid = 0;
    let selfHealed = false;
    let timeToRepairTotal = 0;
    let costReplay = zeroCost();
    let costRepair = zeroCost();
    // ADR-0020 (#189): sticky for the whole run. One delegated proposal is
    // enough to make this run's `cost_repair` an undercount, and an
    // undercount folded into mean(cost_repair) moves the §9 verdict.
    let repairCostMeasured = true;
    let budgetExhausted = false;
    const budgetSpent = (): boolean =>
      Number.isFinite(this.runBudgetMs) &&
      this.runBudgetMs > 0 &&
      this.now() - budgetStarted >= this.runBudgetMs;

    for (const step of program.steps) {
      // Between steps, never inside one. Cutting a step mid-action would change
      // what is being measured — an assertion that was denied its own timeout
      // reports a failure that belongs to the budget, not to the site.
      if (budgetSpent()) {
        budgetExhausted = true;
        break;
      }
      const frozenAssertion = deepFreeze(
        structuredClone(step.assertion),
      );
      const stepStarted = Date.now();

      // --- first-pass replay ---
      const first = await this.attemptStep({
        program,
        step,
        preActions: step.pre_actions ?? [],
        action: step.compiled_action,
        params,
        runId,
        mode: "replay",
        repairAttempt: 0,
        dryIndex: step.step_index,
      });

      let final: StepAttemptResult = first;
      // The action a repair actually made work, when one did. Needed by the
      // cache-update observer: a REPAIRED_PASS rewrites the entry, so the sink
      // has to know what it was rewritten *to*.
      let repairedAction: CompiledAction | undefined;
      // ADR-0024: the step's pre-action list after a repair — what ran
      // before the failure, then the repair's own. Persisted with the action.
      let repairedPreActions: CompiledAction[] = [];
      costReplay = addCost(costReplay, first.cost);

      if (first.outcome === "PASS") {
        stepsReplayValid += 1;
        final = {
          ...first,
          replay_valid: true,
          assertion_strength: step.assertion.strength,
        };
      } else if (isFailureOutcome(first.outcome)) {
        // Repair loop — assertion frozen; never rewritten.
        let lastOutcome = first.outcome;
        let lastMessage = first.error_message;
        let repaired = false;
        let budgetStoppedRepair = false;
        const failureDetectedAt = Date.now();
        // ADR-0027: every sequence already tried on this step. With the cap
        // lifted, a model at temperature 0 that re-proposes a failed repair
        // would spend the run's whole time budget learning nothing.
        const triedProposals = new Set<string>();

        while (repairCount < this.maxRepairsPerRun) {
          // Repair is where the unbounded latency lives once #27 wires a real
          // model: a proposal is a network round-trip this process does not
          // control. Checked before spending it, so an out-of-time run stops
          // instead of buying one more attempt it has no budget for.
          if (budgetSpent()) {
            budgetExhausted = true;
            budgetStoppedRepair = true;
            const stopped: StepAttemptResult = {
              step_index: step.step_index,
              outcome: "BUDGET_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: zeroCost(),
              assertion_strength: step.assertion.strength,
              // This step WAS attempted and did fail — that part is measured.
              // What the budget cut short is the recovery, not the observation.
              first_pass_outcome: first.outcome,
              error_message:
                `run wall-clock budget (${this.runBudgetMs}ms) spent before ` +
                `repair attempt ${repairCount + 1}` +
                (lastMessage !== undefined ? `; last failure: ${lastMessage}` : ""),
            };
            if (repairCount > 0) stopped.repair_attempt = repairCount;
            final = stopped;
            break;
          }
          repairCount += 1;
          const attempt = repairCount;
          const pageState = this.page
            ? await capturePageState(this.page, this.repairContextLevel)
            : emptyPageState();

          const ctx: RepairContext = {
            run_id: runId,
            step,
            assertion: frozenAssertion,
            failed_outcome: lastOutcome,
            page_state: pageState,
            attempt,
            params,
          };
          if (lastMessage !== undefined) ctx.error_message = lastMessage;
          if (this.taskGoal !== undefined) ctx.task_goal = this.taskGoal;

          let proposal: RepairProposal;
          let proposeMs: number;
          try {
            ({ result: proposal, wall_clock_ms: proposeMs } =
              await measureWallClock(() => this.repairClient.propose(ctx)));
          } catch (err) {
            // A repair client is an external call (a model API) and can fail
            // for reasons that are not this run's fault — the same posture
            // already given to a browser action or an assertion evaluation,
            // both of which are caught into a StepOutcome rather than left to
            // escape (src/runner/actions.ts, src/runner/assertions.ts). Before
            // this, an uncaught throw here propagated out of run() entirely —
            // one flaky repair call would abort the whole matrix run instead
            // of recording one step's repair as failed.
            final = {
              step_index: step.step_index,
              outcome: "REPAIR_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: zeroCost(),
              repair_attempt: attempt,
              assertion_strength: step.assertion.strength,
              first_pass_outcome: first.outcome,
              error_message: `repair client threw: ${errText(err)}`,
            };
            break;
          }

          assertAssertionUnchanged(frozenAssertion, step.assertion);
          assertAssertionUnchanged(frozenAssertion, ctx.assertion);

          if (proposal.cost_measured === false) repairCostMeasured = false;

          const proposeCost: Cost = {
            tokens_in: proposal.tokens_in,
            tokens_out: proposal.tokens_out,
            wall_clock_ms: proposeMs,
          };
          if (proposal.model_id !== undefined) {
            proposeCost.model_id = proposal.model_id;
          }
          costRepair = addCost(costRepair, proposeCost);

          if (proposal.corrected_action === null) {
            final = {
              step_index: step.step_index,
              outcome: "REPAIR_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: proposeCost,
              repair_attempt: attempt,
              assertion_strength: step.assertion.strength,
              // The path every failure takes while repair is a stub. Without
              // this the real outcome is lost — see the field's note.
              first_pass_outcome: first.outcome,
              error_message:
                proposal.notes ??
                lastMessage ??
                "repair returned corrected_action:null",
            };
            break;
          }

          const currentAction = proposal.corrected_action;
          const proposedPre = proposal.pre_actions ?? [];
          const proposalKey = JSON.stringify([proposedPre, currentAction]);
          if (triedProposals.has(proposalKey)) {
            // Paid for (the cost is already in costRepair) and counted, but
            // not executed: the same actions on the same page cannot pass a
            // check they just failed. Not a cap; the step simply has nothing
            // new to try.
            final = {
              step_index: step.step_index,
              outcome: "REPAIR_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: proposeCost,
              repair_attempt: attempt,
              assertion_strength: step.assertion.strength,
              first_pass_outcome: first.outcome,
              error_message: "repair proposed a sequence it already tried on this step",
            };
            break;
          }
          triedProposals.add(proposalKey);
          // ADR-0024: recorded pre-actions that ran before the failure stay.
          // They already acted on this page, so the retry does not run them
          // again, and the repaired step keeps them in front of the repair's.
          const keptPre = (step.pre_actions ?? []).slice(0, first.pre_action_count ?? 0);
          if (keptPre.length + proposedPre.length > MAX_PRE_ACTIONS) {
            // Spends this attempt, not the step: the model is not told how
            // many recorded pre-actions are kept, so an in-bound-looking
            // proposal can overrun, and a later attempt may not.
            final = {
              step_index: step.step_index,
              outcome: "REPAIR_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: proposeCost,
              repair_attempt: attempt,
              assertion_strength: step.assertion.strength,
              first_pass_outcome: first.outcome,
              error_message:
                `repair would give step ${step.step_index} ` +
                `${keptPre.length + proposedPre.length} pre-actions (max ${MAX_PRE_ACTIONS})`,
            };
            lastMessage = final.error_message;
            continue;
          }
          const retry = await this.attemptStep({
            program,
            step,
            preActions: proposedPre,
            action: currentAction,
            params,
            runId,
            mode: "repair",
            repairAttempt: attempt,
            dryIndex: step.step_index,
          });
          costRepair = addCost(costRepair, retry.cost);
          assertAssertionUnchanged(frozenAssertion, step.assertion);

          if (retry.outcome === "PASS") {
            const timeToRepair = Math.max(0, Date.now() - failureDetectedAt);
            timeToRepairTotal += timeToRepair;
            selfHealed = true;
            repaired = true;
            repairedAction = currentAction;
            repairedPreActions = [...keptPre, ...proposedPre];
            final = {
              step_index: step.step_index,
              outcome: "REPAIRED_PASS",
              replay_valid: false,
              mode: "repair",
              cost: addCost(proposeCost, retry.cost),
              repair_attempt: attempt,
              time_to_repair_ms: timeToRepair,
              assertion_strength: step.assertion.strength,
            };
            // Every pre-action this step needed in this run: the kept recorded
            // ones (ran on the first pass) and the repair's (ran on the
            // retry). The same count the rewritten row records.
            const preRan = keptPre.length + (retry.pre_action_count ?? 0);
            if (preRan > 0) final.pre_action_count = preRan;
            break;
          }

          lastOutcome = retry.outcome;
          lastMessage = retry.error_message;
          final = {
            ...retry,
            replay_valid: false,
            mode: "repair",
            repair_attempt: attempt,
            assertion_strength: step.assertion.strength,
          };
        }

        if (!repaired && !budgetStoppedRepair && final.outcome !== "REPAIR_EXHAUSTED") {
          // Ran out of repair budget mid-loop or never entered (budget already 0).
          if (repairCount >= this.maxRepairsPerRun || this.maxRepairsPerRun === 0) {
            const exhausted: StepAttemptResult = {
              step_index: step.step_index,
              outcome: "REPAIR_EXHAUSTED",
              replay_valid: false,
              mode: "repair",
              cost: final.cost,
              assertion_strength: step.assertion.strength,
              // Keep what actually went wrong; see the field's note.
              first_pass_outcome: first.outcome,
            };
            if (repairCount > 0) exhausted.repair_attempt = repairCount;
            const msg = final.error_message ?? lastMessage;
            if (msg !== undefined) exhausted.error_message = msg;
            final = exhausted;
          }
        }

        // If first failed and maxRepairsPerRun is 0, mark exhausted.
        if (this.maxRepairsPerRun === 0) {
          const exhausted: StepAttemptResult = {
            step_index: step.step_index,
            outcome: "REPAIR_EXHAUSTED",
            replay_valid: false,
            mode: "replay",
            cost: first.cost,
            assertion_strength: step.assertion.strength,
            first_pass_outcome: first.outcome,
          };
          if (first.error_message !== undefined) {
            exhausted.error_message = first.error_message;
          }
          final = exhausted;
        }

        void stepStarted;
      } else {
        final = {
          ...first,
          replay_valid: false,
          assertion_strength: step.assertion.strength,
        };
      }

      stepResults.push(final);
      this.emitStepMetric(program, runId, final);
      // After the metric, deliberately: the observation must never be able to
      // influence what was measured. See StepOutcomeObservation.
      this.observeStep(program, runId, final, repairedAction, repairedPreActions);

      if (!SUCCESS_OUTCOMES.has(final.outcome)) {
        // Stop on hard failure after repair exhaustion.
        break;
      }
    }

    const wallClock = Math.max(0, Date.now() - started);
    const stepsTotal = program.steps.length;
    const executedSuccess = stepResults.every((s) =>
      SUCCESS_OUTCOMES.has(s.outcome),
    );
    const taskSuccess =
      executedSuccess && stepResults.length === stepsTotal;
    const successWithLe2 = taskSuccess && repairCount <= 2;

    const runResult: RunResult = {
      run_id: runId,
      site_key: program.site_key,
      task_key: program.task_key,
      testbed_version: program.testbed_version,
      task_success: taskSuccess,
      repair_count: repairCount,
      success_with_le_2_repairs: successWithLe2,
      steps_total: stepsTotal,
      // What the run actually reached. Without it a truncated run is
      // indistinguishable from a short program in the NDJSON, and the
      // step-validity denominator would shrink with nothing saying so (#84).
      steps_attempted: stepResults.length,
      steps_replay_valid: stepsReplayValid,
      self_healed: selfHealed,
      time_to_repair_total_ms: timeToRepairTotal,
      step_results: stepResults,
      wall_clock_total_ms: wallClock,
      wall_clock_budget_ms: this.runBudgetMs,
      budget_exhausted: budgetExhausted,
      cost_fresh: this.costFresh,
      cost_replay: costReplay,
      cost_repair: costRepair,
    };
    // Only when it is false, and only when a repair actually ran: `true` on a
    // run that never asked anybody anything would assert a measurement that
    // did not happen, and absent already means measured.
    if (!repairCostMeasured) {
      runResult.repair_cost_measured = false;
    }
    if (this.costProgramBuild !== undefined) {
      runResult.cost_program_build = this.costProgramBuild;
    }
    if (this.programBuildId !== undefined) {
      runResult.program_build_id = this.programBuildId;
    }

    this.emitRunMetric(runResult);
    return runResult;
  }

  private async attemptStep(args: {
    program: CompiledProgram;
    step: CompiledStep;
    /** ADR-0024: run in order before `action`; the assertion is checked after `action` only. */
    preActions: CompiledAction[];
    action: CompiledAction;
    params: ParamBindings;
    runId: string;
    mode: "replay" | "repair";
    repairAttempt: number;
    dryIndex: number;
  }): Promise<StepAttemptResult> {
    const { step, preActions, action, params, mode, repairAttempt, dryIndex } = args;

    if (this.dryRun) {
      // First-pass uses dryRunOutcomes. A repair retry (only reached when a
      // client returned corrected_action) is treated as PASS so dry-run can
      // exercise REPAIRED_PASS without inventing live browser success.
      let outcome: StepOutcome =
        this.dryRunOutcomes[dryIndex] ??
        this.dryRunOutcomes[step.step_index] ??
        "PASS";
      if (mode === "repair" && isFailureOutcome(outcome)) {
        outcome = "PASS";
      }
      const result: StepAttemptResult = {
        step_index: step.step_index,
        outcome,
        replay_valid: mode === "replay" && outcome === "PASS",
        mode,
        cost: zeroCost(),
        assertion_strength: step.assertion.strength,
      };
      if (mode === "repair") result.repair_attempt = repairAttempt;
      if (outcome !== "PASS" && outcome !== "REPAIRED_PASS") {
        result.error_message = `dry-run outcome: ${outcome}`;
      }
      return result;
    }

    if (!this.page) {
      return {
        step_index: step.step_index,
        outcome: "PAGE_ERROR",
        replay_valid: false,
        mode,
        cost: zeroCost(),
        assertion_strength: step.assertion.strength,
        error_message: "live run requires a Playwright page (use dryRun)",
      };
    }

    let preCompleted = 0;
    const { result, wall_clock_ms } = await measureWallClock(async () => {
      let controlsBefore: Set<string> | undefined;
      // A pre-action that fails fails the step, with its own outcome: the
      // repair loop then sees exactly which part of the sequence broke, and
      // `preCompleted` says how much of it already acted on the page.
      for (const pre of preActions) {
        const preResult = await executeAction(this.page!, pre, params, {
          networkIdleWaitMs: this.networkIdleWaitMs,
        });
        if (!preResult.ok) {
          return {
            outcome: (preResult.outcome ?? "PAGE_ERROR") as StepOutcome,
            message:
              `pre-action ${preCompleted + 1} of ${preActions.length}: ` +
              (preResult.message ?? "failed"),
          };
        }
        preCompleted += 1;
      }
      // ADR-0026: after the pre-actions and right before the step's own
      // action (#230 review), so the count is of what THAT action revealed.
      // Before the pre-actions, closing a dialog would count as the page
      // "appearing" and a no-op own action would pass. Settled, so controls
      // still rendering from the previous step are not credited to this one.
      // A failed capture leaves it undefined, and the assertion then fails
      // saying so rather than passing blind.
      if (step.assertion.type === "controls-appeared") {
        controlsBefore = await settledControlKeys(this.page!).catch(() => undefined);
      }
      const actionResult = await executeAction(this.page!, action, params, {
        networkIdleWaitMs: this.networkIdleWaitMs,
      });
      if (!actionResult.ok) {
        return {
          outcome: (actionResult.outcome ?? "PAGE_ERROR") as StepOutcome,
          message: actionResult.message,
        };
      }
      // A `wait` whose networkidle hint never fired is not a failure — it
      // proceeds and says so, so the note has to survive a passing assertion.
      const notes =
        actionResult.settled === false ? actionResult.message : undefined;
      const assertionResult = await evaluateAssertion(
        this.page!,
        step.assertion,
        params,
        {
          ...(actionResult.target ? { actionTarget: actionResult.target } : {}),
          ...(controlsBefore ? { controlsBefore } : {}),
        },
      );
      return {
        outcome: assertionResult.outcome,
        message: assertionResult.message,
        notes,
      };
    });

    const out: StepAttemptResult = {
      step_index: step.step_index,
      outcome: result.outcome,
      replay_valid: mode === "replay" && result.outcome === "PASS",
      mode,
      cost: { tokens_in: 0, tokens_out: 0, wall_clock_ms },
      assertion_strength: step.assertion.strength,
    };
    if (mode === "repair") out.repair_attempt = repairAttempt;
    if (preCompleted > 0) out.pre_action_count = preCompleted;
    if (result.message !== undefined) out.error_message = result.message;
    if (result.notes !== undefined) out.notes = result.notes;
    return out;
  }

  /**
   * Hand the settled outcome to the optional observer (#64).
   *
   * Wrapped: a sink that throws must not take down a measurement run. The
   * cache is a recording of what happened, and losing that recording is
   * strictly better than losing the run that produced it — the run is the
   * measurement. The failure is reported, never swallowed silently.
   */
  private observeStep(
    program: CompiledProgram,
    runId: string,
    final: StepAttemptResult,
    repairedAction: CompiledAction | undefined,
    repairedPreActions: CompiledAction[],
  ): void {
    if (!this.onStepOutcome) return;
    const observation: StepOutcomeObservation = {
      site_key: program.site_key,
      task_key: program.task_key,
      step_index: final.step_index,
      outcome: final.outcome,
    };
    if (final.outcome === "REPAIRED_PASS" && repairedAction !== undefined) {
      observation.repair = {
        run_id: runId,
        repair_attempt: final.repair_attempt ?? 1,
        corrected_action: repairedAction,
        pre_actions: repairedPreActions,
      };
    }
    try {
      this.onStepOutcome(observation);
    } catch (err) {
      console.error(
        `onStepOutcome failed for step ${final.step_index}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private emitStepMetric(
    program: CompiledProgram,
    runId: string,
    step: StepAttemptResult,
  ): void {
    const row: StepMetric = {
      schema_version: METRICS_SCHEMA_VERSION,
      metric_kind: "step",
      run_id: runId,
      site_key: program.site_key,
      task_key: program.task_key,
      step_index: step.step_index,
      testbed_version: program.testbed_version,
      outcome: step.outcome,
      replay_valid: step.replay_valid,
      mode: step.mode,
      cost: step.cost,
      recorded_at: nowIso(),
    };
    if (step.repair_attempt !== undefined) {
      row.repair_attempt = step.repair_attempt;
    }
    if (step.time_to_repair_ms !== undefined) {
      row.time_to_repair_ms = step.time_to_repair_ms;
    }
    if (step.assertion_strength !== undefined) {
      row.assertion_strength = step.assertion_strength;
    }
    if (step.pre_action_count !== undefined) {
      row.pre_action_count = step.pre_action_count;
    }
    // Denormalized onto the step row so hit-rate aggregates from step rows
    // alone (#67) without joining to the run row — the same reason `site_key`
    // and `task_key` are already here.
    if (this.programSource !== undefined) row.program_source = this.programSource;
    this.metrics.emit(row);
  }

  private emitRunMetric(result: RunResult): void {
    const row: RunMetric = {
      schema_version: METRICS_SCHEMA_VERSION,
      metric_kind: "run",
      run_id: result.run_id,
      site_key: result.site_key,
      task_key: result.task_key,
      testbed_version: result.testbed_version,
      task_success: result.task_success,
      repair_count: result.repair_count,
      success_with_le_2_repairs: result.success_with_le_2_repairs,
      steps_total: result.steps_total,
      steps_attempted: result.steps_attempted,
      steps_replay_valid: result.steps_replay_valid,
      self_healed: result.self_healed,
      time_to_repair_total_ms: result.time_to_repair_total_ms,
      wall_clock_budget_ms: result.wall_clock_budget_ms,
      budget_exhausted: result.budget_exhausted,
      cost_fresh: result.cost_fresh,
      cost_replay: result.cost_replay,
      cost_repair: result.cost_repair,
      wall_clock_total_ms: result.wall_clock_total_ms,
      // Only when a repair ran: recording a context level for a run that never
      // asked a model anything would imply a measurement that did not happen.
      ...(result.repair_count > 0
        ? { repair_context_level: this.repairContextLevel }
        : {}),
      // ADR-0027: the per-run repair cap in force, null when uncapped (the
      // gate's setting). Absent on rows written before it, which ran at 2.
      repair_cap: Number.isFinite(this.maxRepairsPerRun) ? this.maxRepairsPerRun : null,
      // ADR-0025: whether the repair model was told the task's goal. Same
      // reason as the context level: two self-heal rates are not comparable
      // across it, and only meaningful when a repair actually ran.
      ...(result.repair_count > 0 && this.taskGoal !== undefined
        ? { repair_task_goal_sha256: taskGoalDigest(this.taskGoal) }
        : {}),
      ...(this.programSource !== undefined
        ? { program_source: this.programSource }
        : {}),
      // Only meaningful alongside a cache provenance, and only when the caller
      // actually told us — a run row must not imply a cache it never consulted.
      ...(this.programSource === "cache" && this.cacheProgramInvalidated !== undefined
        ? { cache_program_invalidated: this.cacheProgramInvalidated }
        : {}),
      recorded_at: nowIso(),
    };
    // Omitted rather than zero-filled: absent means "never measured", and the
    // amortization aggregate reports no_data on that rather than curve-fitting
    // a zero first point (#123).
    if (result.repair_cost_measured === false) {
      row.repair_cost_measured = false;
    }
    if (result.cost_program_build !== undefined) {
      row.cost_program_build = result.cost_program_build;
    }
    if (result.program_build_id !== undefined) {
      row.program_build_id = result.program_build_id;
    }
    this.metrics.emit(row as MetricRow);
  }
}
