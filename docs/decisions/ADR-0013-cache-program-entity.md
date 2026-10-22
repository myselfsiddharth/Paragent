---
title: "ADR-0013 — A program entity in the cache, and what a partial hit means"
doc_type: adr
status: accepted
owner: B4
created: 2026-08-11
updated: 2026-08-11
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0013 — A program entity in the cache, and what a partial hit means

## Status

accepted

## Context

**Triggered by:** issue #120.

The cache is keyed per step — `CacheKey = { site_key, task_key, step_index }`.
That is the right key for a row. It is not sufficient to describe the thing a
cache *hit* serves, which is a whole ordered program plus a decision to trust it.

Three facts at the commit this ADR was written against:

1. **No program identity.** `program_id` was synthesized at adapt time
   (`prog-<source_trajectory_id>`, `src/runner/program.ts`) and never written
   onto a row. Rows carried `row_id`, `site_key`, `task_key`, `step_index` and
   nothing naming the program they belong to.
2. **No step count.** `contracts/cache-row.schema.json` had no `steps_total`, no
   terminal-step marker. Given a set of rows, no reader could distinguish a
   complete 5-step task from an 8-step task whose last three rows were never
   written.
3. **Partial coverage is the normal case.** `ReplayRunner` breaks out of the step
   loop on any non-success outcome, and the cache-update sink fires per step
   inside that loop. A run that fails at step 4 of 12 therefore writes a
   **prefix**.

Combined, the cache holds prefixes that are indistinguishable from complete
tasks. **Every individual row is valid in both cases** — the difference exists
only at a level the schema did not have.

### Why this is not a metrics problem

#118 asks the runner to resolve a program from the cache by
`(site_key, task_key)`. Against the pre-#120 schema that resolver has no way to
answer *"do I have all of it?"*, so the first time it meets a task with a missing
tail it assembles a truncated program and replays it. On a live site that is not
a wasted run or a bad number — it is a browser executing the first four steps of
a twelve-step flow and stopping in the middle of a form. The failure is silent
because nothing about it is invalid.

Rows exist on disk in an append-only store that is never rewritten, so this is
much cheaper to decide now than after #118 lands.

## Decision

### 1. Program identity is denormalized onto every row

A `program` object — `{ program_id, steps_total, compiled_at }` — is written by
the compiler onto every row it emits.

**Denormalized rather than a second record type.** The store is a flat
append-only JSONL with one shape per line, loaded by casting each line to
`CacheRow`; introducing a second record type would change the store interface,
the file format, and the load path all at once, to hold three fields. It also
makes the invariant local: a row that does not know its own program cannot be
assembled into one by accident.

The cost is real and worth naming: `steps_total` is repeated on every row and can
therefore *disagree* across rows of one program. That is treated as corruption,
not resolved by a vote — see decision 3.

**The compiler is the only thing that can write it.** `steps_total` is not
derivable from the rows a resolver happens to hold; deriving it from them is
precisely the question being asked. The compiler is the only actor that has seen
the whole trajectory.

### 2. `required_params` is derived, not stored

#120 sketched `required_params` as a field on the program record. It is **not**
stored. `requiredParams()` already derives the answer from a program's steps, and
`rowsToProgram()` calls it when assembling a resolved program — before anything
opens a browser, which is what #120 actually asked for.

Storing it would create a second source of truth that a recompile could leave
stale, in the one place a caller has no way to check it. Deriving means the
declaration cannot disagree with the steps it describes. This is the same
reasoning `requiredParams()` already applies when it *unions* a program's
declared `required_params` with what its steps need: a declaration may add a
requirement, never quietly remove one.

### 3. Completeness fails closed. A partial hit is a MISS.

A resolver returns a program **only** when it holds `steps_total` rows with
contiguous `step_index` values `0..steps_total-1`, all under one `program_id`.
Anything else is a MISS carrying a reason:

| Reason | Meaning |
| --- | --- |
| `no_rows` | nothing cached for this `(site_key, task_key)` |
| `no_program_ref` | rows exist but carry no identity — they predate this ADR |
| `incomplete` | identity present, but no version is provably whole |

Rows disagreeing about `steps_total`, or a row outside `0..steps_total-1`, are
`incomplete` — not reconciled by majority. A resolver that guessed there would be
guessing about exactly the field it exists to trust.

**#120 named three options for a partial hit. This picks MISS.**

- *Replay the valid prefix, then hand the live browser to a model mid-flight* is
  the most valuable and the most dangerous. It is rejected **because the
  mechanism does not exist**, not because it is undesirable: nothing in
  `src/runner/` can hand off an in-flight page, and a repair client cannot resume
  a flow it has no state for. Building that is a larger change than #120, and
  choosing it here would have meant shipping the schema and deferring the
  behaviour — leaving the truncation hazard open in the meantime.
- *Refuse and re-record* is a policy for a caller, not for a resolver. A MISS
  already permits it.

