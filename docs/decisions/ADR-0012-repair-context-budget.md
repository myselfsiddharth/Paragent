---
title: "ADR-0012 — The repair model's context budget"
doc_type: adr
status: accepted
owner: B4
created: 2026-08-11
updated: 2026-08-11
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0012 — The repair model's context budget

## Status

accepted

## Context

**Triggered by:** issue #125.

`RepairContext.page_state` gave the repair model four things: a URL, a page
title, `network_idle`, and a list of ARIA **landmark role names** —
`["main", "navigation"]`. The task set for the model was: given a failed
locator, produce a corrected locator that resolves on a page it cannot see.

That is not a hard task. It is an **underdetermined** one. A corrected locator is
a role plus an accessible name; a context carrying no role/name pairs does not
contain the answer.

Two documents already govern this area and **both are about restriction**:
`docs/privacy/boundary-spec.md` says what may enter the pool, ADR-0007 says the
model must never be shown a page the recorder never saw. Neither asks what the
mechanism needs in order to work. That question is what this ADR answers.

### Why it had to be answered before #27

#27 wires a real Anthropic client to this interface. On a cache **miss** the
system pays replay **plus** repair **plus** the fresh run it still has to do — so
a repair that reliably fails is more expensive than never having cached at all,
and every churn event lands there.

PRD §9's kill line is a **ratio**: `mean repair cost ≥ 70% of fresh`. A repair
that burns tokens at a structurally near-zero success rate does not merely score
badly. It pushes the project toward a **FAIL verdict for a reason that is a
design parameter rather than a property of the thesis under test** — and
CONTRIBUTING's "do not soften a finding" cuts both ways. An unforced FAIL is as
misleading as an unearned PASS.

## Options considered

Roughly increasing capability and increasing exposure.

### A — Landmark roles only (the status quo, rejected as the default)

Honest case for: minimal exposure, and it is what shipped.

Honest case against: the context cannot contain the answer. At this level
`elements` is empty — **by construction, which is a property of the design and
not a measurement**, and this ADR does not dress it up as one. The model is asked
to name a role and an accessible name having been shown neither.

Kept as a selectable level, because it is the honest floor to measure *against*
once #27 exists: a self-heal rate at `landmarks` is the baseline that says how
much the richer context bought.

### B — Role + accessible name of interactive elements (chosen)

Honest case for: it is exactly the shape of the answer. A corrected locator is a
role and a name; this supplies the candidate roles and names and nothing else.

Honest case against: accessible names are page-authored strings. On a
closed SaaS portal they can carry tenant vocabulary — a button labelled with a
customer's project name. This is real and is recorded under Consequences rather
than waved off; note the cache's own boundary already treats a free-text locator
as tenant-tainted (`src/cache/allowlist.ts`), and #126 is the open question about
whether product vocabulary and tenant data can be told apart at all.

### C — Filtered accessibility tree, values stripped (implemented, not default)

#125 flagged this as "plausibly the shape that satisfies both sides — but that
is a hypothesis to state, not a conclusion to assume". Measured, it is not.

Honest case against: it adds non-interactive structure, and a repair proposes an
action against something **actionable**. Measured on live Grafana 9.5.21, it
surfaced **no target that B did not**, at 19–63% more payload (see below).
Available as `tree` for the cases where orientation turns out to matter; not the
default, because paying exposure for nothing is not a trade.

### D — DOM excerpt with allowlisted attributes (rejected, not implemented)

Honest case for: the most capability.

Honest case against: it is the first level whose output **cannot be reviewed by
reading a fixed field list**. A, B and C emit a closed set of fields — role,
name, state — and a reviewer can confirm the boundary by reading the interface.
A DOM excerpt emits whatever the page contains, filtered; correctness then rests
on the filter being exhaustive against markup nobody has seen yet. Rejected
outright rather than left unimplemented-but-blessed, so that adding it later is
a decision with an ADR rather than an afternoon's work.

## Decision

**B — `interactive` — is the default.** `landmarks` and `tree` remain selectable.

### What every level excludes, unconditionally

No text content, no input values, no attribute values beyond the structural
allowlist, no cookies, no storage. An element's **value is never read at any
level** — `stripValues` is not a setting, because a setting can be flipped.
`tests/unit/page-context.test.ts` pins this behaviourally (a filled password
field, a filled text input, and a placeholder, all set to one canary) and
structurally (the source string handed to the browser contains no route to a
value at all).

### The egress boundary

