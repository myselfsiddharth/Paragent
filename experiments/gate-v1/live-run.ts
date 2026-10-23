/**
 * Live per-version driver for the gate matrix (issue #62).
 *
 * Brings up one seeded test-bed version, drives a real browser through the
 * compiled program, and tears everything down. The measurement rules are the
 * whole point, so they are stated once here and enforced below:
 *
 * 1. **A failed step is the measurement, not an error to recover from.** Nothing
 *    in this file retries a step, downgrades an outcome, or catches an assertion
 *    failure. `ReplayRunner` owns the only permitted second attempt (repair,
 *    bounded by `maxRepairsPerRun`), and its `StepOutcome` is emitted verbatim.
 *
 * 2. **A skip is not a failure.** A version whose container never started, whose
 *    image would not pull, or whose seed state does not match the base version
 *    produced no measurement at all. Recording that as a failed run would invent
 *    a data point; dropping it would shrink the denominator silently. Skips go
 *    to the ledger with a reason and never reach the NDJSON.
 *
 * 3. **Teardown is unconditional.** Every bring-up is paired with a `finally`,
 *    so a crash mid-version cannot leave a container holding port 3000 and make
 *    the *next* version fail for a reason that has nothing to do with churn.
 */

import { chromium, type Browser, type Page } from "playwright";
import { MetricsEmitter } from "../../src/metrics/emitter.js";
import type { Cost, ProgramSource } from "../../src/metrics/types.js";
import { establishSession, LoginFailedError } from "../../src/recorder/preamble.js";
import { SessionAuthorization } from "../../src/session/consent.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import type {
  CompiledProgram,
  ParamBindings,
  RunResult,
} from "../../src/runner/types.js";
import {
  FIXTURE_ADMIN_PASS,
  FIXTURE_ADMIN_USER,
} from "../../src/testbed/constants.js";
import {
  buildComposeEnv,
  composeDown,
  composeUp,
  type ComposeEnv,
} from "../../src/testbed/docker.js";
import type { MatrixVersion } from "../../src/testbed/matrix.js";
import { prepareProvisioningOverlay } from "../../src/testbed/provisioning.js";
import {
  readinessPlan,
  ReadinessTimeoutError,
  waitUntilReady,
} from "../../src/testbed/readiness.js";
import { seedInstance } from "../../src/testbed/seed.js";
import {
  buildFingerprint,
  canonicalJson,
  type SeedFingerprint,
} from "../../src/testbed/verify.js";

/**
 * Default repeats per version.
 *
 * PRD §9 asks for **≥42 runs and ≥400 step-executions**. Against the eight
 * ADR-0003 pins that needs `--runs 6` (48 runs); `--runs 5` is 40 and lands two
 * runs short, so the arithmetic in #66's suggestion of 5 does not quite clear
 * its own floor.
 *
 * The default is nevertheless **3**, and the gap is reported rather than hidden:
 *
 * - 3 is enough to *see* flakiness. Any disagreement between repeats of one
 *   unchanged version is the harness's, and one run per version cannot show it
 *   at all. That is the question blocking every later number.
 * - 6 × 8 versions is 48 container boots. A default nobody runs teaches nothing,
 *   and the floor is a property of the *published measurement*, not of the loop
 *   you run while developing.
 * - `section9SampleFloor()` puts the shortfall in the report, so a 24-run matrix
 *   can never be mistaken for a §9 measurement. Clearing the floor is an
 *   explicit `--runs 6`, stated in the run that claims it.
 */
export const DEFAULT_RUNS_PER_VERSION = 3;

/** Repeats needed to clear §9's ≥42 runs across a matrix of `versionCount` pins. */
export function runsToClearSection9(versionCount: number): number {
  if (versionCount <= 0) return 0;
  return Math.ceil(42 / versionCount);
}

/**
 * Substitute `{run}` in a caller-supplied param value.
 *
 * The gate task creates a dashboard, so replaying it twice against one container
 * collides on the second run and produces a **spurious failure** — a run that
 * failed for a reason that is not churn, which is exactly the kind of data point
 * #66 exists to keep out of the denominator.
 *
 * Making the value unique per run is the cheap fix, and it is deliberately
 * explicit rather than automatic: the caller writes
 * `--param dashboard_title="Gate {run}"` and can see in the command that state
 * is being varied. Auto-suffixing every param would silently change values a
 * recording captured, and the assertion templates would still be comparing
 * against the recorded hole.
 *
 * The alternative — `--fresh-container-per-run` — is the correct-but-expensive
 * option for tasks whose mutation cannot be parameterised away.
 */
export function substituteRunIndex(
  params: Record<string, string>,
  runIndex: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = value.replaceAll("{run}", String(runIndex));
  }
  return out;
}