MISS throws away real work when 11 of 12 steps are cached. That is the accepted
cost, and it is the same posture `writeCacheRow()` takes on the privacy
boundary, for the same reason: the silent-wrong outcome is worse than the
loud-missing one.

**No completeness is ever inferred.** A task whose rows predate this ADR
resolves as `no_program_ref`, never as "probably complete". The highest
`step_index` present is a lower bound on a program's length, never its length.

### 4. Trust composes as "any invalidated row invalidates the program" — and is reported, never enforced

A program is flagged `invalidated` when **any** of its rows is invalidated
(ADR-0009). A flow is only as replayable as its worst step.

**The flag never suppresses anything.** A resolved program is returned whole,
with every row, invalidated or not, and callers must still attempt every step.
This is the #64 invariant arriving through a new door:

> Confidence never gates the gate measurement.

Skipping low-confidence rows would silently shrink the step-validity denominator
and inflate the headline gate number. A read path is exactly where a later reader
helpfully adds `if (row.confidence < THRESHOLD) skip`, so the distinction is
stated here, in `src/cache/resolve.ts`, and pinned by
`tests/unit/cache-resolve.test.ts` — which asserts an invalidated program still
resolves with all of its rows, and is guard-proven by making the resolver drop
them (3 tests fail).

The two questions get deliberately opposite answers, which is the part most
likely to be "corrected" later:

| Question | Kind | Behaviour |
| --- | --- | --- |
| Do I hold every step? | structural | **fails closed** — MISS |
| Are those steps still trustworthy? | empirical | **reported, never enforced** |

### 5. A recompile is resolved by grouping, not by recency of row

Rows are grouped by `program_id` before completeness is judged. `CacheStore` is
last-write-wins per step and append-only, so recompiling a 12-step task down to 5
updates rows 0-4 and leaves rows 5-11 on disk under the previous `program_id`.
Pooled together they look like a 12-row task with a version change in the middle.
Grouped, the new version is whole and the orphaned tail correctly has no step 0.
When two versions are both complete, the newer `compiled_at` wins, with
`program_id` breaking exact ties so the answer does not depend on file order.

## Consequences

**Nothing reads the cache yet.** This ADR adds the entity and the resolver;
`resolveProgram()` has no caller in `src/` outside its own tests. Wiring it into
the runner, and defining what a hit means for §9, is #118 — which can now assume
a resolver that never returns a short program.

**Rows written before this change are unresolvable**, by design. They are not
migrated and not deleted; the store is append-only and a recompile writes new
versions alongside them. The only compiled bundle on `main` will carry `program`
the next time it is recompiled.

**`steps_total` can disagree across a program's rows.** The chosen denormalization
makes that representable, and the resolver treats it as `incomplete`. A second
record type would have made it unrepresentable instead; that trade was taken
knowingly and is the main thing to revisit if the cache ever grows a real
migration story.

**A third copy of the `prog-` convention was avoided.** `CacheRow` is declared
twice — `src/cache/types.ts` and `src/compiler/types.ts` — which predates this
change. `ProgramRef` and the id convention live in `src/shared/program-id.ts`,
imported by both, and `tests/unit/program-id.test.ts` asserts a single carrier in
the manner #74 established.

## Reversal cost

**Low for the resolver, medium for the schema.** `resolveProgram()` has no
callers and can be deleted. The `program` field is optional and additive, so
removing it breaks no existing row — but rows carrying it will already be on disk
in an append-only store, and the field would linger as an unread artifact.
Reversing decision 3 (MISS → prefix replay) is not a reversal but a new
capability, and needs the in-flight handoff that does not exist.

## Later amendments

- **[ADR-0024](ADR-0024-sequence-repair.md) (#213).** A repair may insert up to two actions before a
  step's own, stored as the row's `pre_actions`. They are part of the step, not new steps:
  `steps_total` is unchanged.

## Open questions / what I could not verify

- **Whether MISS-on-partial is the right long-run behaviour.** It is right today
  because prefix replay has no mechanism. Once a repair client can resume an
  in-flight page, the trade changes and this decision should be re-opened rather
  than inherited.
- **What a hit means for §9.** Deliberately not decided here. Replay uses no
  model, so a hit cannot mean "skipped a model call"; #118 owns that definition
  and #67's hit-rate denominator depends on it.
- **Whether `program_id` should become a first-class contract.** It stays a
  naming convention with one carrier. `docs/gate/runner.md` has tracked the
  related question of bundle `$id` since #62; neither is answered here.
- **Cross-tenant resolution is not addressed.** Reading is the first outbound
  flow across the privacy boundary — a pool row written while serving one tenant
  being resolved for another — and this ADR does not authorize or implement it.
  `resolveProgram()` reads whatever store it is handed. #118 owns that boundary
  and needs its own canary in the outbound direction.
- **No measurement.** Nothing here is validated against a real cache with real
  churn, because nothing has ever served a program from cache. The failure modes
  are argued from the schema and pinned by tests, not observed.
