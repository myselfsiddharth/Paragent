---
title: Documentation index
doc_type: brief
status: review
owner: D2
created: 2026-07-24
updated: 2026-08-21
confidence: HIGH
supersedes: null
sources_verified: true
---

# docs/ — map

Live index. Update this file when you add or supersede a document — `npm run lint:docs`
fails the build on any `docs/*.md` this file does not link to, so it cannot go quietly stale.
Reading order: **[README-narrative.md](./README-narrative.md)** (~20 min).
Current state and what to work on: **[ROADMAP.md](./ROADMAP.md)**.
How to run and ship: **[DEVELOPMENT.md](./DEVELOPMENT.md)**.
Integrity surface: **[INTEGRITY-AUDIT.md](./INTEGRITY-AUDIT.md)**.

**Last true for this index:** 2026-07-25 (B0, post milestone/issue restructure).  
**Vertical lock:** **none** — Track-2 C5 **FAIL** ([research/vertical-search/DECISION.md](./research/vertical-search/DECISION.md); [ADR-0004](./decisions/ADR-0004-vertical-track2-fail.md)). Do not invent a lock.

| Column | Meaning |
| --- | --- |
| Status | Frontmatter `status` |
| Last true | Date facts were last verified / written |
| Supersedes / notes | What this replaces, or what it does *not* decide |

---

## Start here