/** Stage at which a version was abandoned before any step could be measured. */
export type SkipStage =
  | "compose-up"
  | "readiness"
  | "seed"
  | "fingerprint"
  | "browser"
  | "login-preamble"
  /** Operator stopped the matrix. Runs already completed are kept. */
  | "interrupted";

export interface VersionSkip {
  id: string;
  reason: string;
  stage: SkipStage;
}

export interface LiveRunOutcome {
  /**
   * One entry per **completed** run, in order. Empty when the version was
   * skipped before any run started.
   *
   * Never filtered. A run that failed is a measurement; dropping it is the
   * single easiest way to manufacture a passing gate, and it would be invisible
   * in the report (#66).
   */
  results: RunResult[];
  /**
   * Present when the version produced no measurement *at all*, or when repeats
   * were cut short. A skip after run 1 of 3 keeps the run it did complete.
   */
  skip?: VersionSkip;
  /** Seed fingerprint observed, when we got far enough to read one. */
  fingerprint?: SeedFingerprint;
}

export interface LiveRunOptions {
  version: MatrixVersion;
  program: CompiledProgram;
  matrixImage: string;
  baseUrlTemplate: string;
  hostPort: number;
  emitter: MetricsEmitter;
  headed: boolean;
  /** Leave the container up after the run (debugging). */
  keepUp: boolean;
  /** Log in before the program runs. Off for programs that log in themselves. */
  preamble: boolean;
  /**
   * Caller-supplied bindings for the program's own `param_refs`. Merged over
   * the driver's `base_url`/`host`/`port`, never under them — a program cannot
   * redirect itself away from the version being measured.
   */
  extraParams?: Record<string, string>;
  readyTimeoutSeconds?: number;
  maxRepairsPerRun?: number;
  /**
   * Where the program came from (#118). Passed through rather than inferred:
   * this module is handed a `CompiledProgram` and cannot tell a cache-resolved
   * one from a file-loaded one — which is the point of recording it.
   */
  programSource?: ProgramSource;
  /** Advisory cache-health flag (ADR-0009). Never changes what is attempted. */
  cacheProgramInvalidated?: boolean;
  /**
   * Opt-in real repair model (#27). Absent means the stub, which proposes
   * nothing and costs nothing — the default everywhere, so no run spends money
   * or makes a network call unless it was asked to.
   */
  repairClient?: RepairModelClient;
  /**
   * Measured fresh-reasoning baseline (#39), loaded by the caller from
   * `experiments/gate-v1/out/fresh-baseline/baseline.json` and broadcast onto
   * every run row's `cost_fresh`. Absent means `ReplayRunner`'s own default —
   * `zeroCost()`, which `repairCostVsFresh()` reads as `no_data`. This is the
   * measured comparison baseline, never the amortization numerator; see
   * `ReplayRunnerOptions.costFresh` and ADR-0010.
   */
  costFresh?: Cost;
  /**
   * The task's goal, handed to the repair model (ADR-0025). The matrix passes
   * the same text the fresh baseline gets, or nothing.
   */
  taskGoal?: string;
  /**
   * Claim the matrix's ONE-TIME program-build payment (#39 step 4, ADR-0010).
   *
   * Called once per run. It answers with the payment for the **first** run that
   * asks and `undefined` for every run after, across the whole matrix — which
   * is the entire point: §12's numerator sums `cost_program_build`, so a
   * payment repeated per run grows it linearly with N, flattens the curve, and
   * shows nothing. A callback rather than a `Cost` because "was this the first
   * run?" is not a question this function can answer — it sees one version.
   */
  claimProgramBuildPayment?: () => { cost: Cost; program_build_id: string } | undefined;
  /** Repeats of the program against this version. Defaults to 1. */
  runs?: number;
  /**
   * Called after each run's rows are emitted, so the caller can persist them
   * before the next run starts. Without it an interrupt loses every row the
   * matrix has produced so far.
   */
  onRunComplete?: (runIndex: number, result: RunResult) => Promise<void>;
  /** Cooperative cancellation — checked between runs, never mid-run. */
  shouldStop?: () => boolean;
  /**
   * Baseline to compare this version's seed state against. Undefined for the
   * first version walked, which *becomes* the baseline.
   */
  baseline?: { id: string; fingerprint: SeedFingerprint };
  log?: (line: string) => void;
}

/**
 * Why a fingerprint mismatch aborts the version rather than failing it.
 *
 * The matrix measures how much *browser churn* a version introduces. If the
 * seeded state itself differs — a panel missing, the operator absent — then a
 * step failure could be the seed's fault rather than the surface's, and the run
 * would confound the two. There is no honest way to attribute it after the
 * fact, so the version produces no data point instead of a misleading one.
 *
 * Exported for unit test: this decision must be inspectable without Docker.
 */
