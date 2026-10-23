#!/usr/bin/env node
/**
 * Fresh-reasoning baseline runner (issue #39) — a **separate entry point**,
 * not a mode of `run-matrix.ts` / `ReplayRunner`, because it measures a
 * different thing: what it costs a model to do the gate task **from scratch**,
 * with no compiled trajectory, no cached locators, and no step list. Read
 * [`docs/gate/fresh-baseline.md`](../../docs/gate/fresh-baseline.md) before
 * touching this file — the definition lives there, and the number this script
 * produces means nothing without it.
 *
 * Two modes, same posture as `run-matrix.ts`:
 *
 * - `--dry-run` walks the loop with no Docker and no browser, using
 *   `StubFreshBaselineClient`. It exercises the harness — argument parsing,
 *   the aggregate math, the output files — and every row it writes carries
 *   `DRY_RUN_NOTE`. **It is not a measurement**, and `out/fresh-baseline/baseline.json`
 *   says so in `not_a_measurement` and `usable: false`.
 * - The live path brings up one seeded container (mirroring
 *   `experiments/gate-v1/live-run.ts`), logs in, and runs
 *   `AnthropicFreshBaselineClient` against it `--runs` times. Costs real money
 *   and needs `ANTHROPIC_API_KEY` — never invoked by `npm run ci` or any test.
 *
 * ## What this writes
 *
 * - `out/fresh-baseline/metrics.ndjson` — one `RunMetric` row per attempt,
 *   through the same `MetricsEmitter` the rest of the harness uses. **Never
 *   read by `gate:report`** (`experiments/gate-v1/report/generate-amortized.ts`
 *   hard-codes `out/metrics.ndjson`, a different file) and must never be
 *   copied or merged into it — see the module note on
 *   `src/runner/fresh-baseline-runner.ts` for why mixing them would corrupt
 *   every §9 aggregate that pools run rows.
 * - `out/fresh-baseline/baseline.json` — the protocol record #39 asks for:
 *   model id, effort, run count, date, testbed version, per-run costs, and the
 *   mean + spread. This is what `gate:matrix --cost-fresh <path>` reads to
 *   attach a measured baseline to the matrix's own run rows.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { MetricsEmitter } from "../../src/metrics/emitter.js";
import { zeroCost } from "../../src/metrics/cost.js";
import type { Cost } from "../../src/metrics/types.js";
import {
  FreshBaselineRunner,
  type FreshBaselineRunResult,
} from "../../src/runner/fresh-baseline-runner.js";
import { StubFreshBaselineClient, type FreshBaselineClient } from "../../src/runner/fresh-baseline.js";
import {
  AnthropicFreshBaselineClient,
  DEFAULT_FRESH_EFFORT,
  DEFAULT_FRESH_MODEL,
  DEFAULT_MAX_TURNS,
} from "../../src/runner/fresh-baseline-anthropic.js";
import { VoyagerFreshBaselineClient } from "../../src/runner/fresh-baseline-voyager.js";
import { DEFAULT_VOYAGER_MODEL } from "../../src/runner/repair-voyager.js";
import { establishSession, LoginFailedError } from "../../src/recorder/preamble.js";
import { SessionAuthorization } from "../../src/session/consent.js";
import {
  DEFAULT_HOST_PORT,
  FIXTURE_ADMIN_PASS,
  FIXTURE_ADMIN_USER,
} from "../../src/testbed/constants.js";
import {
  buildComposeEnv,
  composeDown,
  composeUp,
  dockerAvailable,
  type ComposeEnv,
} from "../../src/testbed/docker.js";
import { getVersion, listVersions, loadMatrix, type MatrixVersion } from "../../src/testbed/matrix.js";
import { prepareProvisioningOverlay } from "../../src/testbed/provisioning.js";
import { readinessPlan, ReadinessTimeoutError, waitUntilReady } from "../../src/testbed/readiness.js";
import { seedInstance } from "../../src/testbed/seed.js";
import { loadDotEnv } from "./load-env.js";
import { loadProgram } from "./run-matrix.js";
import { DEFAULT_TASK_GOAL } from "./task-goal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out", "fresh-baseline");
const DEFAULT_PROGRAM = path.join(__dirname, "fixtures/compiled-program.json");

const DRY_RUN_NOTE = "dry-run — tokens remain 0; not a fresh-baseline measurement";

/** At least 3 (issue #39's own floor: mean and spread need more than one sample). */
export const DEFAULT_FRESH_RUNS = 3;

// ADR-0025: shared with the repair side of the matrix, so it lives in one place.
export { DEFAULT_TASK_GOAL };

