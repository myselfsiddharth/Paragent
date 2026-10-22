---
title: "ADR-0021: the first live replay — what the harness got wrong, and widening what the models are shown"
doc_type: adr
status: review
owner: B4
created: 2026-10-17
updated: 2026-10-17
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0021 — First live replay: harness corrections and the page-context widening

**Status:** review · **Trigger:** the first live gate session (2026-10-17), run on ASU's Voyager
gateway with `--provider voyager` / `--repair-provider voyager`.
Amends [ADR-0012](ADR-0012-repair-context-budget.md) (what the repair and fresh-baseline models are
shown). Leaves [ADR-0010](ADR-0010-amortization-cost-model.md) and
[ADR-0020](ADR-0020-delegated-repair-cost-provenance.md) unchanged.

## Context

Until this session the 12-step gate bundle
(`artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21.bundle.json`) had
never been replayed live end to end, and the fresh baseline (#39) had never run. Both were tried
against a seeded Grafana OSS 9.5.21 — the version the bundle was **recorded** on, where the
correct result is 12/12 with no repairs. Neither got close:

| Observation (live, 9.5.21) | Cause |
| --- | --- |
| Fresh baseline 0/5: four attempts hit the 30-turn cap, one died on a transport error | The model could not see the Stat visualization card, so the task was unfinishable |
| Replay failed at step 0 in ~0.4s, every run | `url-matches` read `page.url()` once; Grafana appends `?orgId=1` client-side after load |
| Replay failed at step 5 (`PAGE_ERROR`) | `getByLabel("Series count")` substring-matched `<div aria-label="TestData series count">` first |
| Replay failed at step 6 (`LOCATOR_NOT_FOUND`) | The step's only locator was a structural path truncated at the recorder's 12-level cap but prefixed `body >` — it could not match on any version |
| A logged fresh attempt spent 19 of 30 turns on two fields | `input[type=number]` was reported as `textbox` (ARIA: `spinbutton`); the panel-title input had no accessible name at all |

Every one of these would have landed in the §9 churn denominators as a failure or a repair, on the
version where there is no churn. A gate number produced on that harness would have measured these
defects, not churn.

## Decision

### 1. Page context shows role-less controls, truthful roles, and container names (amends ADR-0012)

`contextExpression()` (`src/shared/page-context.ts`) changes in three ways at the `interactive` and
`tree` levels:

- **Role-less labelled controls.** A visible element with an `aria-label`, no `role`, and computed
  `cursor: pointer` is included as role `generic`. This is Grafana's visualization-picker card
  (`aria-label="Plugin visualization item Stat"`) and react-select options (`"Select option"`).
  The pointer filter keeps labelled layout wrappers (`"TestData series count"`) out.
- **Truthful implicit roles.** `input[type=number|range|search]` are reported as
  `spinbutton|slider|searchbox`, the roles Playwright's role engine uses, instead of `textbox`.
- **Container names.** A control with no accessible name takes the `aria-label` of its nearest
  labelled ancestor (bounded at 8 levels). The panel-title input becomes
  `textbox "Panel options Title field property editor"` instead of an indistinguishable
  `textbox ""`.

**The privacy boundary does not move.** No new attribute is read: `aria-label` was already the
first source of every name and is on `CONTEXT_ATTRIBUTE_ALLOWLIST`. No text content and no value is
read for the new elements; `tests/unit/page-context.test.ts` pins that with the existing canaries,
and the merge-blocking `tests/canary/` suite passes unchanged. What widens is the *set of elements*
whose `aria-label` is shown. An `aria-label` can carry tenant text, but that was already true of
every labelled button and link.

`resolveLocator` (`src/runner/locators.ts`) resolves what the capture now emits:

- `role_name` + `generic` resolves as an exact label lookup, because `getByRole("generic", { name })`
  never matches (measured).
- Any other `role_name` resolves as "element with this role and name" **or** "element with this
  role inside a container labelled this name" (`.or()`), so container-named controls are
  targetable.

Both models see the same capture, and both target through the same resolver. This applies
equally to the fresh-baseline agent and to the repair client, which had the same blind spot: a
churned step-3 could never have been healed.

### 2. Locators match recorded names exactly

`role_name`, `label`, `text` and `placeholder` now pass `exact: true`. The recorder captures names
verbatim, so exact matching is what replaying a recording means. Substring matching combined with
`.first()` chose the wrong element silently. **This makes a renamed control a miss, not a loose
re-find.** Under churn that is a repair, counted as one. Before, it would have been counted as a
clean replay of whatever element happened to contain the old name.

### 3. `url-matches` waits up to `timeout_ms`

Like every other assertion type in `src/runner/assertions.ts`. A URL that is genuinely wrong still
fails, at the deadline.

### 4. The recorder stops emitting impossible structural paths, and anchors unnamed elements

A path truncated at the depth cap is emitted unanchored, as the descendant suffix it actually is.
Elements also get a `css_vocab` candidate anchored on their nearest `aria-label`'d ancestor (e.g.
`[aria-label="Panel options Title field property editor"] > … > input`), ranked above structural.
It is `tenant_scoped: true` like every label-derived candidate, and the compiler's existing
`looksLikeTenantSelector` screen decides whether it can be pooled.

The gate task was re-recorded as
`experiments/gate-v1/trajectories/grafana-create-stat-dashboard-from-testdata-9.5.21-r2.json` and
compiled to `artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r2.bundle.json`
(12 rows, 7 pool-eligible — unchanged). **The original bundle and trajectory are left untouched**:
ADR-0017, `docs/gate/pool-vocabulary.md` and several tests cite measurements on them.

## Alternatives rejected

- **Shrink the fresh task goal so it avoids unreachable controls.** The two §9 arms would then be
  measuring different tasks.
- **Let the fresh agent target by any CSS selector.** It would need page structure it is not
  allowed to see under ADR-0012, and the repair client would still be blind.
- **Hand-patch step 6 in the committed bundle.** A compiled artifact edited by hand is no longer the
  output of the compiler it claims to be.
- **Leave substring matching and add an ambiguity check.** It still re-finds a *renamed* control
  silently, which is exactly the churn signal the gate exists to measure.

## Consequences

- On 9.5.21 the r2 bundle replays **12/12 with zero repairs** (stub repair client, 4 runs across two
  sessions), for the first time.
- A logged fresh-baseline attempt completed the task for the first time (26 turns). It also claimed
  success while skipping a required field, so `task_success` from the fresh baseline is audited
  against the Grafana API rather than trusted (`docs/gate/fresh-baseline.md`, "What this does not
  settle").
- Gate numbers produced before this ADR are not comparable with those produced after it. None were
  published.
- `repair_context_level` is still `"interactive"`, but what `"interactive"` contains has changed.
  Rows from before and after this ADR are not comparable at the same level name.

## Open questions / what I could not verify

- **The pointer heuristic.** `cursor: pointer` admits role-less controls that render as clickable.
  A control styled without it stays invisible, and decorative elements styled with it are shown.
  This has been checked on Grafana 9.5.21 only, not on the seven later pins.
- **`text-matches`** waits for its element to attach and then reads the text once — a milder form
  of the race fixed for `url-matches`. It has not been observed failing, and it is left alone.
- **Exact matching versus Grafana's own copy changes.** Whether exact matching raises the repair
  rate on later pins enough to matter is exactly what the matrix run measures. It is not predicted
  here.
- **Container naming** takes the *nearest* labelled ancestor. Where two unnamed controls share one
  labelled container they get the same name, and resolution picks the first in document order.
