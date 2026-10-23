---
title: Development runbook — commands, layout, and pre-PR checks
doc_type: runbook
status: accepted
owner: B0
created: 2026-07-25
updated: 2026-08-11
confidence: HIGH
supersedes: null
sources_verified: true
---

# Development runbook

Everything you need to run, test, and ship a change. For *what* to work on, read
[ROADMAP.md](./ROADMAP.md). For the rules, read [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Setup

```bash
git clone https://github.com/DevToolie/Paragent.git
cd Paragent
npm install
npx playwright install --with-deps chromium   # the recorder test needs a browser
npm run ci                                    # must be green before you change anything
```

Node 20+ is required (`engines` in `package.json`). Docker Desktop or a Docker daemon is
required only for the testbed; everything else runs without it.

---

## Commands

### Checks — run these

| Command | What it does | Merge-blocking |
| --- | --- | --- |
| `npm run ci` | secret-scan → validate:contracts → lint → lint:docs → typecheck → unit tests → integration tests | yes |
| `npm run test:canary` | Privacy boundary canaries — zero tenant strings in pool-eligible rows | **yes**, separate CI job |
| `npm run test:integration` | Whole loop on a loopback fixture: record → compile → cache-write → replay → report | yes |
| `npm run secret-scan` | `scripts/secret-scan.mjs` over the tree | yes |
| `npm run validate:contracts` | Ajv-validates `contracts/examples/*` against the schemas, plus every trajectory-shaped `.json` under `experiments/` — see below | yes |
| `npm run lint` / `npm run typecheck` | eslint / `tsc --noEmit`. Lint ignores exactly what `.gitignore` ignores, read from that file rather than restated ([#144](https://github.com/DevToolie/Paragent/issues/144)) — so generated output like `experiments/gate-v1/out/` cannot fail lint on your machine while CI, which has no such files, stays green | yes |
| `npm run lint:docs` | `scripts/lint-docs.mjs` — frontmatter keys and values, `docs/README.md` index coverage, trailing Open-questions section, relative links that resolve | yes |
| `npm run test` | Unit tests (`tests/unit`) — see the note on browser suites below | yes |

### Browser-driven suites, and why the runner is capped

Eleven suites launch real Chromium. Two rules keep that from turning `npm test` into a machine
that is slower than the tests it runs ([#145](https://github.com/DevToolie/Paragent/issues/145)):

- **Launch through `launchTestBrowser()`** (`tests/helpers/browser.ts`), never Playwright
  directly. It sets an explicit launch ceiling and reports an unlaunchable browser as
  `BrowserLaunchError` — an environment problem, named as one — instead of failing inside
  whichever assertion happened to run first. `tests/unit/browser-launch.test.ts` fails the build
  on a direct call.
- **`vitest.config.ts` caps workers** (default 4, `PARAGENT_TEST_WORKERS` overrides), so browsers
  cannot outnumber cores. This is the actual fix for the 944-second test that prompted the issue:
  per-test timeouts are enforced by a timer, and a timer needs CPU, so a badly oversubscribed
  machine starves the very thing meant to bound it. Measured cost of the cap on a 10-core laptop:
  none — 28.0 s against 28.6 s uncapped, because one suite dominates either way.

### Running the pieces

| Command | What it does |
| --- | --- |
| `npm run testbed -- --list` | Show the pinned Grafana version matrix |
| `npm run testbed -- --version 11.0.0 --dry-run` | Print the compose plan; no Docker needed |
| `npm run testbed -- --version 11.0.0` | Bring up a seeded instance on `http://127.0.0.1:3000` |
| `npm run testbed -- --version 11.0.0 --down` | Tear it down |
| `npm run recorder -- --fixture` | Record against the bundled static HTML fixture |
| `npm run recorder -- --base-url http://127.0.0.1:3000` | Record against a live instance |
| `npm run compile -- --in <trajectory.json>` | Compile to a cache-row bundle in `artifacts/compiled/` |
| `npm run gate:matrix -- --dry-run` | Walk the version matrix, emit zero-token rows |
| `npm run gate:report` | Render `experiments/gate-v1/out/report/{json,csv,html,svg}` |

Credentials for the recorder come from `PARAGENT_USERNAME` and `PARAGENT_USER_SECRET`
environment variables **only**. They must never reach a committed artifact —
`assertNoLiteralSecrets` runs on every trajectory write.

### Where a recording has to live: nowhere in particular

`npm run recorder -- --out <path>` writes wherever you point it. `validate:contracts` finds a
recording by its **shape** — a `trajectory_id` plus a `steps` array, or a `$schema` naming the
trajectory schema — not by its directory, so a recording in `experiments/gate-v2/recordings/` is
checked exactly like one in `experiments/gate-v1/trajectories/`. That includes the check against
`additionalProperties: false`, which is what makes an accidental `cookies` field unrepresentable
rather than merely discouraged.

Two consequences worth knowing:

- Anything in a directory literally named `trajectories/` is validated **regardless of shape**, so
  a file there that does not parse fails loudly instead of being skipped for not looking like a
  recording.
- Discovery starts at `experiments/` and does not descend into `out/` (gitignored run artifacts).
  A recording written outside `experiments/` entirely is still not discovered — put recordings
  under `experiments/`.

---

## Layout

```
contracts/           JSON Schema — the integration surface. Build against these.
  trajectory.schema.json    recorder writes, compiler reads
  assertion.schema.json     compiler writes, runner + cache read
  cache-row.schema.json     compiler + cache write, runner reads
  metrics.schema.json       runner writes
src/
  testbed/    Grafana OSS matrix, compose, provisioning overlay, HTTP seed
  recorder/   Playwright trajectory capture, param lifting, redaction
  compiler/   Assertion synthesis, locator chains, pool eligibility
  cache/      Write-time privacy allowlist, taint checking, canary pipeline
  runner/     Replay, assertions, actions, repair loop, page state
  metrics/    Cost types, NDJSON emitter, PRD §9 aggregates
experiments/gate-v1/  Throwaway gate harness — do not promote into a product API
tests/
  unit/         Fast, no Docker, no network (eleven suites do drive a real browser)
  integration/  Whole pipeline against a loopback fixture — no Docker, no model
  canary/       Privacy boundary — merge-blocking
  helpers/      Shared test scaffolding — `launchTestBrowser()` is the only way a suite starts Chromium
scripts/      secret-scan, validate-contracts, branch protection, testbed compose
artifacts/    Compiled bundles (committed)
docs/         Map: docs/README.md
archive/      Superseded scaffolds and preserved history
```

Generated output that is **gitignored and must stay that way**:
`experiments/gate-v1/out/`, `scripts/testbed/.runtime/`.

---

## The data flow

```
testbed (Grafana OSS @ pinned tag)
   └─> recorder ──trajectory.schema──> trajectory.json
         └─> compiler ──cache-row.schema + assertion.schema──> bundle in artifacts/compiled/
               └─> cache write (fail-closed) ──> pool row + tenant row
                     └─> runner replay ──> assertion pass/fail
                           └─> repair (assertion frozen) ──> corrected action
                                 └─> metrics ──metrics.schema──> out/metrics.ndjson
                                       └─> gate report (§9 sections, no_data-safe)
```

Contracts are the integration surface. Prefer extending a schema via ADR over adding an
ad-hoc field in one package — ambiguity here becomes a merge conflict in three days.

---

## Invariants you must not break

1. **Assertions are immutable during repair.** `deepFreeze` + `assertAssertionUnchanged` in
   `src/runner/`. A repair may supply `corrected_action`, plus up to two `pre_actions` to run
   before it (ADR-0024), and nothing else; pre-action locators pass the same pool boundary.
   Weakening a check to make a step pass makes replay-validity self-fulfilling and destroys the gate.
2. **Pool writes fail closed.** `writeCacheRow()` refuses a pool-eligible row carrying a
   free-text locator, a `tenant_scoped` locator, or a tenant literal in an assertion. Do not
   add a path to the cache store that bypasses it.
3. **Typed values never enter a trajectory.** Every value the agent types or reads becomes a
   parameter slot. The recorder stores `{monitor_name: string}`, never the value.
4. **Aggregates report `no_data`, not 0.** An empty denominator is not a zero rate. This is
   deliberate; `src/metrics/aggregate.ts` does it consistently and new metrics must too.
5. **Never invent a metric.** Fabricating a number is a fireable error (CONTRIBUTING rule 3).

---

## Before you open a PR

- [ ] `npm run ci` green
- [ ] `npm run test:canary` green
- [ ] Branch named `track1/<agent>-<topic>`, `track2/…`, `track3/…`, or `wave0/b0-<topic>`
- [ ] One logical unit; small enough to review in one sitting
- [ ] Docs written **with** the code; `docs/README.md` index updated if you added a doc
- [ ] Every doc carries the YAML frontmatter block and ends with
      `## Open questions / what I could not verify`
- [ ] Every factual claim in a research doc has a URL and an `access_date`
- [ ] No credentials, cookies, session state, `.env`, tokens, customer names, or third-party
      portal content anywhere in the diff
- [ ] Any number you state cites the measured artifact it came from

---

## Writing an issue for another agent

Issues in this repo are written to be executed cold. If you file one, include: the context an
agent needs without reading the whole repo, the exact files involved, the constraints
(especially what *not* to do), concrete test commands, and a pre-PR checklist. Existing
issues under any milestone are the template.

---

## Open questions / what I could not verify

- Whether every pinned Grafana tag boots on a given machine — unverified as of writing; see
  [ROADMAP.md](./ROADMAP.md) and issue #23.
- ~~Whether `npm run lint:docs` exists yet — issue #53.~~ **Landed** — it is in the command
  table above and in `npm run ci`. What it does *not* check is the shape of evidence tables
  (per-row `access_date` columns, INTEGRITY-AUDIT E-09/E-10) or any `.md` outside `docs/`
  (E-11); both are still enforced by review.
