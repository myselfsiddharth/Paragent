#!/usr/bin/env node
/**
 * Gate-v1 version matrix driver.
 *
 * The version list is `scripts/testbed/matrix.json` — the ADR-0003 pins — read
 * through `src/testbed/matrix.ts`. There is no second list. `versions.json`
 * used to hold a one-element placeholder (`pending-b1@placeholder`), so every
 * report generated from this harness was a report about nothing; it was deleted
 * rather than kept in sync (issue #26).
 *
 * Two modes, and the NDJSON must always say which one produced a row:
 *
 * - `--dry-run` walks the matrix with no Docker and no browser, emitting
 *   zero-token rows whose outcomes are hard-coded. It exercises the harness,
 *   and the CI job depends on it. **It is not a measurement**, and every row it
 *   writes carries `DRY_RUN_NOTE`.
 * - The default is now a **live** run (issue #62 removed the exit-2 guard): one
 *   seeded container per version, a real browser, real step outcomes.
 *
 * Mixing the two in one report would be the easiest way to publish a fabricated
 * gate number, so `mode` is recorded in `out/matrix-run.json` and the dry-run
 * note stays attached to the rows themselves.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetricsEmitter, readMetricNdjson } from "../../src/metrics/emitter.js";
import { ReplayRunner } from "../../src/runner/replay.js";
import type { RepairModelClient } from "../../src/runner/repair.js";
import { AnthropicRepairModelClient } from "../../src/runner/repair-anthropic.js";
import { DEFAULT_VOYAGER_MODEL, VoyagerRepairModelClient } from "../../src/runner/repair-voyager.js";
import { loadDotEnv } from "./load-env.js";
import { bundleToProgram, isCompiledBundle, rowsToProgram } from "../../src/runner/program.js";
import { JsonlCacheStore } from "../../src/cache/store.js";
import { resolveProgram } from "../../src/cache/resolve.js";
import { requiredParams } from "../../src/runner/params.js";
import type {
  CompiledProgram,
  ParamBindings,
  RunResult,
} from "../../src/runner/types.js";
import type { Cost, MetricRow, ProgramSource, StepOutcome } from "../../src/metrics/types.js";
import {
  SECTION9_MIN_RUNS,
  SECTION9_MIN_STEP_EXECUTIONS,
  section9SampleFloor,
} from "../../src/metrics/aggregate.js";
import { dockerAvailable } from "../../src/testbed/docker.js";
import {
  isUnavailable,
  listVersions,
  loadMatrix,
  type MatrixVersion,
} from "../../src/testbed/matrix.js";
import { DEFAULT_HOST_PORT } from "../../src/testbed/constants.js";
import type { SeedFingerprint } from "../../src/testbed/verify.js";
import {
  DEFAULT_RUNS_PER_VERSION,
  runsToClearSection9,
  runVersionLive,
  type VersionSkip,
} from "./live-run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");
const DEFAULT_PROGRAM = path.join(__dirname, "fixtures/compiled-program.json");

const DRY_RUN_NOTE = "dry-run — tokens remain 0; not a gate measurement";

/**
 * Names the driver binds itself, per version. Values come from the container
 * that is about to be booted, so only the names are known this early — which is
 * all the pre-flight needs.
 */
export const DRIVER_BOUND_PARAMS = ["base_url", "host", "port"] as const;

/**
 * Bindings the dry-run path supplies.
 *
 * Hoisted out of `runDryVersion` so the pre-flight check below and the run
 * itself cannot disagree about what will be bound — a pre-flight that passes
 * and a run that then refuses would be worse than no pre-flight.
 *
 * It covers `DRIVER_BOUND_PARAMS` with obvious placeholders, alongside the
 * `file://local-demo` one that was already here. A dry run interpolates
 * nothing — every outcome is hard-coded — so these are inert labels, not
 * measurements, and every row a dry run writes carries `DRY_RUN_NOTE`. Binding
 * them here is what makes `--dry-run` a faithful pre-flight for the live path:
 * it then asks the caller for exactly the params a live run would, no more.
 */
export const DRY_RUN_PARAMS: ParamBindings = {
  base_url: "file://local-demo",
  host: "local-demo",
  port: 0,
  resource_label: "widget",
};

export interface Args {
  dryRun: boolean;
  help: boolean;
  headed: boolean;
  keepUp: boolean;
  preamble: boolean;
  /** Raw --versions value; `undefined` means "not passed" (defaults to all). */
  versions?: string;
  program?: string;
  port?: number;
  /**
   * Extra `param_refs` bindings for the program under test. Programs declare
   * their own holes, so the driver cannot know them: the local-demo fixture
   * wants `resource_label`, the example login bundle wants `username`. Binding
   * is the caller's job — inventing a default here would silently substitute a
   * value the recording never used.
   */
  params: Record<string, string>;
  /** Repeats per version. See DEFAULT_RUNS_PER_VERSION for why the default is 3. */
  runs: number;
  /**
   * Resolve the program from a cache directory instead of a file (#118).
   *
   * Requires `--site-key` and `--task-key`: a cache is keyed by them, and
   * taking them from a bundle would mean loading the file this flag exists to
   * avoid consulting.
   */
  fromCache?: string;
  siteKey?: string;
  taskKey?: string;
  /** Read only pool-eligible rows — the cross-tenant case (ADR-0014). */
  poolOnly: boolean;
  /**
   * Opt-in real repair model (#27). Unset means the stub: no network call, no
   * spend. Passing it requires ANTHROPIC_API_KEY, and the client throws at
   * construction if it is missing rather than silently reporting a self-heal
   * rate of 0 that looks measured.
   */
  repairModel?: string;
  /**
   * Which provider backs the real repair client. Unset means `anthropic` when
   * `--repair-model` is given; passing this alone (`voyager`) also opts in, using
   * that provider's default model. The stub is still the default when neither
   * flag is present.
   */
  repairProvider?: RepairProvider;
  /**
   * Path to a measured fresh-baseline summary (#39), written by
   * `npm run gate:baseline` as `out/fresh-baseline/baseline.json`. When set,
   * its `mean_cost_fresh` is broadcast onto every **live** run row's
   * `cost_fresh` field, which is what moves `repairCostVsFresh()` off
   * `no_data`. Ignored under `--dry-run`, whose rows must stay all-zero.
   * Absent means the pre-#39 default: `zeroCost()`, unchanged.
   */
  costFresh?: string;
  /**
   * Path to a measured **one-time** program-build cost (#39 step 4, ADR-0010).
   * Attached to exactly ONE run row in the whole matrix as
   * `cost_program_build` + `program_build_id`, which is what moves
   * `amortizedTokensOverN()` — the PRD §12 demo curve — off `no_data`.
   *
   * Not the same quantity as `--cost-fresh` and not interchangeable with it:
   * `cost_fresh` is a per-run comparison baseline that belongs on every row,
   * this is a capital cost that belongs on one. ADR-0010 exists because they
   * were one field.
   */
  costProgramBuild?: string;
}

