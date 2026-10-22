#!/usr/bin/env node
/**
 * Apply branch protection to main. Idempotent — safe to re-run.
 *
 * Usage: npm run protect:main [-- --repo OWNER/NAME] [-- --dry-run]
 *
 * Requires the `gh` CLI, authenticated with admin on the repo. GitHub only
 * exposes the protection API on public repos or paid plans, so on a private repo
 * under a free org this exits with an explanation rather than a stack trace.
 *
 * Rules: linear history, no force-push or deletion, conversations resolved, and
 * CI green. enforce_admins stays off so the sole maintainer can break glass.
 *
 * Deliberately no pull-request review requirement. Paragent is a personal
 * project with one collaborator, and GitHub does not let anyone approve their
 * own PR — so any non-zero approval count is unsatisfiable here, not strict. It
 * blocked every PR rather than gating it. CI is the real gate: the three
 * required checks below plus `strict` (branch up to date) still hold, and they
 * are what actually ran on the PRs this rule used to stall.
 */
import { execFileSync } from "node:child_process";

const DEFAULT_REPO = "myselfsiddharth/Paragent";
const BRANCH = "main";

/**
 * Status checks that must pass before merge. Every entry has to be a check that
 * actually runs on every PR — a check that gets skipped never reports, and the
 * PR would wait on it forever. CodeQL and dependency review are deliberately
 * absent: both no-op while the repo is private.
 */
const REQUIRED_CHECKS = [
  "lint-typecheck-test-secrets",
  "privacy-canary",
  "conventional-commit title",
];

const protection = {
  required_status_checks: {
    strict: true,
    contexts: REQUIRED_CHECKS,
  },
  enforce_admins: false,
  required_pull_request_reviews: null,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: true,
};

function parseArgs(argv) {
  const args = { repo: DEFAULT_REPO, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") {
      args.repo = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

function gh(args, { allowFailure = false, input } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", input });
  } catch (error) {
    if (allowFailure) {
      return { failed: true, stderr: error.stderr ?? "", stdout: error.stdout ?? "" };
    }
    console.error(error.stderr?.trim() || error.message);
    process.exit(1);
  }
}

function main() {
  const { repo, dryRun } = parseArgs(process.argv.slice(2));

  const meta = JSON.parse(gh(["api", `repos/${repo}`]));
  console.log(`repo: ${repo} (${meta.private ? "private" : "public"})`);

  if (dryRun) {
    console.log(`would PUT repos/${repo}/branches/${BRANCH}/protection:`);
    console.log(JSON.stringify(protection, null, 2));
    return;
  }

  // Payload goes over stdin ("--input -") rather than a temp file: a predictable
  // name in a shared temp dir is a symlink-swap target.
  const result = gh(
    ["api", "-X", "PUT", `repos/${repo}/branches/${BRANCH}/protection`, "--input", "-"],
    { allowFailure: true, input: JSON.stringify(protection) },
  );

  if (result.failed) {
    const stderr = String(result.stderr);
    if (stderr.includes("Upgrade to GitHub Pro")) {
      console.error(
        [
          `Cannot protect ${BRANCH}: GitHub does not offer branch protection on a`,
          "private repository under a free plan.",
          "",
          "Either:",
          "  1. make the repo public — but see docs/decisions/ADR-0002-repo-privacy.md,",
          "     which requires stripping docs/pitch/ and docs/research/vertical-search/ first; or",
          "  2. upgrade the DevToolie org to GitHub Team, then re-run this script.",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.error(stderr.trim());
    process.exit(1);
  }

  const applied = JSON.parse(result);
  console.log(`protected ${repo}@${BRANCH}:`);
  console.log(`  required checks:      ${applied.required_status_checks.contexts.join(", ")}`);
  console.log(`  strict (up to date):  ${applied.required_status_checks.strict}`);
  // GitHub omits the key entirely when no review rule is set, so this has to
  // read as absent rather than as a zero.
  const reviews = applied.required_pull_request_reviews;
  console.log(
    `  approvals:            ${
      reviews
        ? `${reviews.required_approving_review_count}` +
          ` (code owners: ${reviews.require_code_owner_reviews},` +
          ` dismiss stale: ${reviews.dismiss_stale_reviews})`
        : "not required (solo project — see the note at the top of this file)"
    }`,
  );
  console.log(`  linear history:       ${applied.required_linear_history.enabled}`);
  console.log(`  force pushes:         ${applied.allow_force_pushes.enabled}`);
  console.log(`  deletions:            ${applied.allow_deletions.enabled}`);
  console.log(`  conversations:        ${applied.required_conversation_resolution.enabled}`);
  console.log(`  admins exempt:        ${!applied.enforce_admins.enabled}`);
}

main();
