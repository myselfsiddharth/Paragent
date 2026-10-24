#!/bin/zsh
# The exact command behind experiments/gate-v1/results/2026-10-23/, run from a clean checkout of
# main at 648e0a7. Copied from the session's run script; only the .env path was local. The
# run's out/ directory was then copied here unchanged.
set -u
ENVF=.env   # holds VOYAGER_API_KEY; never committed
PROG=artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r3.bundle.json
echo "== PHASE baseline $(date)"
node --env-file=$ENVF --import tsx experiments/gate-v1/fresh-baseline.ts --provider voyager --runs 8 --version 9.5.21 --program $PROG || { echo "== FAILED baseline"; exit 1; }
echo "== PHASE matrix $(date)"
node --env-file=$ENVF --import tsx experiments/gate-v1/run-matrix.ts --versions all --runs 6 --program $PROG \
  --repair-provider voyager --gate-task-goal --cost-fresh experiments/gate-v1/out/fresh-baseline/baseline.json \
  --param "dashboard_title=Paragent Gate {run}" --param "panel_title=Gate Panel" --param series_alias=gate --param series_count=5 \
  || { echo "== FAILED matrix"; exit 1; }
echo "== PHASE report $(date)"
node --env-file=$ENVF --import tsx experiments/gate-v1/report/generate-amortized.ts || { echo "== FAILED report"; exit 1; }
echo "== DONE $(date)"