/**
 * Every value-taking flag, and the one place each is assigned (#165).
 *
 * This used to be two lists that had to agree and did not: a `valued` set here
 * in the parser, and an `else if` chain in `assignValue`. The parser consumed a
 * flag's value, handed it over, and the chain fell off its end without matching
 * — so `--from-cache`, `--site-key`, `--task-key` and `--repair-model` were
 * accepted, documented in `usage()`, and **silently dropped**. `--repair-model`
 * was the dangerous one: a run asking for the real repair client got
 * `StubRepairModelClient`, which returns a null action and zero tokens, so the
 * run reported a self-heal rate of 0 and a `cost_repair` of zero that both look
 * like measurements. `AnthropicRepairModelClient` throws at construction rather
 * than degrade to a no-op for exactly this reason; the CLI in front of it
 * degraded anyway and never reached that constructor.
 *
 * One table closes the class rather than the four instances. A flag exists here
 * or it does not exist at all: the parser derives its accepted set from these
 * keys, so an entry cannot be accepted-but-unassigned, and an assigner cannot be
 * unreachable. `tests/unit/gate-matrix.test.ts` walks the table and asserts each
 * key lands in `Args`.
 */
export type RepairProvider = "anthropic" | "voyager";
const REPAIR_PROVIDERS: readonly RepairProvider[] = ["anthropic", "voyager"];