interface Args {
  dryRun: boolean;
  help: boolean;
  headed: boolean;
  keepUp: boolean;
  preamble: boolean;
  program?: string;
  version?: string;
  taskGoal: string;
  runs: number;
  model?: string;
  effort?: string;
  /** Which provider drives the fresh attempts. Must match the repair client's. */
  provider: FreshProvider;
  maxTurns?: number;
  port?: number;
}

export type FreshProvider = "anthropic" | "voyager";
const FRESH_PROVIDERS: readonly FreshProvider[] = ["anthropic", "voyager"];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    help: false,
    headed: false,
    keepUp: false,
    preamble: true,
    taskGoal: DEFAULT_TASK_GOAL,
    runs: DEFAULT_FRESH_RUNS,
    provider: "anthropic",
  };
  const valued = new Set([
    "--program", "--version", "--task-goal", "--runs", "--model", "--effort", "--max-turns", "--port",
    "--provider",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--headed") args.headed = true;
    else if (a === "--keep-up") args.keepUp = true;
    else if (a === "--no-preamble") args.preamble = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (valued.has(a)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${a} requires a value`);
      assignValue(args, a.slice(2), value);
    } else if ([...valued].some((flag) => a.startsWith(`${flag}=`))) {
      const eq = a.indexOf("=");
      assignValue(args, a.slice(2, eq), a.slice(eq + 1));
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function assignValue(args: Args, key: string, value: string): void {
  if (key === "program") args.program = value;
  else if (key === "version") args.version = value;
  else if (key === "task-goal") args.taskGoal = value;
  else if (key === "model") args.model = value;
  else if (key === "effort") args.effort = value;
  else if (key === "provider") {
    if (!(FRESH_PROVIDERS as readonly string[]).includes(value)) {
      throw new Error(`--provider must be one of ${FRESH_PROVIDERS.join(", ")}, got: ${value}`);
    }
    args.provider = value as FreshProvider;
  }
  else if (key === "runs") {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error(`--runs must be >= 1, got: ${value}`);
    args.runs = n;
  } else if (key === "max-turns") {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error(`--max-turns must be >= 1, got: ${value}`);
    args.maxTurns = n;
  } else if (key === "port") {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --port: ${value}`);
    args.port = n;
  }
}

function usage(): void {
  console.log(`Usage: npm run gate:baseline -- [--dry-run] [options]

  --dry-run          No Docker, no browser, no model. Zero-token rows via
                     StubFreshBaselineClient, labelled "not a measurement".
  --program <path>   Compiled program or compiled_trajectory bundle whose
                     site_key/task_key this baseline is measured against
                     (never its steps — those are not shown to the model).
                     Default: experiments/gate-v1/fixtures/compiled-program.json
  --version <id>     Matrix version to seed and run against (#39 step 2: same
                     task, same instance as the compiled program). Default:
                     the first id in scripts/testbed/matrix.json.
  --task-goal <text> Override the prose goal handed to the model. Default is
                     ADR-0006's gate task, stated at intent level only.
  --runs <n>         Fresh attempts (default ${DEFAULT_FRESH_RUNS}). #39 wants at least 3 so a
                     mean has a spread beside it, not just a single sample.
  --provider <p>     anthropic (default) | voyager. voyager is ASU's OpenAI-spec
                     gateway (needs VOYAGER_API_KEY). MUST match the repair
                     client's provider and model, or the §9 ratio is about
                     model choice. --effort does not apply to voyager.
  --model <id>       Overrides the provider default (anthropic:
                     ${DEFAULT_FRESH_MODEL}; voyager: ${DEFAULT_VOYAGER_MODEL}).
  --effort <level>   Overrides DEFAULT_FRESH_EFFORT (${DEFAULT_FRESH_EFFORT}). Anthropic only.
  --max-turns <n>    Overrides DEFAULT_MAX_TURNS (${DEFAULT_MAX_TURNS}) per attempt.
  --port <n>         Host port for the test-bed (default ${DEFAULT_HOST_PORT}).
  --headed           Show the browser (live only).
  --keep-up          Leave the container running after the run, for inspection.
  --no-preamble      Skip the login preamble.
  --help             Show this help.

A live run needs ANTHROPIC_API_KEY (or VOYAGER_API_KEY with --provider voyager) and costs real money — keep --runs small and
deliberate. Writes out/fresh-baseline/metrics.ndjson (through MetricsEmitter,
its own file — never merged with the matrix's out/metrics.ndjson) and
out/fresh-baseline/baseline.json (the protocol record + mean/spread that
"gate:matrix --cost-fresh <path>" reads).
`);
}

