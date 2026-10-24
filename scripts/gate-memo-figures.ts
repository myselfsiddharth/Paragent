/**
 * Print, and check, every figure a gate-result memo cites (#29).
 *
 *   node --import tsx scripts/gate-memo-figures.ts [results-dir]
 *
 * Default: experiments/gate-v1/results/2026-10-23. A relative dir is resolved
 * against the current directory first, then the repo root. Reads the run's
 * report/report.json, metrics.ndjson, matrix-run.json, fresh-baseline/
 * baseline.json, and the program bundle matrix-run.json names.
 *
 * It does not just reprint report.json. The §9 metrics are recomputed from the
 * raw metrics.ndjson with the project's own aggregator (`buildGateReport`) and
 * compared with the committed report; the committed fresh baseline is compared
 * with the cost the run actually used. Any mismatch is printed and the script
 * exits 1, so a stale or hand-edited artifact cannot pass for a checked one.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGateReport } from "../src/metrics/aggregate.js";
import { readMetricNdjson } from "../src/metrics/emitter.js";
import type { RunMetric, StepMetric } from "../src/metrics/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2] ?? "experiments/gate-v1/results/2026-10-23";
const dir = path.isAbsolute(arg) || existsSync(arg) ? path.resolve(arg) : path.resolve(ROOT, arg);
const at = (p: string) => path.join(dir, p);
const json = async <T>(p: string): Promise<T> => JSON.parse(await readFile(p, "utf8")) as T;
const pct = (n: number, d: number) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "no_data");

const problems: string[] = [];
const same = (label: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(`${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
};

interface Metric { name: string; status: string; value: number | null; numerator: number; denominator: number }
interface Report {
  sample: unknown;
  truncation: unknown;
  repair_shape: unknown;
  cost_provenance: unknown;
  metrics: Metric[];
}
interface Cost { tokens_in: number; tokens_out: number; wall_clock_ms: number; model_id?: string }

const report = await json<Report>(at("report/report.json"));
const matrix = await json<Record<string, unknown> & { program_path: string; cost_fresh?: Cost }>(at("matrix-run.json"));
const baseline = await json<{
  model_id: string;
  testbed_version: string;
  runs_attempted: number;
  measured_runs: number;
  successes: number;
  mean_cost_fresh: Cost;
  runs: Array<{ task_success: boolean; turns: number; unmeasured: boolean; tokens_in: number; wall_clock_ms: number; notes: string }>;
}>(at("fresh-baseline/baseline.json"));
const rows = await readMetricNdjson(at("metrics.ndjson"));
const runs = rows.filter((r): r is RunMetric => r.metric_kind === "run");
const steps = rows.filter((r): r is StepMetric => r.metric_kind === "step");

console.log(`# ${path.relative(ROOT, dir)}`);

// --- §9 metrics, recomputed and compared ---------------------------------
const recomputed = buildGateReport(rows);
same("sample", recomputed.sample, report.sample);
same("truncation", recomputed.truncation, report.truncation);
same("repair_shape", recomputed.repair_shape, report.repair_shape);
for (const m of report.metrics) {
  const r = recomputed.metrics.find((x) => x.name === m.name);
  if (!r) {
    problems.push(`metric missing on recompute: ${m.name}`);
    continue;
  }
  same(`${m.name} value`, r.value, m.value);
  same(`${m.name} numerator`, r.numerator, m.numerator);
  same(`${m.name} denominator`, r.denominator, m.denominator);
}

console.log("\n## §9 sample and coverage (recomputed from metrics.ndjson = report.json)");
console.log(JSON.stringify({ sample: report.sample, truncation: report.truncation }));
console.log(JSON.stringify({ repair_shape: report.repair_shape, cost_provenance: report.cost_provenance }));
console.log("\n## §9 metrics");
for (const m of report.metrics) {
  const v = m.value == null ? "no_data" : Number(m.value).toFixed(4);
  console.log(`${m.name} | ${m.status} | ${v} | ${m.numerator} / ${m.denominator}`);
}

// --- fresh baseline: is the committed copy the one the run used? ----------
const mean = baseline.mean_cost_fresh;
if (matrix.cost_fresh) same("matrix cost_fresh vs committed baseline", matrix.cost_fresh, mean);
const tokens = report.metrics.find((m) => m.name.startsWith("repair cost vs fresh (tokens"));
const wall = report.metrics.find((m) => m.name.startsWith("repair cost vs fresh (wall"));
if (tokens) same("tokens denominator vs baseline mean", tokens.denominator, mean.tokens_in + mean.tokens_out);
if (wall) same("wall-clock denominator vs baseline mean", wall.denominator, mean.wall_clock_ms);

// --- run setup ------------------------------------------------------------
console.log("\n## Run setup (matrix-run.json, run rows, program bundle)");
console.log(
  JSON.stringify({
    versions_walked: matrix["versions_walked"],
    versions_skipped: matrix["versions_skipped"],
    runs_per_version: matrix["runs_per_version"],
    runs_completed: matrix["runs_completed"],
    program_path: matrix.program_path,
    repair_cap: matrix["repair_cap"],
    repair_task_goal: matrix["repair_task_goal"],
  }),
);
const uniq = <T>(xs: T[]) => [...new Set(xs.map((x) => JSON.stringify(x)))];
// Model and context level are only on rows where a repair ran.
const repaired = runs.filter((r) => r.repair_count > 0);
console.log(
  `run rows: repair model_id=${uniq(repaired.map((r) => r.cost_repair.model_id))} ` +
    `context_level=${uniq(repaired.map((r) => r.repair_context_level))} ` +
    `budget_ms=${uniq(runs.map((r) => r.wall_clock_budget_ms))} steps_total=${uniq(runs.map((r) => r.steps_total))}`,
);
const bundle = await json<{ rows: Array<{ assertion: { strength: string } }> }>(path.resolve(ROOT, matrix.program_path));
const strengths = bundle.rows.map((r) => r.assertion.strength);
console.log(`program checks: strong=${strengths.filter((s) => s === "strong").length} weak=${strengths.filter((s) => s === "weak").length}`);

// --- per version ----------------------------------------------------------
console.log("\n## Per version (run rows)");
for (const v of [...new Set(runs.map((r) => r.testbed_version))]) {
  const rs = runs.filter((r) => r.testbed_version === v);
  console.log(
    `${v}: runs=${rs.length} task_success=${rs.filter((r) => r.task_success).length} ` +
      `success_le_2=${rs.filter((r) => r.success_with_le_2_repairs).length} repair_count=${[...new Set(rs.map((r) => r.repair_count))].join(",")}`,
  );
}
console.log(`all: task_success=${runs.filter((r) => r.task_success).length}/${runs.length}`);

console.log("\n## Non-PASS step outcomes, by version and step (step rows)");
const tally = new Map<string, number>();
for (const s of steps.filter((x) => x.outcome !== "PASS")) {
  const k = `${s.testbed_version} step ${s.step_index} ${s.outcome}${s.pre_action_count ? ` pre=${s.pre_action_count}` : ""}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
for (const [k, n] of [...tally].sort()) console.log(`${k}: ${n}`);

console.log("\n## Step validity by assertion strength (step rows)");
for (const strength of ["strong", "weak"]) {
  const ss = steps.filter((s) => s.assertion_strength === strength);
  const valid = ss.filter((s) => s.replay_valid).length;
  console.log(`${strength}: ${valid}/${ss.length} = ${pct(valid, ss.length)}`);
}

console.log("\n## Fresh baseline (fresh-baseline/baseline.json)");
console.log(JSON.stringify({ model_id: baseline.model_id, testbed_version: baseline.testbed_version, runs_attempted: baseline.runs_attempted, measured_runs: baseline.measured_runs, successes: baseline.successes, mean_cost_fresh: mean }));
for (const r of baseline.runs) {
  console.log(`  success=${r.task_success} turns=${r.turns} unmeasured=${r.unmeasured} tokens_in=${r.tokens_in} wall_ms=${r.wall_clock_ms} ${String(r.notes).slice(0, 60)}`);
}

if (problems.length > 0) {
  console.error(`\nMISMATCH (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("\nchecks: recomputed §9 metrics match report.json; committed fresh baseline matches the run's cost_fresh");