const VALUED_FLAGS = {
  versions: (args, value) => {
    args.versions = value;
  },
  program: (args, value) => {
    args.program = value;
  },
  param: (args, value) => {
    const eq = value.indexOf("=");
    if (eq <= 0) throw new Error(`--param expects key=value, got: ${value}`);
    args.params[value.slice(0, eq)] = value.slice(eq + 1);
  },
  runs: (args, value) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) throw new Error(`--runs must be >= 1, got: ${value}`);
    args.runs = n;
  },
  port: (args, value) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --port: ${value}`);
    args.port = n;
  },
  "from-cache": (args, value) => {
    args.fromCache = value;
  },
  "site-key": (args, value) => {
    args.siteKey = value;
  },
  "task-key": (args, value) => {
    args.taskKey = value;
  },
  "repair-model": (args, value) => {
    args.repairModel = value;
  },
  "repair-provider": (args, value) => {
    if (!(REPAIR_PROVIDERS as readonly string[]).includes(value)) {
      throw new Error(`--repair-provider must be one of ${REPAIR_PROVIDERS.join(", ")}, got: ${value}`);
    }
    args.repairProvider = value as RepairProvider;
  },
  "cost-fresh": (args, value) => {
    args.costFresh = value;
  },
  "cost-program-build": (args, value) => {
    args.costProgramBuild = value;
  },
} satisfies Record<string, (args: Args, value: string) => void>;

/** Flag names without the leading `--`, in declaration order. */
export const VALUED_FLAG_NAMES = Object.keys(VALUED_FLAGS) as (keyof typeof VALUED_FLAGS)[];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    help: false,
    headed: false,
    keepUp: false,
    preamble: true,
    params: {},
    runs: DEFAULT_RUNS_PER_VERSION,
    poolOnly: false,
  };
  const valued = new Set(VALUED_FLAG_NAMES.map((name) => `--${name}`));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--pool-only") args.poolOnly = true;
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

export function assignValue(args: Args, key: string, value: string): void {
  const assign = Object.prototype.hasOwnProperty.call(VALUED_FLAGS, key)
    ? VALUED_FLAGS[key as keyof typeof VALUED_FLAGS]
    : undefined;
  // Throwing rather than returning matches the parser's own posture two lines
  // up — it throws on `unknown argument`. A flag the parser accepted and nobody
  // consumed is the same caller error one layer in, and silence there is what
  // made #165 invisible for four flags.
  if (!assign) throw new Error(`unhandled valued flag: --${key}`);
  assign(args, value);
}

function usage(): void {
  console.log(`Usage: npm run gate:matrix -- [--dry-run] [options]

  --dry-run          No Docker, no browser. Zero-token rows, hard-coded
                     outcomes, labelled "not a gate measurement".
  --versions <list>  Comma-separated matrix ids, or "all" (default).
                     Unknown ids are rejected — never silently skipped.
  --program <path>   Compiled program or compiled_trajectory bundle to replay.
                     Default: experiments/gate-v1/fixtures/compiled-program.json
  --port <n>         Host port for the test-bed (default ${DEFAULT_HOST_PORT}).
  --param k=v        Bind one of the program's own param_refs. Repeatable.
                     base_url/host/port are bound by the driver; anything else
                     the program declares is the caller's to supply. Checked
                     before anything boots: a program with an unbound parameter
                     is refused by name rather than failing mid-run as churn.
  --runs <n>         Repeats per version (default ${DEFAULT_RUNS_PER_VERSION}). One run per
                     version cannot separate churn from flakiness. PRD §9 wants
                     >=42 runs and >=400 step-executions across the matrix; the
                     report states the shortfall rather than hiding it.
  --from-cache <dir> Resolve the program from the cache in <dir> instead of a
                     file (#118). Needs --site-key and --task-key. Refuses the
                     run — without counting it — when no COMPLETE program
                     resolves, because a truncated program is never replayed.
  --site-key <k>     Cache lookup key. Only meaningful with --from-cache.
  --task-key <k>     Cache lookup key. Only meaningful with --from-cache.
  --pool-only        Resolve from pool-eligible rows only: the cross-tenant
                     case, where a tenant-scoped row must be invisible.
  --repair-model <m> Use a REAL repair model instead of the stub (#27).
                     Costs money and needs ANTHROPIC_API_KEY (or VOYAGER_API_KEY
                     with --repair-provider voyager). Omitted means the stub:
                     no network call, no spend, self-heal structurally 0.
  --repair-provider <p>
                     anthropic (default) | voyager. voyager uses ASU's
                     OpenAI-spec gateway (needs VOYAGER_API_KEY; default model
                     ${DEFAULT_VOYAGER_MODEL}) and reports MEASURED tokens. Passing
                     it alone opts in to the real client. The fresh baseline
                     must be measured with the SAME provider and model.
  --cost-fresh <path> Measured fresh-baseline summary (#39), written by
                     "npm run gate:baseline" as out/fresh-baseline/baseline.json.
                     Its mean_cost_fresh is attached to every LIVE run row's
                     cost_fresh, which is what moves "repair cost vs fresh"
                     off no_data. Refuses (exit 2) if the file is missing or
                     not usable=true — a dry-run baseline or a zero-measured
                     one is never wired in silently. Ignored under --dry-run.
  --cost-program-build <path>
                     Measured ONE-TIME cost of producing the compiled program
                     (#39 step 4, ADR-0010). Attached to exactly ONE run row as
                     cost_program_build + program_build_id, which is what moves
                     the §12 amortization curve off no_data. NOT a substitute
                     for --cost-fresh: that is a per-run baseline on every row,
                     this is a capital cost on one. Refuses (exit 2) if the file
                     is missing, not usable=true, has no program_build_id, or
                     measures zero tokens. Ignored under --dry-run.
  --headed           Show the browser (live runs only).
  --keep-up          Leave each container running after its run, for inspection.
  --no-preamble      Skip the login preamble, for programs that log in as part
                     of the measured task.
  --help             Show this help.

Versions come from scripts/testbed/matrix.json (ADR-0003 pins). Versions marked
"status": "unavailable" there are skipped and recorded, never dropped silently.

A live run brings up one seeded container per version, replays the program in a
real browser, and tears the container down in a finally. A version that could
not be brought up is recorded as a **skip with a reason** — never as a failed
run, which would invent a data point that was never measured.

Exits 1 if the run measured zero versions — an empty NDJSON is a missing
denominator, not a successful run.
`);
}

/**
 * Resolve `--versions` against the matrix. Unknown ids are an error naming the
 * valid ids: falling through to a default is how a placeholder run gets
 * mistaken for a measurement.
 */
function selectVersions(
  selection: string | undefined,
  all: MatrixVersion[],
): { selected: MatrixVersion[]; selectionLabel: string | string[] } {
  if (selection === undefined || selection.trim() === "all") {
    return { selected: all, selectionLabel: "all" };
  }

  const requested = selection
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error("--versions was empty (use comma-separated ids, or `all`)");
  }

  const byId = new Map(all.map((v) => [v.id, v]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown version id(s): ${unknown.join(", ")}\n` +
        `valid ids (scripts/testbed/matrix.json): ${all.map((v) => v.id).join(", ")}`,
    );
  }

  // Dedupe while keeping the caller's order.
  const seen = new Set<string>();
  const selected: MatrixVersion[] = [];
  for (const id of requested) {
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(byId.get(id)!);
  }
  return { selected, selectionLabel: selected.map((v) => v.id) };
}

/**
 * Load `--program`, accepting either shape that exists in the tree: a
 * hand-written `CompiledProgram` fixture, or a `compiled_trajectory` bundle
 * from `artifacts/compiled/`. The bundle is the real artifact; the fixture is
 * the harness stand-in that runs without a recording.
 */
export async function loadProgram(file: string): Promise<CompiledProgram> {
  const doc: unknown = JSON.parse(await readFile(file, "utf8"));
  if (isCompiledBundle(doc)) {
    // testbed_version is overridden per version by the driver, so this
    // placeholder never reaches a row.
    return bundleToProgram(doc, "unset");
  }
  const program = doc as CompiledProgram;
  if (!Array.isArray(program.steps)) {
    throw new TypeError(
      `${file} is neither a compiled_trajectory bundle nor a CompiledProgram ` +
        "(no bundle_kind, no steps[])",
    );
  }
  return program;
}

/**
 * Load a fresh-baseline summary (#39) written by `npm run gate:baseline` and
 * return the `Cost` it measured.
 *
 * Refuses rather than degrades, same posture as the cache MISS and unbound-param
 * checks above: a caller who passed `--cost-fresh` asked for a measured value to
 * be wired in, so a missing file, an unparsable one, or one whose `usable` flag
 * is `false` (dry-run, or zero runs measured) is an error naming why — never a
 * silent fall-through to `zeroCost()`, which would look identical to a baseline
 * that was never asked for at all.
 */
export async function loadCostFreshBaseline(filePath: string): Promise<Cost> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `--cost-fresh ${filePath}: ${e.code === "ENOENT" ? "file not found" : errMessage(err)}. ` +
        "Run `npm run gate:baseline` first.",
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`--cost-fresh ${filePath}: not valid JSON`);
  }
  const doc = parsed as {
    usable?: boolean;
    not_a_measurement?: string;
    mean_cost_fresh?: Cost;
  };
  if (doc.usable !== true) {
    throw new Error(
      `--cost-fresh ${filePath}: not usable (${doc.not_a_measurement ?? "measured_runs was 0"}). ` +
        "A dry-run or zero-measured baseline cannot be wired into a gate run — see docs/gate/fresh-baseline.md.",
    );
  }
  if (!doc.mean_cost_fresh) {
    throw new Error(`--cost-fresh ${filePath}: missing mean_cost_fresh`);
  }
  return doc.mean_cost_fresh;
}

