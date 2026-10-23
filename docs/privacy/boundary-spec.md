---
title: Privacy boundary specification (write-time allowlist)
doc_type: spec
status: review
owner: B5
created: 2026-07-24
updated: 2026-08-12
confidence: HIGH
supersedes: null
sources_verified: true
---

# Privacy boundary — pool cache write path

This document is the implementation spec for the Track-1 privacy boundary.
Enforcement lives in `src/cache/` and is merge-blocked by `npm run test:canary`.

## Goal

Cross-tenant **pooled** cache rows must contain only content on a **positive
allowlist**. Everything else is **tenant-scoped by default**. We do **not**
scrub arbitrary strings into safety — scrubbing fails open; allowlisting fails
closed.

## Sources

| Claim | Source | Access date |
| --- | --- | --- |
| Positive allowlist + taint vectors + write-time refusal + canary | Wave pack Agent B5 task text | 2026-07-24 |
| `pool_eligible` / `pool_ineligible_reason` enum | `contracts/cache-row.schema.json` | 2026-07-24 |
| Locator strategies | `contracts/trajectory.schema.json`, `contracts/cache-row.schema.json` | 2026-07-24 |
| Assertion templates with typed holes | `contracts/assertion.schema.json` | 2026-07-24 |
| ARIA role vocabulary basis | [WAI-ARIA 1.2 role definitions](https://www.w3.org/TR/wai-aria-1.2/#role_definitions) | 2026-07-24 |
| PRD §6 file on disk | **Not present** in repo at authoring time (`docs/prd/PRD-trajectory-cache-v0.2.md` missing); Wave pack B5 + contracts used as working §6 | 2026-07-24 |

## Positive allowlist (pool-eligible content)

A `pool_eligible=true` row may contain **only**:

1. **Role-based locators** whose `role` is in `ALLOWED_ARIA_ROLES` and whose
   accessible `name` / `label` is UI chrome (`UI_CHROME_NAMES`) or template-only.
2. **Structural position** (`strategy=structural`) without quoted attrs / free text.
3. **Allowlisted test ids** (`ALLOWED_TESTID_VALUES` or template-only).
4. **CSS vocab selectors** using only `ALLOWED_CSS_ATTR_NAMES`, never
   `DENIED_CSS_ATTR_NAMES` (e.g. `data-account-id`).
5. **Assertion templates** with typed holes — never tenant literals.
6. **Flow topology** (`prev_action_type`, `next_action_type`, `landmark`).
7. **Topology-only sentinel** when locators cannot pool.

Code: `src/cache/allowlist.ts`.

## Taint rules

Named rules in `src/cache/taint.ts` (`DEFAULT_TAINT_RULES`):

| Rule id | Fires when |
| --- | --- |
| `caller_marked_tenant` | Upstream set `tenant_scoped=true` |
| `free_text_strategy` | `strategy=text` |
| `non_vocab_css_attr` | Non-allowlisted / denied CSS attrs or tenant values |
| `aria_label_or_name_tenant` | `role_name` / `label` name not chrome/template |
| `role_text_tenant` | `role_name` with non-chrome `text` |
| `non_vocab_role` | Role outside `ALLOWED_ARIA_ROLES` |
| `non_vocab_testid` | testid outside chrome vocabulary |
| `structural_free_text` | Structural path embeds free text / attr selectors |

## Write-time enforcement

`writeCacheRow` / `writeCacheRowPair` in `src/cache/write.ts`:

- Recomputes `pool_eligible` (caller hints are not authoritative).
- Strips tainted locators from the pool view.
- Refuses (`CacheWriteRejectedError`) unsafe `pool_eligible=true` demands.
- Logs only metadata — never locator payloads.

## Degradation path

When no pool-safe locator remains but `flow_topology` is present: pool row uses
`topology_only`, `pool_eligible=true`, locators stay on the tenant twin only.

## Canary CI (merge-blocking)

`tests/canary/canary.test.ts` + `tests/canary/mutation.test.ts`:

1. Seed `CANARY_TENANT` with unique canary strings.
2. Fixture record→compile→cache-write with canaries in locators.
3. Assert zero canaries in `pool_eligible=true` rows, logs, and metrics.
4. Mutation: `taintRulesWithout("non_vocab_css_attr")` causes canary leak —
   proving the rule is load-bearing.

CI: `.github/workflows/ci.yml` → `privacy-canary` → `npm run test:canary`.

## Persistence — two files, append-only (#63)

The cache was write-only until #63: `CacheStore` had a single `write`, and the canary pipeline
passed a store whose body was an empty comment. Rows were classified correctly and then thrown
away.

`JsonlCacheStore` (`src/cache/store.ts`) persists them, and three properties carry the privacy
weight:

| Property | Why it is not optional |
| --- | --- |
| **Two files, routed on `pool_eligible`** | `pool.jsonl` and `tenant.jsonl` never mix. The routing is one comparison, so no code path can merge them by accident |
| **Append-only** | The file *is* the audit trail. A rewriting store would let the next correct write erase the evidence that a tenant string once reached the pool file |
| **The store is dumb** | `writeCacheRow()` stays the only gatekeeper. No validation lives in the store, and nothing reaches a store without passing through the write path |

Last write wins on read; every superseded version stays on disk. That is what PRD §5.3 needs — a
current answer plus the history of how it got there.

**Cache files are never committed.** `.gitignore` matches `.cache/` and also `pool.jsonl` /
`tenant.jsonl` by name anywhere, because the store takes an explicit directory and a caller can
point it elsewhere. A committed `tenant.jsonl` is a privacy incident, not a bug — it holds
tenant-scoped rows by design.

`tests/canary/store-leak.test.ts` is the check that matters: it runs the canary pipeline against
a real store in a temp directory and greps the **bytes on disk**. It also asserts the *counter*
case — that `tenant.jsonl` does carry the canary material — because a clean pool file proves
nothing if the strings were dropped everywhere or nothing was written at all.

**A malformed line is skipped, not fatal (#96).** Because the file is append-only, a bad line —
a process killed mid-`appendFileSync`, a disk-full condition — is never removed by anything. A
constructor that threw on it would fail every future `new JsonlCacheStore({ dir })` against that
directory too, turning a one-time crash into a permanent outage of the cache. `loadInto` catches
a `JSON.parse` failure per line, skips only that line, and reports it through `log.warn` (or
`console.warn` with no sink configured — silence is not an option). This is safe *because* the
cache is not the ledger: a row that never fully landed on disk is exactly as good as a cache
miss, and the write path can produce it again.

## The repair prompt is a second egress (ADR-0012)

This spec governs what may enter the **pool**. [ADR-0012](../decisions/ADR-0012-repair-context-budget.md)
governs a different exit: what may be sent to a **repair model**, which #27 will make a real
network call to a third party.

They are not the same boundary and neither supersedes the other. A pool row is stored and reused
across tenants; a repair payload is sent once and not retained here. The pool rules are stricter
on reuse; the egress rules are stricter on content, because the destination is outside the
process.

What the repair payload may carry, and nothing else: the failed step's locators (minus free
text), the assertion's type and strength, the page URL, title, landmarks, and the role +
accessible name of visible interactive elements. Two later additions:

- the task goal, developer-authored prose, dropped if it contains a bound value
  ([ADR-0025](../decisions/ADR-0025-repair-task-goal.md));
- a fill or select step's slot **names**, never values
  ([ADR-0028](../decisions/ADR-0028-fill-repair-binding.md)).

**No input values at any level** — see `src/shared/page-context.ts`. The reverse direction is
closed too: a model's proposal cannot reference a caller's value. `param_refs` are dropped, a
`{slot}` hole rejects the proposal, and the runner binds a corrected fill to the step's own slots
(ADR-0028). `serializeRepairContext()` is the only authorized shape and
`tests/canary/repair-egress.test.ts` is merge-blocking.

Open, and shared with [#126](https://github.com/DevToolie/Paragent/issues/126): an accessible
name is page-authored. On self-hosted open-source software at a pinned tag it is vendor
vocabulary anyone can reproduce; on a closed portal it may carry tenant strings this spec has not
classified.

**#126 answered the pool-write half of this** — not the repair-egress half described above, which
is still open. [ADR-0017](../decisions/ADR-0017-pool-vocabulary-rule.md) adds
`src/cache/vocabulary.ts`: a committed, source-cited snapshot of accessible names/testids verified
against the pinned open-source artifact itself, additive to `UI_CHROME_NAMES` in the positive
allowlist above (rule 1) and to `ALLOWED_TESTID_VALUES` (rule 3), never a bypass of
`writeCacheRow()`. It still refuses a locator carrying `tenant_scoped: true` regardless of
vocabulary match — vocabulary widens what counts as chrome, it does not override an upstream
tenant claim. It does not apply to the repair payload this section governs, and it does not extend
to closed SaaS portals, which have no public vocabulary to verify against and remain on the
50-word floor.

## Attacks this does NOT defend against

1. Side channels (timing, row counts, site_key cardinality).
2. Compromised allowlist maintainers widening chrome vocab.
3. Obfuscated / encoded PII inside allowlisted field shapes.
4. Screenshots, HAR, cookies, storage dumps (repo policy, not this module).
5. Model prompts / repair traces (runner scope).
6. Callers bypassing `writeCacheRow`.
7. Inference from topology alone for rare tenant-unique flows.
8. Unfiled PRD §6 amendments — reconcile via ADR when founder PRD lands.

## Open questions / what I could not verify

- Exact PRD §6 wording — file missing at B5 authoring time.
- Whether chrome names should be site-keyed vs global.
- Whether topology stubs should use `pool_ineligible_reason=topology_only_degraded`
  instead of `pool_eligible=true` (schema has the reason; this spec treats
  topology stubs as eligible topology-only shares).