export function fingerprintMismatch(
  baseline: { id: string; fingerprint: SeedFingerprint },
  observed: SeedFingerprint,
): string | null {
  const left = canonicalJson(baseline.fingerprint);
  const right = canonicalJson(observed);
  if (left === right) return null;
  return (
    `seed state differs from base version ${baseline.id}; ` +
    `a state difference would confound the churn measurement. ` +
    `Compare with: npm run testbed -- --version <id> --verify --json`
  );
}

/** One-line, greppable summary of a measured version. */
export function formatRunLine(versionId: string, r: RunResult): string {
  return (
    `${versionId}: ${r.task_success ? "SUCCESS" : "FAILED"} ` +
    `steps_valid=${r.steps_replay_valid}/${r.steps_total} ` +
    `repairs=${r.repair_count} ` +
    `wall=${(r.wall_clock_total_ms / 1000).toFixed(1)}s`
  );
}

/**
 * Run one version end to end.
 *
 * Never throws for a measurable failure — a failed program is a returned
 * `result` whose `task_success` is false. It throws only if the caller's own
 * arguments are unusable, which is a bug rather than a data point.
 */
export async function runVersionLive(
  opts: LiveRunOptions,
): Promise<LiveRunOutcome> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const ver = opts.version;
  const baseUrl = opts.baseUrlTemplate.replace("{port}", String(opts.hostPort));

  const provisioningDir = prepareProvisioningOverlay(ver.id);
  const env: ComposeEnv = buildComposeEnv({
    versionId: ver.id,
    imageTag: ver.image_tag,
    provisioningDir,
    hostPort: opts.hostPort,
  });

  let browser: Browser | undefined;
  try {
    // --- bring up -----------------------------------------------------------
    log(`  ${ver.id}: docker compose up (${opts.matrixImage}:${ver.image_tag})`);
    const up = composeUp(env, false);
    if (!up.ok) {
      return {
        results: [],
        skip: {
          id: ver.id,
          stage: "compose-up",
          // The daemon's own words. A paraphrase would lose the pull error that
          // usually explains it.
          reason: composeFailureReason(up.stderr, up.stdout),
        },
      };
    }

    const plan = readinessPlan(baseUrl, opts.readyTimeoutSeconds);
    try {
      const ready = await waitUntilReady({ versionId: ver.id, plan });
      log(`  ${ver.id}: ready after ${(ready.elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      if (!(err instanceof ReadinessTimeoutError)) throw err;
      return {
        results: [],
        skip: { id: ver.id, stage: "readiness", reason: err.message },
      };
    }

    try {
      await seedInstance({
        baseUrl,
        versionId: ver.id,
        timeoutMs: plan.timeoutMs,
      });
    } catch (err) {
      return {
        results: [],
        skip: { id: ver.id, stage: "seed", reason: errText(err) },
      };
    }

    // --- seed-state gate ----------------------------------------------------
    let observed: SeedFingerprint;
    try {
      observed = (await buildFingerprint(baseUrl)).fingerprint;
    } catch (err) {
      return {
        results: [],
        skip: { id: ver.id, stage: "fingerprint", reason: errText(err) },
      };
    }

    if (opts.baseline) {
      const mismatch = fingerprintMismatch(opts.baseline, observed);
      if (mismatch) {
        return {
          results: [],
          fingerprint: observed,
          skip: { id: ver.id, stage: "fingerprint", reason: mismatch },
        };
      }
    }

    // --- browser ------------------------------------------------------------
    try {
      browser = await chromium.launch({
        headless: !opts.headed,
        // Playwright installs its own signal handlers by default and closes the
        // browser on SIGINT. That fires *during* an in-flight run, so the next
        // `capturePageState` throws "Target page, context or browser has been
        // closed" and the matrix dies with a stack trace instead of finishing
        // the run it was told to finish. The driver owns this lifecycle: it
        // closes the browser in its own `finally`, after the current run.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (err) {
      return {
        results: [],
        fingerprint: observed,
        skip: { id: ver.id, stage: "browser", reason: errText(err) },
      };
    }

    // --- measure, `runs` times ----------------------------------------------
    const runProgram: CompiledProgram = {
      ...opts.program,
      testbed_version: ver.id,
    };
    const totalRuns = Math.max(1, opts.runs ?? 1);
    const results: RunResult[] = [];

    for (let runIndex = 1; runIndex <= totalRuns; runIndex++) {
      if (opts.shouldStop?.()) {
        return {
          results,
          fingerprint: observed,
          skip: {
            id: ver.id,
            stage: "interrupted",
            reason:
              `interrupted after ${results.length} of ${totalRuns} run(s); ` +
              "the completed runs are in the NDJSON and are real measurements",
          },
        };
      }

      // A fresh context per run, not merely per version. Reusing one would let
      // run 1's cookies, storage and cache decide run 2's outcome — the repeats
      // would correlate and the spread would understate real variance, which is
      // the one thing repeat runs exist to measure.
      const context = await browser.newContext();
      try {
        const page: Page = await context.newPage();

        if (opts.preamble) {
          try {
            // SessionAuthorization.authorize (SC-05, #102): no `consent`
            // argument — the gate matrix always targets the local test-bed
            // with fixture credentials the project owns (ADR-0003), so
            // there is no account holder to consent on behalf of. A
            // non-local baseUrl here would refuse with ConsentRequiredError.
            const session = await establishSession(page, {
              target: SessionAuthorization.authorize(baseUrl),
              username: FIXTURE_ADMIN_USER,
              password: FIXTURE_ADMIN_PASS,
            });
            if (runIndex === 1) {
              log(
                `  ${ver.id}: session as ${session.user_login}` +
                  `${session.dismissed_first_run_modal ? " (dismissed first-run dialog)" : ""}`,
              );
            }
          } catch (err) {
            // Login is scaffolding, not a measured step (#60). A broken login is
            // a run we could not measure, not a run that failed the task.
            const stage = err instanceof LoginFailedError ? err.stage : "unknown";
            return {
              results,
              fingerprint: observed,
              skip: {
                id: ver.id,
                stage: "login-preamble",
                reason:
                  `login failed at ${stage} on run ${runIndex}/${totalRuns}: ` +
                  errText(err),
              },
            };
          }
        }

        // Claimed here, immediately before the runner that will carry it, so a
        // run that never starts cannot consume the payment and leave the curve
        // with no first point.
        const payment = opts.claimProgramBuildPayment?.();

        const runner = new ReplayRunner({
          dryRun: false,
          page,
          metrics: opts.emitter,
          maxRepairsPerRun: opts.maxRepairsPerRun ?? 2,
          ...(opts.programSource ? { programSource: opts.programSource } : {}),
          ...(opts.cacheProgramInvalidated !== undefined
            ? { cacheProgramInvalidated: opts.cacheProgramInvalidated }
            : {}),
          ...(opts.repairClient ? { repairClient: opts.repairClient } : {}),
          ...(opts.costFresh ? { costFresh: opts.costFresh } : {}),
          ...(opts.taskGoal ? { taskGoal: opts.taskGoal } : {}),
          // Both or neither: ReplayRunner throws on a cost without an id.
          ...(payment
            ? {
                costProgramBuild: payment.cost,
                programBuildId: payment.program_build_id,
              }
            : {}),
        });

        const params: ParamBindings = {
          ...substituteRunIndex(opts.extraParams ?? {}, runIndex),
          base_url: baseUrl,
          host: hostOf(baseUrl),
          port: opts.hostPort,
        };

        // Deliberately unguarded. An exception here is a harness bug and must
        // not be laundered into a skip — that would hide a broken driver as
        // missing data.
        const result = await runner.run(runProgram, params);
        results.push(result);
        const label = `${ver.id} run ${runIndex}/${totalRuns}`;
        log(`  ${formatRunLine(label, result)}`);
        await opts.onRunComplete?.(runIndex, result);
      } finally {
        await context.close().catch(() => undefined);
      }
    }

    return { results, fingerprint: observed };
  } finally {
    await browser?.close().catch(() => undefined);
    if (opts.keepUp) {
      log(`  ${ver.id}: --keep-up, leaving container running at ${baseUrl}`);
    } else {
      const down = composeDown(env, false);
      if (!down.ok) {
        // Surfaced, never swallowed: a container still holding the port makes
        // the next version fail for a reason that is not churn.
        console.error(
          `  ${ver.id}: teardown reported a problem — ${lastLines(down.stderr, 2)}`,
        );
      }
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 300);
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n).join(" / ").slice(0, 400);
}

/**
 * The reason a `compose up` failed, as the daemon reported it.
 *
 * Compose interleaves per-container **progress** ("Creating", "Created",
 * "Starting") with the actual error, and it does not consistently choose a
 * stream. Taking the first lines yields the progress noise and buries the
 * cause, which makes a skip reason useless for the person reading the ledger
 * later — so this prefers stderr, and reads from the end where the failure is.
 *
 * Exported for unit test: a skip reason is the only record of why a version
 * produced no data, and it must not silently degrade to "Creating".
 */
export function composeFailureReason(stderr: string, stdout: string): string {
  const preferred = stderr.trim() ? stderr : stdout;
  const meaningful = preferred
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/\b(Creating|Created|Starting|Pulling|Waiting|Running)\s*$/.test(l));

  if (meaningful.length > 0) return meaningful.slice(-3).join(" / ").slice(0, 400);
  // Everything was progress chatter — say so rather than quoting "Creating".
  const tail = lastLines(preferred, 2);
  return tail
    ? `compose up failed with no error line; last output: ${tail}`
    : "compose up failed with no output from docker";
}