/**
 * A measured one-time program-build payment, and the build it paid for.
 *
 * The two travel together because `ReplayRunner` refuses the cost without the
 * id at construction (ADR-0010): an unattributed payment cannot be told apart
 * from a double payment when a recompile shows up as a second step in the
 * curve.
 */
export interface ProgramBuildPayment {
  cost: Cost;
  program_build_id: string;
}

/**
 * Load a measured one-time program-build cost (#39 step 4, ADR-0010).
 *
 * ## Nothing writes this file yet, and that is the point
 *
 * `cost_program_build` is what it cost to *produce* the compiled program. Today
 * that is a developer typing `src/recorder/cli.ts` by hand, which costs a
 * developer-day and zero tokens
 * ([#127](https://github.com/DevToolie/Paragent/issues/127)). So there is no
 * producer for this document in the repo, and this loader will refuse every
 * attempt to fake one.
 *
 * That is deliberate. Until #39 step 4 was wired, the §12 curve PRD calls *the
 * demo* could not be produced by anything in the tree even if a number existed
 * — `ReplayRunner` accepted `costProgramBuild`, `amortizedTokensOverN()`
 * consumed it, and no path in between passed one. This closes that gap so the
 * curve computes the moment a measurement exists, rather than needing a code
 * change at the same time.
 *
 * ## Expected document
 *
 * ```json
 * {
 *   "usable": true,
 *   "program_build_id": "<id>",
 *   "cost_program_build": {
 *     "tokens_in": 0, "tokens_out": 0, "wall_clock_ms": 0, "model_id": "<m>"
 *   }
 * }
 * ```
 *
 * ## Refuses rather than degrades
 *
 * Same posture as `loadCostFreshBaseline`, and one rule beyond it: **a
 * zero-token build cost is rejected.** For `cost_fresh` a zero is caught by
 * `usable`; here it is worth its own check, because a zero build cost does not
 * produce `no_data` — it produces a *curve*, one that declines to nothing and
 * reads as the strongest possible version of the claim. That is the exact
 * failure #123 was filed about, arriving from the other direction.
 */
export async function loadCostProgramBuild(
  filePath: string,
): Promise<ProgramBuildPayment> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `--cost-program-build ${filePath}: ` +
        `${e.code === "ENOENT" ? "file not found" : errMessage(err)}. ` +
        "Nothing in the repo writes this document yet — the compiled program is " +
        "still hand-written (#127), so run 1 costs zero tokens. See " +
        "docs/gate/fresh-baseline.md.",
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`--cost-program-build ${filePath}: not valid JSON`);
  }
  const doc = parsed as {
    usable?: boolean;
    not_a_measurement?: string;
    program_build_id?: string;
    cost_program_build?: Cost;
  };
  if (doc.usable !== true) {
    throw new Error(
      `--cost-program-build ${filePath}: not usable ` +
        `(${doc.not_a_measurement ?? "usable is not true"}). ` +
        "A dry-run or unmeasured build cost cannot be wired into a gate run.",
    );
  }
  const cost = doc.cost_program_build;
  if (!cost) {
    throw new Error(`--cost-program-build ${filePath}: missing cost_program_build`);
  }
  if (typeof doc.program_build_id !== "string" || doc.program_build_id.length === 0) {
    throw new Error(
      `--cost-program-build ${filePath}: missing program_build_id. ` +
        "ADR-0010 requires the id alongside the payment — an unattributed " +
        "payment is indistinguishable from a double payment in the curve.",
    );
  }
  if ((cost.tokens_in ?? 0) + (cost.tokens_out ?? 0) <= 0) {
    throw new Error(
      `--cost-program-build ${filePath}: cost_program_build measures zero tokens. ` +
        "Unlike cost_fresh, a zero here does not report no_data — it plots a " +
        "curve declining to nothing, which publishes the strongest form of the " +
        "claim on a number nobody measured (#123). Omit the flag instead.",
    );
  }
  return { cost, program_build_id: doc.program_build_id };
}

/**
 * Hand out the one-time payment to the first run that asks, and to no other.
 *
 * §12's curve is `(sum(cost_program_build where present + repair + replay)) / N`.
 * Attach the payment to every run and the numerator grows linearly with N, the
 * mean goes flat, and the plot shows nothing — the same arithmetic ADR-0010
 * separated the two fields to prevent, reintroduced at the driver instead of in
 * the schema.
 *
 * Made a latch rather than an index check because the driver has three places a
 * run can start (dry, live, per-version repeats) and "is this the first one?"
 * would have to be right in all of them. Here, correctness is a property of the
 * closure: it can only answer once.
 */