| Doc | What it is | Status | Last true | Supersedes / notes |
| --- | --- | --- | --- | --- |
| [ROADMAP.md](./ROADMAP.md) | Current state, what is stubbed, milestones M0–M7 in order | accepted | 2026-07-25 | **Read before picking up an issue** |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Commands, layout, data flow, invariants, pre-PR checklist | accepted | 2026-07-25 | Contributor runbook |
| [architecture.md](./architecture.md) | How the `src/` packages connect: loop diagram, package/artifact tables, real vs stubbed, invariants | draft | 2026-08-21 | Owns the **chain** between packages; `gate/*.md` own one hop each. Derived from `e4ab318` — pipes wired, measurements still `no_data` (#168) |
| [README-narrative.md](./README-narrative.md) | Story: thesis → census kill → pivot → two tracks → evidence now | draft | 2026-07-25 | Includes C5 FAIL |
| [INTEGRITY-AUDIT.md](./INTEGRITY-AUDIT.md) | Unsourced claims, placeholders, LOW load-bearing, contradictions | draft | 2026-07-25 | Surfaces conflicts; does not pick winners |
| [README-internal.md](./README-internal.md) | Internal entry point: status table, tracks, public-repo rules, layout, stack | accepted | 2026-08-31 | Was `../README.md` until the root became visitor-facing (moved 2026-08-10). Track 2 **FAIL** / Track 3 Wave-1 draft match C5 + ADR-0004; INTEGRITY-AUDIT D-04 resolved. Layout block corrected against `ls src/` |
| [../README.md](../README.md) | Repo root **landing page** for first-time visitors: hook, 60-second try-it, where-this-fits | living | 2026-08-10 | Marketing surface only. Carries no metrics — status of record lives in [README-internal.md](./README-internal.md) |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Hard rules + YAML frontmatter standard | living | 2026-07-24 | Doc-shape source of truth |

---

## Decisions (ADRs)

| Doc | What it is | Status | Last true | Triggered by |
| --- | --- | --- | --- | --- |
| [ADR-0001](decisions/ADR-0001-typescript-node-playwright.md) | TypeScript + Node + Playwright stack | accepted | 2026-07-24 | Wave-0 parallel Track-1 agents + typed contracts |
| [ADR-0002](decisions/ADR-0002-repo-privacy.md) | Repo ALL-PRIVATE; still no secrets in git | **superseded** | 2026-07-24 | Superseded by ADR-0005 — historical only |
| [ADR-0003](decisions/ADR-0003-testbed-grafana-oss.md) | Grafana OSS self-hosted Track-1 test-bed | accepted | 2026-07-25 | Pivot Track 1 (no partner / no SaaS ToS) |
| [ADR-0004](decisions/ADR-0004-vertical-track2-fail.md) | Track-2 vertical **FAIL** — no surface lock | accepted | 2026-07-25 | [C5 DECISION.md](research/vertical-search/DECISION.md) after C4 kills |
| [ADR-0005](decisions/ADR-0005-repo-public.md) | Repo is **PUBLIC**, single tree, nothing stripped | accepted | 2026-07-25 | Supersedes ADR-0002; founder decision on issue #42 |
| [ADR-0006](decisions/ADR-0006-track1-gate-task.md) | Track-1 gate task = build + save a TestData Stat dashboard (12 steps) | accepted | 2026-07-28 | Issue #59. Walked by hand on 9.5.21 and 13.0.3; answers ADR-0003's "browser-meaningful" question |
| [ADR-0007](decisions/ADR-0007-post-action-visibility.md) | `visible_landmarks` filtered for real; new `post_action_target_visible` | accepted | 2026-07-26 | Issue #71, out of PR #70 |
| [ADR-0008](decisions/ADR-0008-wait-step-duration.md) | Recorded `wait` duration carried through as `wait_ms`, replacing the `networkidle` fallback for recorder output | accepted | 2026-08-03 | Issue #83 |
| [ADR-0009](decisions/ADR-0009-cache-confidence.md) | Confidence decay (EWMA α=0.3), invalidation below 0.5, repair rewrite; `invalidated_at` + `repair_provenance` | accepted | 2026-08-03 | Issue #64. Thresholds are **chosen defaults, not measured** |
| [ADR-0010](decisions/ADR-0010-amortization-cost-model.md) | One-time `cost_program_build` split from per-run `cost_fresh`; amortization is `no_data` without a measured payment; a recompile is a visible second payment | accepted | 2026-08-11 | Issue #123, before #39 lands a baseline. **No value measured yet** — the split is argued from arithmetic |
| [ADR-0011](decisions/ADR-0011-replay-wall-clock-budget.md) | Per-run wall-clock budget (5 min default); new `BUDGET_EXHAUSTED` outcome; unreached steps emit no row and the shortfall is reported (`steps_attempted`, `truncation`) | accepted | 2026-08-11 | Issue #84. Default is derived from per-step ceilings, **not** from an observed run-duration distribution |
| [ADR-0012](decisions/ADR-0012-repair-context-budget.md) | Repair context budget: `interactive` (role + accessible name), never input values; `serializeRepairContext()` is the only egress | accepted | 2026-08-11 | Issue #125. Blocks #27 in substance |
| [ADR-0013](decisions/ADR-0013-cache-program-entity.md) | Program entity in the cache (`program_id`, `steps_total`, `compiled_at`); a partial hit is a **MISS**; completeness fails closed while confidence stays advisory | accepted | 2026-08-11 | Issue #120. Precondition for #118. **Nothing reads the cache yet** — the resolver has no caller outside its tests |
| [ADR-0014](decisions/ADR-0014-cache-read-path.md) | Cache read path: a hit is `program_source == "cache"` **and** `replay_valid`, stored as two fields not one; `pool_only` scope makes tenant rows invisible to a cross-tenant reader | accepted | 2026-08-12 | Issue #118. Unblocks #67. `--from-cache` is opt-in; **no hit-rate measured yet**. Open questions updated 2026-08-12 with what the pool actually contains (#126 / ADR-0017) |
| [ADR-0015](decisions/ADR-0015-task-identity-and-intent-resolution.md) | Task identity (phrasing/parameters/host don't fork it, product version does); intent → task_key via normalized exact match behind a swappable `IntentMatcher`, MISS on no confident match; `site_key` drops the address (`grafana-oss@{version}`, never `@{host}:{port}`) | accepted | 2026-08-12 | Issue #124. New package `src/intent/`, wired into `src/recorder/cli.ts`. `gate:matrix --from-cache` wiring **not done yet** |
| [ADR-0016](decisions/ADR-0016-session-key-custody.md) | Session-key custody: KMS-wrapped master; rotation via a **global** `key_epoch` + batch re-encryption; per-tenant erasure via a **per-tenant secret** mixed into HKDF (a non-secret marker would erase nothing), not file deletion; dev/CI keep the env-var path unmodified | accepted | 2026-08-12 | Issue #146, follow-up to #98/#143. Decision only — no vendor picked, nothing implemented. Changes derivation, deliberately before a first caller exists |
| [ADR-0017](decisions/ADR-0017-pool-vocabulary-rule.md) | Pinned-version vocabulary rule added to the pool allowlist (`src/cache/vocabulary.ts`), additive to `isChromeName`; measured **zero** row-level yield change on the one live bundle — compiler pre-check and recorder tagging are the binding constraints there, not vocabulary | accepted | 2026-08-12 | Issue #126. Multi-version matrix yield is `no_data` — no Docker testbed in this environment |
| [ADR-0018](decisions/ADR-0018-session-consent-gate.md) | SC-05 consent moment = a stored consent record checked before every session-establishing run (not onboarding, not a one-time banner); `establishSession` now requires a `SessionAuthorization`, obtainable only via `SessionAuthorization.authorize(baseUrl, consent?)`, which refuses a non-local target with no `ConsentAcknowledgment` | accepted | 2026-08-14 | Issue #102. Gate is enforced by construction, the refusal is enforced by test; persistence, UI, and legal review of the copy are still open |
| [ADR-0019](decisions/ADR-0019-pool-precheck-topology.md) | Compiler `decidePoolEligibility` strips `tenant_scoped` siblings like `buildPoolRow`; live bundle `pool_eligible` moves 1/12 → 7/12 | accepted | 2026-08-21 | Issue #170. Direction invariant unchanged |
| [ADR-0020](decisions/ADR-0020-delegated-repair-cost-provenance.md) | Delegated repair client (host pays, no API key); `cost_measured`/`repair_cost_measured` mark a repair nobody could count, and those rows are **excluded** from the §9 cost aggregates rather than folded in as zeros | accepted | 2026-09-06 | Issue #189. Outcome aggregates still count them. **Does not unblock #39** — a measured denominator still needs a real `usage` block; no delegated repair has run against a real host agent |
| [ADR-0021](decisions/ADR-0021-first-live-replay-corrections.md) | First live replay on 9.5.21: page context now shows role-less clickable controls (`generic`), truthful input roles and container names (amends ADR-0012; no new attribute read); locators match exactly; `url-matches` waits; recorder stops emitting impossible structural paths. Gate task re-recorded as `-r2` | review | 2026-10-17 | r2 bundle replays 12/12 on its own version for the first time. Pre-ADR gate numbers are not comparable |
| [ADR-0022](decisions/ADR-0022-postcondition-anchoring.md) | Post-conditions on the acted-on element reference it (`locator_ref: action_target`) instead of copying a structural path; URL checks enforce recorded and state-bearing query keys, ignore view state. Contract: `assertion.schema.json` `target.locator_ref` | review | 2026-10-18 | Issue #211. Recompiled `-r2`: actions identical, pool eligibility unchanged (7/12), 12/12 on 9.5.21 |
| [ADR-0023](decisions/ADR-0023-dialog-first-context.md) | Page context captures the frontmost open dialog first (`in_dialog: true`); a declared modal drops what precedes it (portaled popups after it are kept), a non-modal dialog demotes it; a modal outranks a popover. Content-derived names follow accessible-name rules. Attribute allowlist now test-enforced (amends ADR-0012) | review | 2026-10-22 | Issue #212. Live 10.0.13 step 2: data-source choices 0 → 8 of 120. `interactive` rows are not comparable across this ADR where a dialog was open or a name was content-derived |
| [ADR-0024](decisions/ADR-0024-sequence-repair.md) | A repair may insert up to 2 actions before a step's own (`pre_actions`), checked once by the frozen assertion after the step's action; persisted with it. One repair, one step in §9; `pre_action_count` on step rows and `repair_shape` in the report say how many steps rest on it. Contracts: cache-row `pre_actions`, metrics step `pre_action_count` | review | 2026-10-22 | Issue #213, founder chose the atomic-sequence option. Pre-actions are pool-classified like `compiled_action`. Live 10.0.13: the sequence executes, but step 2's frozen post-condition (toggle still visible) is false on 10.0.13, so the step still fails; Qwen closes the dialog instead of choosing (no task intent in the egress). 13.0.3's menu case needs cross-attempt accumulation (open) |
| [ADR-0025](decisions/ADR-0025-repair-task-goal.md) | The repair model is told the task's goal (`task_goal`), the same text the fresh baseline gets (`--gate-task-goal`); a goal containing a bound value is refused at startup and before step 0, and dropped at the egress; run rows record `repair_task_goal_sha256` | review | 2026-10-22 | Issue #225, founder chose parity with fresh. Offline, same payload: glm-5-3 chooses TestData with the goal (3/3), closes the dialog without (3/3); the gate's qwen3-235b does not compose the sequence either way |
| [ADR-0026](decisions/ADR-0026-controls-appeared.md) | A click that stayed visible and revealed controls is checked by `controls-appeared` (≥1 new role+name pair; a count, weak) instead of "the clicked control is still visible"; recorder persists `controls_appeared` counts only; recorder waits for the URL to stop moving. Gate task re-recorded as **r3**. Contracts: trajectory `controls_appeared`, assertion type `controls-appeared` | review | 2026-10-22 | Issue #224. r3 vs r2: actions identical, checks differ only at steps 2 and 8; 9.5.21 12/12 ×3; live 10.0.13 step 2 passes with the right sequence and fails with an inert own action. Compiler settles mid-redirect URLs |
| [ADR-0027](decisions/ADR-0027-gate-model-and-repair-cap.md) | Gate model on Voyager is **glm-5-3** for both sides of §9 (`DEFAULT_VOYAGER_MODEL`); `gate:matrix` runs **uncapped**, bounded by the run's time budget; a step ends early only on a repeated proposal; run rows record `repair_cap` | review | 2026-10-22 | Founder decision. Fresh baseline re-measured on glm-5-3: 8/8 usable, 2/8 completed, mean 323,388 input tokens (lower bound). §9 bar unchanged at ≤2; pre-ADR numbers are qwen3-235b and not comparable |
| [ADR-0028](decisions/ADR-0028-fill-repair-binding.md) | A corrected fill/select is bound to the step's own slots (the model chooses where, never what); the egress carries a fill step's slot **names** (`step.param_slots`), never values | review | 2026-10-23 | First glm-5-3 matrix: all 36 runs on 10.0.13→12.2.1 stopped at step 6 because no repaired fill could carry its value. With the fix, live 10.0.13: 12/12, task success |

---

## PRD / briefs

| Doc | What it is | Status | Last true | Supersedes / notes |
| --- | --- | --- | --- | --- |
| [prd/README.md](prd/README.md) | Folder map | accepted | 2026-07-25 | — |
| [PRD v0.2](prd/PRD-trajectory-cache-v0.2.md) | Mechanism, §6 privacy, §9 *proposed* gates, build plan | accepted | 2026-07-29 | §8 selection rule superseded by pivot; **§8 residual + §9 status now redirected by the [v0.4 addendum](prd/PRD-v0.4-addendum.md)** |
| [Pivot brief v0.3](prd/pivot-brief-v0.3.md) | Structural finding + counterparty rule + two-track plan | accepted | 2026-07-24 | **Supersedes PRD §8 selection rule**; trigger A8 FAIL; Wave-2 lock later FAIL (C5) |
| [PRD v0.4 addendum](prd/PRD-v0.4-addendum.md) | §8 anchor redirect, §9 thresholds labelled **proposed**, kill-line precedence | accepted | 2026-07-29 | Resolves INTEGRITY-AUDIT D-02 / D-03 / D-06; **§9 controls** the Track-1 gate, pivot's ~50% is shorthand |

---

## Research — Week-0 census (FAILED — preserve)

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [census-week0/README.md](research/census-week0/README.md) | Archive index | killed | 2026-07-24 | Observability anchor killed |
| [A1-datadog.md](research/census-week0/A1-datadog.md) | Scout | killed | 2026-07-24 | Enumeration only |
| [A2-grafana.md](research/census-week0/A2-grafana.md) | Scout | killed | 2026-07-24 | Enumeration only |
| [A3-sentry.md](research/census-week0/A3-sentry.md) | Scout | killed | 2026-07-24 | Enumeration only |
| [A4-adversary.md](research/census-week0/A4-adversary.md) | **51/70 FULLY_API** kill list | killed | 2026-07-24 | Primary Week-0 falsification |
| [A5-evidence.md](research/census-week0/A5-evidence.md) | Frequency/pain proxies | killed | 2026-07-24 | Many LOW — A8 warns |
| [A6-tos.md](research/census-week0/A6-tos.md) | ToS overlay | killed | 2026-07-24 | HIGH for DD/GC |
| [A7-backup.md](research/census-week0/A7-backup.md) | Backup wedge notes | killed | 2026-07-24 | Historical; **not** a lock (C5/C4 close QAuto path) |
| [A8-DECISION.md](research/census-week0/A8-DECISION.md) | **FAIL**, 2/70 survivors | killed | 2026-07-24 | First vertical FAIL |

---

## Research — vertical search (Track 2)

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [vendor-security…](research/vertical-search/vendor-security-questionnaires-trust-portals.md) | C1 scout | draft | 2026-07-24 | Hypothesis; C4/C5 kill |
| [procurement…](research/vertical-search/procurement-supplier-onboarding.md) | C1 scout | draft | 2026-07-24 | C4 ERODING; C5 FAIL |
| [healthcare…](research/vertical-search/healthcare-payer-portals.md) | C2 scout | draft | 2026-07-24 | C4 ALREADY_SOLVED |
| [insurance…](research/vertical-search/insurance-broker-carrier-portals.md) | C2 scout | draft | 2026-07-24 | C4 ALREADY_SOLVED |
| [freight…](research/vertical-search/freight-carrier-customs-portals.md) | C3 scout | draft | 2026-07-24 | C4 ALREADY_SOLVED |
| [regulatory…](research/vertical-search/regulatory-government-filing-portals.md) | C3 scout | draft | 2026-07-24 | C4 ALREADY_SOLVED |
| [adversary-report.md](research/vertical-search/adversary-report.md) | C4 durability attack — 6/6 killed | draft | 2026-07-25 | Attack only |
| [DECISION.md](research/vertical-search/DECISION.md) | C5 adjudication — **FAIL**, 2/75, 0 DURABLE | accepted | 2026-07-25 | **No lock**; second consecutive vertical FAIL |

---

## Gate (Track 1)

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [testbed.md](gate/testbed.md) | Grafana OSS matrix | draft | 2026-07-25 | ADR-0003 |
| [gate-result-2026-10-17.md](gate/gate-result-2026-10-17.md) | **First live matrix run** — 48 runs, 8 pins, Voyager repair. No verdict (step-execution floor not met: 150 < 400). 9.5.21 6/6; every later pin 0/6, all on post-conditions. Repair vs fresh 0.3% tokens | review | 2026-10-18 | Step-validity 72% executed / 19% compiled; task success 12.5%; self-heal 0/42. Issues #209–#213. **Re-run after ADR-0022**: step-validity 78% / 26%, task success unchanged; every remaining failure is an inserted step (#213) |
| [churn-notes.md](gate/churn-notes.md) | Qualitative DOM churn notes per version transition | draft | 2026-08-21 | Issue #30; predictions vs observed; §9 rates still `no_data` |
| [recorder.md](gate/recorder.md) | Recorder | draft | 2026-07-24 | — |
| [compiler.md](gate/compiler.md) | Compiler | draft | 2026-08-12 | Its own `1/12` pre-check number annotated against ADR-0017's `7/12` authoritative recount |
| [runner.md](gate/runner.md) | Replay / repair | draft | 2026-07-24 | Measured gate number pending |
| [fresh-baseline.md](gate/fresh-baseline.md) | Fresh-reasoning baseline (§9 denominator) | draft | 2026-08-14 | Issue #39; harness only, no live measurement yet — `cost_fresh` stays `no_data` |
| [cache.md](gate/cache.md) | Persistence, confidence, repair rewrite | draft | 2026-08-12 | ADR-0009; confidence **never gates** the measurement |
| [assertion-audit.md](gate/assertion-audit.md) | Assertion-strength audit of the live bundle | draft | 2026-07-30 | Issue #61; found a strong assertion that is not load-bearing live (locator staleness, #24) |
| [pool-vocabulary.md](gate/pool-vocabulary.md) | Pool yield on the live bundle: compiler pre-check vs authoritative write path, vocabulary rule's measured (zero) marginal effect | draft | 2026-08-12 | Issue #126; [ADR-0017](decisions/ADR-0017-pool-vocabulary-rule.md); multi-version matrix is `no_data` |
| [../experiments/gate-v1/README.md](../experiments/gate-v1/README.md) | Throwaway harness | draft | 2026-07-25 | Empty → `no_data` |

---

## Privacy

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [boundary-spec.md](privacy/boundary-spec.md) | Write-time allowlist | review | 2026-07-24 | PRD §6; canary merge-blocking |
| [session-custody.md](privacy/session-custody.md) | Session-custody checklist + gap analysis | draft | 2026-08-14 | PRD §7; distinct from §6's pooling allowlist — see doc. SC-01 closed by #98; SC-02/04 enforced; SC-05 gate+refusal built ([ADR-0018](decisions/ADR-0018-session-consent-gate.md), #102, persistence/UI/legal review still open); SC-03/06 open (#100, #103) |
| [session-state-encryption.md](privacy/session-state-encryption.md) | SC-01 mechanism: threat model per environment, the envelope, and what key custody v1 **defers** | accepted | 2026-08-12 | Issue #98. A capability with **no callers** — nothing persists session material yet, and this does not change that. Custody/rotation/erasure now **decided** in [ADR-0016](decisions/ADR-0016-session-key-custody.md), which also changes the derivation this doc describes |
| [counsel-packet-sizing.md](privacy/counsel-packet-sizing.md) | Counsel-packet sizing (pivot brief §5): position outline, architecture note, storage decision, cost/preconditions | draft | 2026-08-14 | Issue #36. Not legal advice. Track 2 FAIL / no anchor locked (ADR-0004) — a template + trigger, not a position on an invented site. SC-06 remains "not addressed" pending #103's trigger |
| [session-consent-copy.md](privacy/session-consent-copy.md) | SC-05 draft consent screen copy (`copy_version: sc05-v1`) | draft | 2026-08-14 | Issue #102, [ADR-0018](decisions/ADR-0018-session-consent-gate.md). **Not legally reviewed** — do not treat as cleared |

---

## Pitch (Track 3)

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [pitch/README.md](pitch/README.md) | Pack index | draft | 2026-07-25 | D2 refreshed for C5; some objections prose may lag — INTEGRITY-AUDIT |
| [one-pager.md](pitch/one-pager.md) | One-pager | draft | 2026-07-25 | Wave-1 draft |
| [narrative.md](pitch/narrative.md) | Pitch narrative | draft | 2026-07-25 | Wave-1 draft |
| [deck-outline.md](pitch/deck-outline.md) | Deck outline | draft | 2026-07-25 | Residual slides may lag C5 — INTEGRITY-AUDIT D-01 / E-12 |
| [objections.md](pitch/objections.md) | Objection handling | draft | 2026-07-25 | Two FAILs present tense (D-07); residual prose flagged E-12 |
| [proof-points.md](pitch/proof-points.md) | Claim register | draft | 2026-07-25 | Diligence map |

---

## Outreach (Track 3)

| Doc | What it is | Status | Last true | Notes |
| --- | --- | --- | --- | --- |
| [outreach/awesome-lists.md](outreach/awesome-lists.md) | Draft entries + preconditions for awesome-browser-automation and awesome-ai-agents | draft | 2026-08-28 | Issue #138. Preconditions **met** (`paragent@0.1.1` published, `npx` Quick Start verified); submission is still the founder's call, no external PRs from agents |

---

## Contracts

| Doc | What it is | Notes |
| --- | --- | --- |
| [../contracts/](../contracts/) | trajectory / assertion / cache-row / metrics | Integration surface |

---

## Work tracking

Milestones **M0 → M7** on the GitHub issue board are the execution plan; the same sequence,
with current implementation state and what is stubbed, is in [ROADMAP.md](./ROADMAP.md).
M0–M4 are strictly sequential (each milestone's exit criterion is the next one's
precondition); M5 and M7 can run in parallel; M6 is blocked on the M4 gate number.

## Open questions / what I could not verify

- ~~Root README Track 2/3 status lines are still stale (INTEGRITY-AUDIT D-04) — tracked as issue #54.~~
  **Resolved** — the root README status table now records Track 2 as FAIL and Track 3 as a
  Wave-1 draft, both citing in-repo artifacts. The residual deck/objections prose flagged by
  D-01 and E-12 is a separate, still-open lag.
- Founder post-Track-1 choice (intermediary reframe vs shut search) — C5 next action; not decided in docs.
- Measured gate number — still unset; do not invent.
- Whether to buy GitHub Secret Protection. Non-provider patterns and validity checks are
  entitlement-blocked on the org's free plan — attempted and verified 2026-07-25, see
  [ADR-0005](decisions/ADR-0005-repo-public.md) Consequences. Founder cost call.
