---
title: "ADR-0022: post-conditions reference the action's element, and URL checks ignore only view state"
doc_type: adr
status: review
owner: B3
created: 2026-10-18
updated: 2026-10-18
confidence: MED
supersedes: null
sources_verified: true
---

# ADR-0022 — Post-condition anchoring

**Status:** review · **Trigger:** [#211](https://github.com/myselfsiddharth/Paragent/issues/211), from the
first live gate matrix ([gate-result-2026-10-17](../gate/gate-result-2026-10-17.md)).
Builds on [ADR-0021](ADR-0021-first-live-replay-corrections.md). Leaves assertion immutability under
repair (ADR-0012, `assertAssertionUnchanged`) exactly as it is.

## Context

The first live matrix replayed the gate bundle 6/6 on its recording version and 0/6 on every later
pin. **Every failure was a post-condition. None was an action:**

- **10.0.13, 10.4.19, 11.0.0, step 2.** The `element-visible` check targeted
  `main > div:nth-of-type(2) > … > button:nth-of-type(1)`. `pickPrimaryLocator` takes the first
  chain entry not tagged tenant-scoped, and the recorder tags every name-bearing candidate, so the
  pick is a structural path in practice. **7 of 12** checks were built this way.
- **11.5.2 → 13.0.3, step 0.** `url-matches` was `^…/dashboard/new\?orgId=1$`. From 11.5.2 Grafana
  settles on `?orgId=1&from=now-6h&to=now&timezone=browser`. Repair correctly proposed nothing.

Assertions are frozen under repair, so a check more specific than its task can never be healed.

## Decision

### 1. A check on the acted-on element references it

All seven element checks are about **the element the step acted on**: either "the control I clicked
is still visible", or (ADR-0007) "the control I clicked is gone". The compiler now emits
`target: { locator_ref: "action_target" }` for these, instead of copying a locator.
`executeAction` returns the locator it actually resolved (the chain entry that matched), and
`evaluateAssertion` checks visibility on exactly that locator.

- **Layout changes stop breaking the check.** It resolves through the action's chain, which tries
  exact semantic handles first.
- **A repaired action carries its check with it.** The assertion object is byte-identical before
  and after repair, so `assertAssertionUnchanged` still holds. What it *means*, "the acted-on
  element", is the same claim it always made.
- **"Gone" is precise.** It means the matched element no longer matches. A visible decoy further
  down the fallback chain cannot make it pass, and a control that did not disappear still fails
  (tested).
- **No page text enters the assertion.** Pool eligibility of the gate bundle is unchanged (7/12).

Contract: `contracts/assertion.schema.json` gains `target.locator_ref` (enum: `action_target`).

### 2. URL checks: recorded keys required, state-bearing keys enforced, view state ignored

`urlRegexTemplate()` (`src/compiler/assertions.ts`) uses the recording itself to decide which query
keys matter:

- Every key recorded on the step's URL must be present with its recorded value (holes match any
  value). This is as strict as before.
- A key is **state-bearing** for a path if the recording saw that path both with and without it,
  or with different values (`editPanel` on `/dashboard/new`). A state-bearing key the step did not
  record must be **absent**.
- Any other extra key is view state, and is ignored.

A plain subset match was rejected because it is a real weakening. Step 7 ("Apply, back to the
dashboard") expects `?orgId=1`, and a failed Apply leaves `?orgId=1&editPanel=1`; subset matching
would pass it. The rule above rejects it, including when `editPanel` is buried among view-state
keys (tested).

No product-specific parameter list: the rule needs nothing but the trajectory. Unchanged:
`url-matches` evaluation in the runner. Only the compiled regex differs.

## Alternatives rejected

- **Semantic copied locators** (role/label names in the assertion). These carry tenant-tagged text
  into every row and would drop pool eligibility, trading the cross-agent pool for the gate. The
  reference gets the robustness without the text.
- **Let repair rewrite post-conditions.** This makes replay-validity self-fulfilling (ROADMAP rule 3).
- **A Grafana view-state denylist** (`from`, `to`, `timezone`, …). Product-specific, and silently
  wrong on the next product.

## Consequences

- Recompiling the same `-r2` trajectory changes **only** post-conditions: actions are
  byte-identical, 7 checks become references, and 5 URL regexes change.
  `artifacts/compiled/traj-gate-live-create-stat-dashboard-from-testdata-9.5.21-r2-adr0022.bundle.json`
  replays 12/12 on 9.5.21 with the stub repair client (3/3 runs).
- Bundles compiled before this ADR keep their copied locators and anchored regexes, and still
  replay exactly as before.
- Step 2 on Grafana 10+ is still expected to fail: the data-source modal is an inserted step
  (#213), and the capture hides it (#212). This ADR removes the post-condition failures, not those.

## Open questions / what I could not verify

- **Whether a `locator_ref` check is strong enough for steps whose real purpose is downstream state**
  (e.g. "the picker opened"). It is exactly as strong as the copied-locator check it replaces, no
  stronger. #210 (`value-equals`) is the path to checks that prove an outcome. For click steps
  this showed up live on 10.0.13 and is answered by [ADR-0026](ADR-0026-controls-appeared.md).
- **The state-bearing rule depends on the recording having visited the distinguishing states.** A
  key whose alternate state was never recorded is treated as view state.