export function programBuildPaymentLatch(
  payment?: ProgramBuildPayment,
): () => ProgramBuildPayment | undefined {
  let remaining = payment;
  return () => {
    const claim = remaining;
    remaining = undefined;
    return claim;
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface WalkOptions {
  walked: MatrixVersion[];
  program: CompiledProgram;
  /** Where `program` came from (#118). Recorded on every row it produces. */
  programSource?: ProgramSource;
  cacheProgramInvalidated?: boolean;
  emitter: MetricsEmitter;
  matrix: ReturnType<typeof loadMatrix>;
  args: Args;
  port: number;
  skipped: VersionSkip[];
  /** Append buffered metric rows to the NDJSON. Called after every run. */
  persist: () => Promise<void>;
  shouldStop: () => boolean;
  /** Measured fresh-baseline (#39), attached to every LIVE run row's cost_fresh. */
  costFresh?: Cost;
  /**
   * Claims the matrix's one-time program-build payment (#39 step 4, ADR-0010).
   * Threaded through rather than resolved here so "exactly one run pays" holds
   * across versions, not just within one.
   */
  claimProgramBuildPayment?: () => ProgramBuildPayment | undefined;
  /**
   * Real repair client (#27), built from `--repair-model`. Absent means the
   * stub — `ReplayRunner`'s default, and what every run got before #165.
   */
  repairClient?: RepairModelClient;
}

/**
 * Walk the selected versions, appending to `skipped` and returning the rows
 * that were actually measured.
 *
 * A crashed version must not abort the matrix, so every attributable failure is
 * already a skip by the time it gets here. Anything that still throws is a
 * harness bug and is left to propagate — laundering it into a skip would hide a
 * broken driver as missing data.
 */
async function walkVersions(
  opts: WalkOptions,
): Promise<{ runs: Array<Record<string, unknown>>; baseline?: { id: string; fingerprint: SeedFingerprint } }> {
  const runs: Array<Record<string, unknown>> = [];
  let baseline: { id: string; fingerprint: SeedFingerprint } | undefined;

  for (const [index, ver] of opts.walked.entries()) {
    console.log(`[${index + 1}/${opts.walked.length}] ${ver.id}`);

    if (opts.args.dryRun) {
      for (let i = 1; i <= opts.args.runs; i++) {
        runs.push(
          await runDryVersion(
            ver,
            opts.program,
            opts.emitter,
            i,
            opts.args.runs,
            opts.args.params,
            opts.programSource,
          ),
        );
      }
      await opts.persist();
      continue;
    }

    const outcome = await runVersionLive({
      version: ver,
      program: opts.program,
      matrixImage: opts.matrix.image,
      baseUrlTemplate: opts.matrix.base_url_template,
      hostPort: opts.port,
      emitter: opts.emitter,
      headed: opts.args.headed,
      keepUp: opts.args.keepUp,
      preamble: opts.args.preamble,
      extraParams: opts.args.params,
      runs: opts.args.runs,
      ...(opts.programSource ? { programSource: opts.programSource } : {}),
      ...(opts.cacheProgramInvalidated !== undefined
        ? { cacheProgramInvalidated: opts.cacheProgramInvalidated }
        : {}),
      // Persist after every run, not at the end. An interrupt during version 6
      // must not discard versions 1-5.
      onRunComplete: async () => {
        await opts.persist();
      },
      shouldStop: opts.shouldStop,
      ...(opts.repairClient ? { repairClient: opts.repairClient } : {}),
      ...(baseline ? { baseline } : {}),
      ...(opts.costFresh ? { costFresh: opts.costFresh } : {}),
      ...(opts.claimProgramBuildPayment
        ? { claimProgramBuildPayment: opts.claimProgramBuildPayment }
        : {}),
    });

    // A skip can now arrive *with* completed runs (interrupted partway, or the
    // login broke on repeat 2). Those runs happened and are kept — discarding
    // them is the easiest way to manufacture a passing gate.
    for (const r of outcome.results) runs.push(ledgerRow(ver.id, r));

    if (outcome.skip) {
      opts.skipped.push(outcome.skip);
      console.log(
        `  ${ver.id}: SKIPPED (${outcome.skip.stage}) — ${outcome.skip.reason}`,
      );
    }

    // The first version that yields a fingerprint becomes the state baseline
    // every later version is checked against.
    if (baseline === undefined && outcome.fingerprint) {
      baseline = { id: ver.id, fingerprint: outcome.fingerprint };
    }

    await opts.persist();
    if (opts.shouldStop?.()) break;
  }

  return baseline ? { runs, baseline } : { runs };
}

/**
 * `matrix-run.json`'s §9 sample-floor block, computed the same way
 * `gate:report`'s `report.json` computes its `sample` field: from the actual
 * persisted NDJSON rows via `section9SampleFloor()`, not from
 * `runs.length * program.steps.length`. That product assumes every run
 * executed every step, which `ReplayRunner.run()` does not guarantee — a run
 * that breaks on a hard failure partway through emits fewer step rows than
 * `program.steps.length`, and the two artifacts must not be able to disagree
 * about the same measurement (#95).
 */
export function buildSection9Floor(
  measuredRows: readonly MetricRow[],
  walkedVersionCount: number,
): {
  min_runs: number;
  min_step_executions: number;
  meets_floor: boolean;
  runs_needed_per_version: number;
} {
  return {
    min_runs: SECTION9_MIN_RUNS,
    min_step_executions: SECTION9_MIN_STEP_EXECUTIONS,
    meets_floor: section9SampleFloor(measuredRows).meets_floor,
    runs_needed_per_version: runsToClearSection9(walkedVersionCount),
  };
}

function ledgerRow(versionId: string, r: RunResult): Record<string, unknown> {
  return {
    version: versionId,
    run_id: r.run_id,
    task_success: r.task_success,
    repair_count: r.repair_count,
    steps_replay_valid: r.steps_replay_valid,
    steps_attempted: r.steps_attempted,
    steps_total: r.steps_total,
    // A run stopped by its own clock is not a run that failed on the site
    // (#84). Recorded here as well as in the NDJSON so the ledger a human reads
    // says which of the two happened.
    ...(r.budget_exhausted
      ? { budget_exhausted: true, wall_clock_budget_ms: r.wall_clock_budget_ms }
      : {}),
    // Both, on purpose. `outcome` is what the NDJSON carries; every genuine
    // failure reads REPAIR_EXHAUSTED there because stub repair always
    // proposes null, which flattens "locator gone" and "assertion false"
    // into one value. `first_pass` is what actually happened.
    outcomes: r.step_results.map((s) => ({
      step: s.step_index,
      outcome: s.outcome,
      ...(s.first_pass_outcome ? { first_pass: s.first_pass_outcome } : {}),
    })),
    wall_clock_total_ms: r.wall_clock_total_ms,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`gate:matrix: ${err instanceof Error ? err.message : err}`);
    usage();
    process.exit(2);
    return;
  }

  if (args.help) {
    usage();
    process.exit(0);
    return;
  }

  const matrix = loadMatrix();
  const all = listVersions(matrix);

  let selected: MatrixVersion[];
  let selectionLabel: string | string[];
  try {
    ({ selected, selectionLabel } = selectVersions(args.versions, all));
  } catch (err) {
    console.error(`gate:matrix: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
    return;
  }

  if (!args.dryRun && !dockerAvailable()) {
    console.error(
      "gate:matrix: live runs need a running Docker daemon. " +
        "Start Docker, or pass --dry-run to exercise the harness without it.",
    );
    process.exit(2);
    return;
  }

  const walked = selected.filter((v) => !isUnavailable(v));
  const skipped: VersionSkip[] = selected.filter(isUnavailable).map((v) => ({
    id: v.id,
    stage: "compose-up" as const,
    reason: v.reason ?? "marked unavailable in scripts/testbed/matrix.json",
  }));

  await mkdir(OUT_DIR, { recursive: true });
  const ndjsonPath = path.join(OUT_DIR, "metrics.ndjson");
  const summaryPath = path.join(OUT_DIR, "matrix-run.json");
  const emitter = new MetricsEmitter(ndjsonPath);

  let program: CompiledProgram;
  let programSource: ProgramSource = "file";
  let cacheProgramInvalidated: boolean | undefined;
  /** What the run summary records as the program's origin. */
  let programOrigin: string;

  if (args.fromCache !== undefined) {
    // The cache read path (#118). Refuses rather than degrades: a MISS exits
    // before any container boots, for the same reason an unbound parameter
    // does (#122). A refused run is not a failed run — it is an absent one,
    // and it contributes to no §9 denominator.
    if (!args.siteKey || !args.taskKey) {
      console.error(
        "gate:matrix: --from-cache needs --site-key and --task-key " +
          "(a cache is keyed by them; reading them from a bundle would mean " +
          "loading the file --from-cache exists to avoid).",
      );
      process.exit(2);
      return;
    }
    const store = new JsonlCacheStore({ dir: args.fromCache });
    const resolution = resolveProgram(
      store,
      { site_key: args.siteKey, task_key: args.taskKey },
      { scope: args.poolOnly ? "pool_only" : "any" },
    );
    if (resolution.status === "miss") {
      console.error(
        `gate:matrix: cache MISS for ${args.siteKey}/${args.taskKey} ` +
          `(${resolution.reason}): ${resolution.detail}\n` +
          "Nothing was run. A partial program is never replayed — see ADR-0013.",
      );
      process.exit(2);
      return;
    }
    program = rowsToProgram(resolution, "unset");
    programSource = "cache";
    programOrigin = `cache:${path.relative(process.cwd(), args.fromCache)}`;
    // Advisory, recorded so a reader can segment hit-rate by cache health. It
    // did not and must not change what gets attempted (ADR-0009, ADR-0014).
    cacheProgramInvalidated = resolution.invalidated;
    console.log(
      `gate:matrix: cache HIT ${resolution.program_id} ` +
        `(${resolution.steps_total} steps` +
        `${resolution.invalidated ? `, ${resolution.invalidated_step_indices.length} invalidated` : ""})`,
    );
  } else {
    const programPath = args.program ?? DEFAULT_PROGRAM;
    programOrigin = path.relative(process.cwd(), programPath);
    try {
      program = await loadProgram(programPath);
    } catch (err) {
      console.error(`gate:matrix: ${err instanceof Error ? err.message : err}`);
      process.exit(2);
      return;
    }
  }

  // Pre-flight the bindings before anything expensive: no container boot, no
  // browser, no truncated NDJSON. `run()` would refuse anyway, but it would do
  // so after the first container is up and per version — and a caller staring
  // at a torn-down matrix has to work out that the driver, not the site, was
  // the problem (#122). Names only; no value is printed.
  const willBind = new Set<string>([
    ...DRIVER_BOUND_PARAMS,
    ...Object.keys(args.params),
    ...(args.dryRun ? Object.keys(DRY_RUN_PARAMS) : []),
  ]);
  const unbound = requiredParams(program).filter((name) => !willBind.has(name));
  if (unbound.length > 0) {
    console.error(
      `gate:matrix: ${program.program_id} needs parameter(s) nothing binds: ` +
        `${unbound.join(", ")}.\n` +
        `  Pass ${unbound.map((n) => `--param ${n}=<value>`).join(" ")}\n` +
        "  Refusing to start: an unbound parameter fails as PAGE_ERROR or " +
        "ASSERTION_FAILED, which is indistinguishable from site churn in the " +
        "§9 aggregates.",
    );
    process.exit(2);
    return;
  }

  // #39: a measured fresh-baseline, broadcast onto every LIVE run row's
  // cost_fresh. Loaded (and validated) before anything boots, same posture as
  // the unbound-param check above — a caller who asked for this explicitly
  // gets a named refusal, not a silent zeroCost() that looks identical to
  // never having asked.
  let costFresh: Cost | undefined;
  if (args.costFresh !== undefined) {
    if (args.dryRun) {
      console.log(
        `  note: --cost-fresh is ignored under --dry-run — dry-run rows stay all-zero.`,
      );
    } else {
      try {
        costFresh = await loadCostFreshBaseline(args.costFresh);
        console.log(
          `  cost-fresh: ${args.costFresh} — tokens_in=${costFresh.tokens_in} ` +
            `tokens_out=${costFresh.tokens_out} wall_clock_ms=${costFresh.wall_clock_ms}` +
            `${costFresh.model_id ? ` model_id=${costFresh.model_id}` : ""}`,
        );
      } catch (err) {
        console.error(`gate:matrix: ${errMessage(err)}`);
        process.exit(2);
        return;
      }
    }
  }

  // #39 step 4, second half: the ONE-TIME program-build payment. Loaded beside
  // --cost-fresh and validated the same way, but attached to exactly one run
  // rather than broadcast — ADR-0010 splits the two because summing a per-run
  // baseline over N flattens the §12 curve.
  let programBuildPayment: ProgramBuildPayment | undefined;
  if (args.costProgramBuild !== undefined) {
    if (args.dryRun) {
      console.log(
        `  note: --cost-program-build is ignored under --dry-run — dry-run rows stay all-zero.`,
      );
    } else {
      try {
        programBuildPayment = await loadCostProgramBuild(args.costProgramBuild);
        const c = programBuildPayment.cost;
        console.log(
          `  cost-program-build: ${args.costProgramBuild} — ` +
            `build=${programBuildPayment.program_build_id} tokens_in=${c.tokens_in} ` +
            `tokens_out=${c.tokens_out} wall_clock_ms=${c.wall_clock_ms}` +
            `${c.model_id ? ` model_id=${c.model_id}` : ""}`,
        );
        console.log(
          "  (attached to the FIRST completed live run only — §12 amortizes one payment)",
        );
      } catch (err) {
        console.error(`gate:matrix: ${errMessage(err)}`);
        process.exit(2);
        return;
      }
    }
  }
  const claimProgramBuildPayment = programBuildPaymentLatch(programBuildPayment);

  // #165: `--repair-model` reached `Args` and stopped there — nothing built a
  // client from it, so `ReplayRunner` fell back to `StubRepairModelClient` and
  // the run reported a self-heal rate of 0 and zero repair cost that both look
  // measured. Assigning the flag was only half the bug; this is the half that
  // makes the flag mean what `usage()` says it means.
  //
  // Constructed here, before anything boots, for the same reason --cost-fresh
  // is loaded here: the client throws when ANTHROPIC_API_KEY is unset rather
  // than degrading to a no-op, and a caller who asked for a real model should
  // learn that from a named refusal on line one, not after the first container
  // is up.
  let repairClient: RepairModelClient | undefined;
  let repairModelId: string | undefined;
  if (args.repairModel !== undefined || args.repairProvider !== undefined) {
    if (args.dryRun) {
      // A dry run hard-codes every outcome, so no step ever fails and the
      // repair loop is never entered. Silently accepting the flag would let a
      // caller believe they had priced a real repair.
      console.error(
        "gate:matrix: --repair-model / --repair-provider are meaningless under " +
          "--dry-run — no step fails, so the repair loop never runs and no token " +
          "is ever spent. Drop one of the two flags.",
      );
      process.exit(2);
      return;
    }
    try {
      const provider: RepairProvider = args.repairProvider ?? "anthropic";
      if (provider === "voyager") {
        const client = new VoyagerRepairModelClient({
          ...(args.repairModel !== undefined ? { model: args.repairModel } : {}),
        });
        repairClient = client;
        repairModelId = client.model;
      } else {
        // `--repair-model` is guaranteed here: provider defaults to anthropic
        // only when it was not given, and the guard above needs one of the two.
        repairClient = new AnthropicRepairModelClient({ model: args.repairModel! });
        repairModelId = args.repairModel!;
      }
      console.log(
        `  repair-model: ${repairModelId} via ${provider} (REAL client — this run spends tokens)`,
      );
    } catch (err) {
      console.error(`gate:matrix: ${errMessage(err)}`);
      process.exit(2);
      return;
    }
    // §9 compares cost_repair to cost_fresh. A baseline measured on another
    // model makes that ratio about model choice, not about repair. Loud rather
    // than fatal: it is a judgement call for a human (an exploratory run on a
    // cheaper model is legitimate), but it must never go unseen.
    if (costFresh?.model_id !== undefined && repairModelId !== undefined && costFresh.model_id !== repairModelId) {
      console.error(
        `gate:matrix: WARNING — repair model (${repairModelId}) differs from the ` +
          `fresh baseline's model (${costFresh.model_id}). The §9 ratio will compare two ` +
          "different reasoning systems; do not cite it as a gate number.",
      );
    }
  }

  const mode = args.dryRun ? "dry-run" : "live";
  const plannedRuns = walked.length * args.runs;
  const plannedSteps = plannedRuns * program.steps.length;
  console.log(
    `gate:matrix ${mode} — ${matrix.target} matrix, ` +
      `${walked.length} version(s) × ${args.runs} run(s) = ${plannedRuns} run(s), ` +
      `program=${program.program_id} (${program.steps.length} step(s))`,
  );
  // Say up front whether this run can carry a §9 claim. Discovering it in the
  // report after 45 minutes of container boots is too late to be useful.
  if (plannedRuns < 42 || plannedSteps < 400) {
    const need = runsToClearSection9(walked.length);
    console.log(
      `  note: ${plannedRuns} runs / ${plannedSteps} step-executions is below the ` +
        `PRD §9 floor (>=42 / >=400). Use --runs ${need} over ${walked.length} ` +
        "version(s) to clear it. The report records the shortfall either way.",
    );
  }
  for (const s of skipped) {
    console.log(`  skipped ${s.id}: ${s.reason}`);
  }

  // Truncate once, then append per run. `flush()` overwrites, so using it at the
  // end means an interrupt loses every row the matrix produced; appending as we
  // go is what makes a partial NDJSON valid and complete-as-far-as-it-got.
  await writeFile(ndjsonPath, "", "utf8");
  const persist = async (): Promise<void> => {
    await emitter.appendFlush();
  };

  // Cooperative, checked between runs. Killing mid-run would leave a half-emitted
  // run and an orphaned container; the second Ctrl-C is the escape hatch.
  let stopRequested = false;
  const onSignal = (): void => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log(
      "\ngate:matrix: interrupt received — finishing the current run, then " +
        "tearing down. Press Ctrl-C again to abort immediately (may orphan a container).",
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const port = args.port ?? DEFAULT_HOST_PORT;
  // Claiming after the walk answers "did a run take it?": the latch is empty
  // iff some run already claimed it. Consuming it here is safe — the matrix is
  // over — and it is the only way to know without threading a flag back up.
  const buildPaymentClaimedByRun = (): boolean =>
    programBuildPayment !== undefined && claimProgramBuildPayment() === undefined;

  const { runs, baseline } = await walkVersions({
    walked,
    program,
    ...(programSource === "cache" ? { programSource } : {}),
    ...(cacheProgramInvalidated !== undefined ? { cacheProgramInvalidated } : {}),
    emitter,
    matrix,
    args,
    port,
    skipped,
    persist,
    shouldStop: () => stopRequested,
    ...(costFresh ? { costFresh } : {}),
    ...(programBuildPayment ? { claimProgramBuildPayment } : {}),
    ...(repairClient ? { repairClient } : {}),
  });

  await persist();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  // Read back what was actually persisted rather than trusting the in-memory
  // run count: matrix-run.json's §9 floor must agree with report.json's,
  // which is built from these same rows (#95).
  const measuredRows = await readMetricNdjson(ndjsonPath);

  // The skip ledger. Without it a later report cannot tell "8 versions, 3 of
  // them unavailable" from "5 versions" — the denominator silently shrinks.
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        schema_version: "1.0.0",
        kind: "gate_matrix_run",
        generated_at: new Date().toISOString(),
        mode,
        dry_run: args.dryRun,
        ...(args.dryRun ? { not_a_measurement: DRY_RUN_NOTE } : {}),
        matrix_source: "scripts/testbed/matrix.json",
        matrix_target: matrix.target,
        selection: selectionLabel,
        runs_per_version: args.runs,
        interrupted: stopRequested,
        // Planned vs actual, both. A reader comparing them can see at a glance
        // whether the matrix finished or was cut short, without inferring it
        // from array lengths.
        runs_planned: plannedRuns,
        runs_completed: runs.length,
        section9_floor: buildSection9Floor(measuredRows, walked.length),
        versions_in_matrix: all.length,
        versions_walked: [...new Set(runs.map((r) => r["version"]))],
        versions_skipped: skipped,
        program_id: program.program_id,
        program_path: programOrigin,
        program_source: programSource,
        ...(baseline ? { state_baseline_version: baseline.id } : {}),
        // #39: which measured fresh-baseline (if any) run rows' cost_fresh
        // came from. Absent means the pre-#39 default, zeroCost() — a reader
        // must not have to diff run rows against a source file to tell the
        // two apart.
        ...(costFresh ? { cost_fresh_source: args.costFresh, cost_fresh: costFresh } : {}),
        // #39 step 4: the one-time payment, and — separately — whether a run
        // actually took it. A matrix that skipped every version leaves the
        // payment unclaimed, and a reader must be able to tell "the curve has
        // no first point" from "the flag was never passed" without diffing
        // NDJSON rows against this file.
        ...(programBuildPayment
          ? {
              cost_program_build_source: args.costProgramBuild,
              cost_program_build: programBuildPayment.cost,
              program_build_id: programBuildPayment.program_build_id,
              program_build_paid: buildPaymentClaimedByRun(),
            }
          : {}),
        runs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`wrote ${ndjsonPath}`);
  console.log(`wrote ${summaryPath}`);

  if (runs.length === 0) {
    console.error(
      "gate:matrix: measured 0 versions — nothing was measured. " +
        `${skipped.length} of ${selected.length} selected version(s) were skipped.`,
    );
    process.exit(1);
    return;
  }
}