`serializeRepairContext()` (`src/runner/repair-egress.ts`) is the **only**
authorized shape a client may send. It is built by naming fields, not by deleting
them from a copy, so a field added to `RepairContext` next year is invisible to
the model until someone adds a line — and that line is a diff a reviewer sees.

Excluded deliberately: `params` (the runtime bindings, secrets included),
`assertion.expected` (holes, and a literal if a compiler bug ever let one
through), `param_refs`, and `error_message`. That last is the one worth naming:
it reads like diagnostics and is the field a well-meaning change adds first, but
a Playwright locator error can quote the resolved selector and surrounding text,
which is page content arriving through a channel nobody classified.

`tests/canary/repair-egress.test.ts` is **merge-blocking** and asserts both
directions — nothing unauthorized in the payload, and no client in the tree
serializing the raw context around it.

### Recorded in the metrics

`repair_context_level` goes on the run row, next to the cost accounting #27
defines. A self-heal rate is **not reproducible** without it: two runs with the
same `model_id` and different levels are not comparable. It is written only when
a repair actually ran, so a run that asked no model anything does not imply a
measurement that did not happen.

## Consequences

**The floor is established structurally, not empirically.** What is measured
below is *what each level exposes*. What is **not** measured is whether a model
succeeds at each level — that needs #27, and this ADR does not claim it.

Measured on live Grafana 9.5.21, capturing at each level and checking whether the
identifying string of the live bundle's step targets is present:

| Page | Level | Elements | Payload | Bundle targets present |
| --- | --- | --- | --- | --- |
| `/` (home) | landmarks | 0 | 2 B | none |
| | interactive | 30 | 2034 B | none |
| | tree | 43 | 3317 B | none |
| `/dashboard/new` | landmarks | 0 | 2 B | **none** |
| | interactive | 20 | 831 B | **3** — `Add new panel`, `Save dashboard`, `Dashboards` |
| | tree | 23 | 989 B | the same 3 |

Two things follow, and only these two:

1. At `landmarks` the answer is **absent**, so repair cannot succeed there for
   reasons that have nothing to do with the model. This is what makes an
   unforced FAIL a live risk rather than a hypothetical one.
2. `tree` found nothing `interactive` did not, at 19% more payload on
   `/dashboard/new` and 63% on the home page.

**Accessible names are page-authored.** On open-source software at a pinned tag
they are the vendor's own vocabulary, verifiable by anyone who runs the image.
On a closed portal they may not be. #126 is the open question about telling those
apart; until it is answered, `interactive` on a tenant surface exposes strings
the boundary has not classified.

**The repair proposal is unchanged.** `corrected_action` only.
`assertAssertionUnchanged` is untouched and non-negotiable — richer input is not
a licence to touch the assertion.

## Reversal cost

**Low.** The level is a parameter with a default; reverting is
`repairContextLevel: "landmarks"`, and every level is already implemented and
tested. What would be lost is the reason: the measurement above would have to be
re-run to re-justify a change.

## Later amendments

- [ADR-0021](ADR-0021-first-live-replay-corrections.md), [ADR-0023](ADR-0023-dialog-first-context.md): what the `interactive` capture contains.
- [ADR-0025](ADR-0025-repair-task-goal.md): the egress carries the task goal.
- [ADR-0028](ADR-0028-fill-repair-binding.md): the egress carries a fill step's slot names, never values.

## Open questions / what I could not verify

- **Whether a model actually repairs better at `interactive` than at
  `landmarks`.** This ADR establishes that the answer is *present* at one level
  and *absent* at the other. It does not establish that a model finds it. That
  measurement needs #27, and #125's protocol — break a locator, n≥3 per level,
  report the spread not a mean — is the right shape for it.
- **Two pages, not twelve.** The table samples the home page and
  `/dashboard/new`. Reaching the other ten step states means walking the task,
  which #24's recording does and this ADR did not. The `landmarks` conclusion
  does not depend on the sample (it is empty everywhere by construction); the
  `tree`-adds-nothing conclusion does.
- **Whether `interactive` is enough on a page with hundreds of controls.** The
  capture caps at 120 elements and de-duplicates by role+name. On Grafana's
  editor that was never approached; a denser surface might truncate away the
  target, and nothing currently reports when the cap was hit.
- **Whether accessible names are safe to send off-machine on a tenant surface.**
  See #126. This ADR authorizes them for the Track-1 gate task, which runs
  against self-hosted open-source software at a pinned version.