interface RunRecord {
  run_id: string;
  task_success: boolean;
  tokens_in: number;
  tokens_out: number;
  wall_clock_ms: number;
  model_id?: string;
  turns: number;
  notes: string;
  /**
   * True for an attempt excluded from the mean: zeros because it could not run
   * at all, or cut short by a transport failure (a truncated cost).
   */
  unmeasured: boolean;
  aborted?: "transport";
}

export function toRunRecord(result: FreshBaselineRunResult, dryRun: boolean): RunRecord {
  const c = result.cost_fresh;
  const unmeasured =
    !dryRun &&
    ((c.tokens_in === 0 && c.tokens_out === 0 && c.wall_clock_ms === 0) || result.aborted === "transport");
  return {
    run_id: result.run_id,
    task_success: result.task_success,
    tokens_in: c.tokens_in,
    tokens_out: c.tokens_out,
    wall_clock_ms: c.wall_clock_ms,
    ...(c.model_id !== undefined ? { model_id: c.model_id } : {}),
    turns: result.turns,
    notes: dryRun ? DRY_RUN_NOTE : result.notes,
    unmeasured,
    ...(result.aborted ? { aborted: result.aborted } : {}),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate a batch of attempts into the protocol record #39 asks for.
 *
 * Only attempts that produced *any* real signal (a non-zero token or
 * wall-clock reading) enter the mean and spread — an attempt that could not be
 * measured at all (a construction failure, a page that never loaded) is a
 * missing data point, not a free one, and averaging a true zero into the mean
 * would understate the cost rather than report "no data" honestly (CONTRIBUTING
 * rule 3). `measured_runs` says how many contributed; a live baseline whose
 * `measured_runs` is 0 is `usable: false` and `gate:matrix --cost-fresh` must
 * refuse it rather than wire in a zero that looks like a real measurement.
 */
export function buildBaselineSummary(opts: {
  records: RunRecord[];
  dryRun: boolean;
  effort: string;
  siteKey: string;
  taskKey: string;
  testbedVersion: string;
  taskGoal: string;
  generatedAt?: string;
  /** Recorded for provenance only; nothing downstream reads it. */
  provider?: string;
}): {
  schema_version: "1.0.0";
  kind: "fresh_baseline_run";
  generated_at: string;
  dry_run: boolean;
  not_a_measurement?: string;
  usable: boolean;
  model_id: string | null;
  provider?: string;
  effort: string;
  testbed_version: string;
  site_key: string;
  task_key: string;
  task_goal: string;
  runs_attempted: number;
  measured_runs: number;
  successes: number;
  runs: RunRecord[];
  mean_cost_fresh: Cost;
  spread: {
    tokens_in: { min: number; max: number };
    tokens_out: { min: number; max: number };
    wall_clock_ms: { min: number; max: number };
  } | null;
} {
  const { records, dryRun } = opts;
  const measured = records.filter((r) => !r.unmeasured);
  const modelId = measured.find((r) => r.model_id !== undefined)?.model_id ?? null;

  const meanCost: Cost = measured.length > 0
    ? {
        tokens_in: Math.round(mean(measured.map((r) => r.tokens_in))),
        tokens_out: Math.round(mean(measured.map((r) => r.tokens_out))),
        wall_clock_ms: Math.round(mean(measured.map((r) => r.wall_clock_ms))),
        ...(modelId ? { model_id: modelId } : {}),
      }
    : zeroCost();

  const spread = measured.length > 0
    ? {
        tokens_in: {
          min: Math.min(...measured.map((r) => r.tokens_in)),
          max: Math.max(...measured.map((r) => r.tokens_in)),
        },
        tokens_out: {
          min: Math.min(...measured.map((r) => r.tokens_out)),
          max: Math.max(...measured.map((r) => r.tokens_out)),
        },
        wall_clock_ms: {
          min: Math.min(...measured.map((r) => r.wall_clock_ms)),
          max: Math.max(...measured.map((r) => r.wall_clock_ms)),
        },
      }
    : null;

  return {
    schema_version: "1.0.0",
    kind: "fresh_baseline_run",
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    dry_run: dryRun,
    ...(dryRun ? { not_a_measurement: DRY_RUN_NOTE } : {}),
    // Dry-run is never usable regardless of measured_runs (Stub always reports
    // zeros, which would otherwise look "measured" by the same test below).
    usable: !dryRun && measured.length > 0,
    model_id: modelId,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    effort: opts.effort,
    testbed_version: opts.testbedVersion,
    site_key: opts.siteKey,
    task_key: opts.taskKey,
    task_goal: opts.taskGoal,
    runs_attempted: records.length,
    measured_runs: measured.length,
    successes: records.filter((r) => r.task_success).length,
    runs: records,
    mean_cost_fresh: meanCost,
    spread,
  };
}

async function runDry(
  args: Args,
  emitter: MetricsEmitter,
  context: { site_key: string; task_key: string; testbed_version: string },
): Promise<RunRecord[]> {
  const runner = new FreshBaselineRunner({ client: new StubFreshBaselineClient(), metrics: emitter });
  const records: RunRecord[] = [];
  for (let i = 1; i <= args.runs; i++) {
    const result = await runner.run({
      site_key: context.site_key,
      task_key: context.task_key,
      testbed_version: context.testbed_version,
      task_goal: args.taskGoal,
      base_url: "file://local-demo",
    });
    const record = toRunRecord(result, true);
    console.log(`  [dry-run ${i}/${args.runs}] ${JSON.stringify(record)}`);
    records.push(record);
  }
  return records;
}

async function runLive(
  args: Args,
  emitter: MetricsEmitter,
  context: { site_key: string; task_key: string },
  matrixVersion: MatrixVersion,
  matrixImage: string,
  baseUrlTemplate: string,
  hostPort: number,
): Promise<{ records: RunRecord[]; skipReason?: string }> {
  const client: FreshBaselineClient =
    args.provider === "voyager"
      ? new VoyagerFreshBaselineClient({
          ...(args.model ? { model: args.model } : {}),
          ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        })
      : new AnthropicFreshBaselineClient({
          ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { effort: args.effort as never } : {}),
          ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
        });
  const runner = new FreshBaselineRunner({ client, metrics: emitter });

  const baseUrl = baseUrlTemplate.replace("{port}", String(hostPort));
  const provisioningDir = prepareProvisioningOverlay(matrixVersion.id);
  const env: ComposeEnv = buildComposeEnv({
    versionId: matrixVersion.id,
    imageTag: matrixVersion.image_tag,
    provisioningDir,
    hostPort,
  });

  const records: RunRecord[] = [];
  let browser: Browser | undefined;
  try {
    console.log(`  ${matrixVersion.id}: docker compose up (${matrixImage}:${matrixVersion.image_tag})`);
    const up = composeUp(env, false);
    if (!up.ok) {
      return { records, skipReason: `compose-up: ${lastLines(up.stderr || up.stdout, 3)}` };
    }

    const plan = readinessPlan(baseUrl);
    try {
      const ready = await waitUntilReady({ versionId: matrixVersion.id, plan });
      console.log(`  ${matrixVersion.id}: ready after ${(ready.elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      if (!(err instanceof ReadinessTimeoutError)) throw err;
      return { records, skipReason: `readiness: ${err.message}` };
    }

    await seedInstance({ baseUrl, versionId: matrixVersion.id, timeoutMs: plan.timeoutMs });

    browser = await chromium.launch({
      headless: !args.headed,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    for (let i = 1; i <= args.runs; i++) {
      const runContext = await browser.newContext();
      try {
        const page = await runContext.newPage();
        if (args.preamble) {
          try {
            // SessionAuthorization.authorize (SC-05, #102): no `consent`
            // argument — the fresh-baseline runner always targets the local
            // test-bed with fixture credentials the project owns (ADR-0003),
            // so there is no account holder to consent on behalf of. A
            // non-local baseUrl here would refuse with ConsentRequiredError.
            await establishSession(page, {
              target: SessionAuthorization.authorize(baseUrl),
              username: FIXTURE_ADMIN_USER,
              password: FIXTURE_ADMIN_PASS,
            });
          } catch (err) {
            const stage = err instanceof LoginFailedError ? err.stage : "unknown";
            console.error(`  ${matrixVersion.id}: login failed at ${stage} on run ${i}/${args.runs}: ${errText(err)}`);
            continue;
          }
        }
        const result = await runner.run({
          site_key: context.site_key,
          task_key: context.task_key,
          testbed_version: matrixVersion.id,
          task_goal: args.taskGoal,
          base_url: baseUrl,
          page,
        });
        const record = toRunRecord(result, false);
        console.log(`  [${i}/${args.runs}] ${JSON.stringify(record)}`);
        records.push(record);
        await emitter.appendFlush();
      } finally {
        await runContext.close().catch(() => undefined);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (args.keepUp) {
      console.log(`  ${matrixVersion.id}: --keep-up, leaving container running at ${baseUrl}`);
    } else {
      const down = composeDown(env, false);
      if (!down.ok) {
        console.error(`  ${matrixVersion.id}: teardown reported a problem — ${lastLines(down.stderr, 2)}`);
      }
    }
  }
  return { records };
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 300);
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n).join(" / ").slice(0, 400);
}

async function main(): Promise<void> {
  loadDotEnv();
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`gate:baseline: ${err instanceof Error ? err.message : err}`);
    usage();
    process.exit(2);
    return;
  }
  if (args.help) {
    usage();
    process.exit(0);
    return;
  }

  if (args.provider === "voyager" && args.effort !== undefined) {
    // Accepting it would let a caller believe effort shaped a run it cannot touch.
    console.error("gate:baseline: --effort does not apply to --provider voyager (no effort control on the gateway).");
    process.exit(2);
    return;
  }

  const programPath = args.program ?? DEFAULT_PROGRAM;
  let siteKey: string;
  let taskKey: string;
  try {
    const program = await loadProgram(programPath);
    siteKey = program.site_key;
    taskKey = program.task_key;
  } catch (err) {
    console.error(`gate:baseline: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    return;
  }

  const matrix = loadMatrix();
  const all = listVersions(matrix);
  const versionId = args.version ?? all[0]?.id;
  if (!versionId) {
    console.error("gate:baseline: matrix has no versions");
    process.exit(2);
    return;
  }
  let matrixVersion: MatrixVersion;
  try {
    matrixVersion = getVersion(versionId, matrix);
  } catch (err) {
    console.error(`gate:baseline: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    return;
  }

  if (args.runs < DEFAULT_FRESH_RUNS) {
    console.log(
      `  note: --runs ${args.runs} is below #39's own floor of ${DEFAULT_FRESH_RUNS} — ` +
        "fine for a smoke test, but a published baseline needs a mean AND a spread.",
    );
  }

  if (!args.dryRun && !dockerAvailable()) {
    console.error(
      "gate:baseline: a live run needs a running Docker daemon. " +
        "Start Docker, or pass --dry-run to exercise the harness without it.",
    );
    process.exit(2);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const ndjsonPath = path.join(OUT_DIR, "metrics.ndjson");
  const summaryPath = path.join(OUT_DIR, "baseline.json");
  const emitter = new MetricsEmitter(ndjsonPath);
  await writeFile(ndjsonPath, "", "utf8");

  console.log(
    `gate:baseline ${args.dryRun ? "dry-run" : "live"} — ${taskKey}@${matrixVersion.id}, ` +
      `${args.runs} run(s)${args.dryRun ? "" : ` (provider=${args.provider}, model=${args.model ?? (args.provider === "voyager" ? DEFAULT_VOYAGER_MODEL : DEFAULT_FRESH_MODEL)})`}`,
  );

  let records: RunRecord[];
  let skipReason: string | undefined;
  if (args.dryRun) {
    records = await runDry(args, emitter, { site_key: siteKey, task_key: taskKey, testbed_version: matrixVersion.id });
  } else {
    ({ records, skipReason } = await runLive(
      args,
      emitter,
      { site_key: siteKey, task_key: taskKey },
      matrixVersion,
      matrix.image,
      matrix.base_url_template,
      args.port ?? DEFAULT_HOST_PORT,
    ));
  }

  await emitter.appendFlush();

  const summary = buildBaselineSummary({
    records,
    dryRun: args.dryRun,
    effort: args.provider === "voyager" ? "n/a (voyager)" : (args.effort ?? DEFAULT_FRESH_EFFORT),
    provider: args.provider,
    siteKey,
    taskKey,
    testbedVersion: matrixVersion.id,
    taskGoal: args.taskGoal,
  });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`wrote ${ndjsonPath}`);
  console.log(`wrote ${summaryPath}`);
  console.log(
    `  measured ${summary.measured_runs}/${summary.runs_attempted} run(s), ` +
      `${summary.successes} succeeded, usable=${summary.usable}`,
  );

  if (skipReason) {
    console.error(`gate:baseline: ${matrixVersion.id} — ${skipReason}`);
    process.exit(1);
    return;
  }
  if (records.length === 0) {
    console.error("gate:baseline: measured 0 runs — nothing was measured.");
    process.exit(1);
    return;
  }
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Re-exported so `--cost-fresh` in run-matrix.ts and tests can read a written
// summary without re-deriving the shape.
export async function loadBaselineSummary(
  filePath: string,
): Promise<ReturnType<typeof buildBaselineSummary>> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as ReturnType<typeof buildBaselineSummary>;
}