/**
 * Dry-run path, unchanged in substance: hard-coded PASS outcomes and zero
 * tokens. Kept because it exercises the harness without Docker and the CI job
 * depends on it — and kept labelled, so its rows can never be read as a
 * measurement.
 */
async function runDryVersion(
  ver: MatrixVersion,
  program: CompiledProgram,
  emitter: MetricsEmitter,
  runIndex: number,
  totalRuns: number,
  extraParams: Record<string, string> = {},
  programSource?: ProgramSource,
): Promise<Record<string, unknown>> {
  // Only testbed_version varies. site_key/task_key stay whatever the compiled
  // program actually is — relabelling a local-demo program as a Grafana one
  // per version would make the row claim a run that never happened.
  const runProgram: CompiledProgram = { ...program, testbed_version: ver.id };
  const dryOutcomes: StepOutcome[] = runProgram.steps.map(() => "PASS");
  const runner = new ReplayRunner({
    dryRun: true,
    dryRunOutcomes: dryOutcomes,
    metrics: emitter,
    maxRepairsPerRun: 2,
    ...(programSource ? { programSource } : {}),
  });

  // `--param` is honoured here too, with the driver's own bindings winning —
  // the same precedence the live path uses. A dry run interpolates nothing, so
  // the values are inert; what matters is that `--dry-run` asks for exactly the
  // params a live run would, which is what makes it a usable pre-flight (#122).
  const result = await runner.run(runProgram, { ...extraParams, ...DRY_RUN_PARAMS });

  const row = {
    version: ver.id,
    run: `${runIndex}/${totalRuns}`,
    run_id: result.run_id,
    task_success: result.task_success,
    repair_count: result.repair_count,
    steps_replay_valid: result.steps_replay_valid,
    steps_total: result.steps_total,
    note: DRY_RUN_NOTE,
  };
  console.log(`  ${JSON.stringify(row)}`);
  return row;
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
