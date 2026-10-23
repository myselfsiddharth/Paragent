#!/usr/bin/env node
/**
 * Print every figure a gate-result memo cites, read from the committed run
 * artifacts (#29). The memo is the document most likely to be quoted outside
 * the repo; this makes each of its numbers mechanically checkable instead of
 * trusted.
 *
 *   node scripts/gate-memo-figures.mjs [results-dir]
 *
 * Default results dir: experiments/gate-v1/results/2026-10-23. Reads
 * report/report.json, metrics.ndjson, matrix-run.json and
 * fresh-baseline/baseline.json under it. Prints nothing it did not read.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const dir = process.argv[2] ?? "experiments/gate-v1/results/2026-10-23";
const read = async (p) => readFile(path.join(dir, p), "utf8");
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "no_data");

const report = JSON.parse(await read("report/report.json"));
const matrix = JSON.parse(await read("matrix-run.json"));
const baseline = JSON.parse(await read("fresh-baseline/baseline.json"));
const rows = (await read("metrics.ndjson"))
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const runs = rows.filter((r) => r.metric_kind === "run");
const steps = rows.filter((r) => r.metric_kind === "step");

console.log(`# ${dir}`);
console.log(`\n## §9 sample and coverage (report/report.json)`);
console.log(JSON.stringify({ sample: report.sample, truncation: report.truncation }));
console.log(JSON.stringify({ repair_shape: report.repair_shape, cost_provenance: report.cost_provenance }));

console.log(`\n## §9 metrics (report/report.json .metrics)`);
for (const m of report.metrics) {
  const v = m.value === null ? "no_data" : Number(m.value).toFixed(4);
  console.log(`${m.name} | ${m.status} | ${v} | ${m.numerator} / ${m.denominator}`);
}

console.log(`\n## Run setup (matrix-run.json, run rows)`);
console.log(
  JSON.stringify({
    versions_walked: matrix.versions_walked,
    versions_skipped: matrix.versions_skipped,
    runs_per_version: matrix.runs_per_version,
    runs_completed: matrix.runs_completed,
    program_path: matrix.program_path,
    repair_cap: matrix.repair_cap,
    repair_task_goal: matrix.repair_task_goal,
    cost_fresh_source: matrix.cost_fresh_source,
  }),
);
const models = [...new Set(runs.map((r) => r.cost_repair?.model_id).filter(Boolean))];
console.log(`repair model_id(s) on run rows: ${JSON.stringify(models)}`);

console.log(`\n## Per version (metrics.ndjson run rows)`);
const versions = [...new Set(runs.map((r) => r.testbed_version))];
for (const v of versions) {
  const rs = runs.filter((r) => r.testbed_version === v);
  const ok = rs.filter((r) => r.task_success).length;
  const le2 = rs.filter((r) => r.success_with_le_2_repairs).length;
  const repairs = [...new Set(rs.map((r) => r.repair_count))].join(",");
  console.log(`${v}: runs=${rs.length} task_success=${ok} success_le_2=${le2} repair_count=${repairs}`);
}
console.log(`all: task_success=${runs.filter((r) => r.task_success).length}/${runs.length}`);

console.log(`\n## Non-PASS step outcomes, by version and step (metrics.ndjson step rows)`);
const tally = new Map();
for (const s of steps.filter((s) => s.outcome !== "PASS")) {
  const k = `${s.testbed_version} step ${s.step_index} ${s.outcome}${s.pre_action_count ? ` pre=${s.pre_action_count}` : ""}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
for (const [k, n] of [...tally].sort()) console.log(`${k}: ${n}`);

console.log(`\n## Step validity by assertion strength (metrics.ndjson step rows)`);
for (const strength of ["strong", "weak"]) {
  const ss = steps.filter((s) => s.assertion_strength === strength);
  const valid = ss.filter((s) => s.replay_valid).length;
  console.log(`${strength}: ${valid}/${ss.length} = ${pct(valid, ss.length)}`);
}

console.log(`\n## Fresh baseline (fresh-baseline/baseline.json)`);
console.log(
  JSON.stringify({
    model_id: baseline.model_id,
    testbed_version: baseline.testbed_version,
    runs_attempted: baseline.runs_attempted,
    measured_runs: baseline.measured_runs,
    successes: baseline.successes,
    mean_cost_fresh: baseline.mean_cost_fresh,
  }),
);
for (const r of baseline.runs) {
  console.log(`  success=${r.task_success} turns=${r.turns} unmeasured=${r.unmeasured} ${String(r.notes).slice(0, 70)}`);
}
