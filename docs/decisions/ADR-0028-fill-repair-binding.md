---
title: "ADR-0028: a repaired fill types the step's own value, and the model is told the slot's name"
doc_type: adr
status: review
owner: B3
created: 2026-10-23
updated: 2026-10-23
confidence: HIGH
supersedes: null
sources_verified: true
---

# ADR-0028 — Fill repair binding

**Status:** review · **Trigger:** the first full glm-5-3 matrix (2026-10-22, ADR-0027). Founder chose
the "slot name" option over "step intent" the same day. Amends the egress allowlist of
[ADR-0012](ADR-0012-repair-context-budget.md), as [ADR-0025](ADR-0025-repair-task-goal.md) did.

## Context

The first matrix on glm-5-3 (r3, `--gate-task-goal`, uncapped) was unusually clean. Every failure
had one of two causes:

| Versions | Result |
| --- | --- |
| 9.5.21 | 6/6 pass |
| 10.0.13 → 12.2.1 | 0/36. Step 2 repaired in all 36 (it was 0 before ADR-0023–0027); **every run stopped at step 6**, "Title the panel" |
| 13.0.3 | 0/6, stopped at step 1 ([#226](https://github.com/myselfsiddharth/Paragent/issues/226)) |

Step 6 was blocked by two problems, both found with a live probe:

1. **A bug: no repaired fill could ever work.** The model is not shown the step's `param_refs`
   (ADR-0012 excluded them), so its corrected `fill` carried none, and replay failed with "fill
   missing bound param value", whichever field it chose.
2. **Missing information.** The failed locator's only readable anchor was an `aria-label` in a
   `css_vocab` locator, and the egress drops `css` text. Told nothing about which field the step
   was for, glm-5-3 filled "Alias", then "Series count". Offline, on the captured payload, both
   hints fixed it (2/2 each):
   - the slot name `panel_title`;
   - the step's recorded intent, "Title the panel".

## Decision

### 1. A proposal can never reference a caller's value; the runner binds the step's own

The model chooses **where** to type, never **what**. Now that it is told slot names (below), that
has to hold on every path, not just the corrected action:

- **`sanitizeProposedAction` drops `param_refs`** from every model-proposed action, and the output
  schema no longer offers the field.
- **A `{slot}` hole** in a proposed `url_template` or `key` rejects the proposal whole. Otherwise a
  `{password}` in a URL would carry a bound value off-site.
- **A pre-action cannot type.** A fill or select in `pre_actions` rejects the proposal; a
  pre-action has no value of its own.
- **`withStepBinding()`** binds a corrected fill or select to the step's own slots. It uses
  `requiredParamsForAction`, the same rule as the run-start check, so only a fill/select step's
  slots qualify, never a navigate step's URL holes. The persisted repair carries them, so the
  cached row replays.

### 2. The egress carries the slot names of a fill or select step

`step.param_slots`: the names (`["panel_title"]`), copied from the compiled step through
`requiredParamsForAction`. Never a value, and never looked up in `params`. A name that contains a
bound value is dropped, the same fail-closed rule as the task goal. Absent for other steps.
`docs/privacy/boundary-spec.md` lists the field. The prompt gains one line: target the
field the named value belongs in; the runner binds the value.

**What it reveals.** That a field of that kind exists: a slot named `password` says the step types
a password. No value crosses, and the canary asserts both halves: the name appears only under
`step.param_slots`, and no bound value appears anywhere.

**Why not the step intent.** It fixed the same case offline, but compiled rows do not store it, so
it needs a contract change and a recompile. For agent-recorded tasks (#127) it is also free text an
agent wrote. Slot names are already in every compiled fill row, and they are developer-chosen
identifiers.

## Measured (2026-10-23)

Live on Grafana 10.0.13, r3, glm-5-3, `--gate-task-goal`, uncapped, with this change: **12/12 steps,
task success**, 2 repairs.

- Step 6 was repaired to "Panel options Title field property editor" on the first proposal.
- Steps 7–11 passed, the first time any step past 6 has run on a churned version.
- At step 2 the model **closed** the data-source dialog rather than choosing TestData (offline it
  chose TestData 3/3). The task still completed, since TestData is the instance's default source.
  It is recorded here because a different default would have made that the wrong choice.

## Consequences

- Fill repairs are possible for the first time. Earlier matrices could not repair any fill step,
  so their step-validity past the first churned fill is not comparable.
- The next full matrix is the measurement.

## Open questions / what I could not verify

- **Select steps** take the same path, but none is in the gate task.
- **Step intent** stays available as a further hint if slot names prove too thin for other tasks.
