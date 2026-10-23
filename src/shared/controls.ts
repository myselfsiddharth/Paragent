/**
 * The set of visible controls on a page, as role + accessible name keys
 * (ADR-0026, #224).
 *
 * Used twice, to make one observation: the recorder counts how many controls
 * a step's action made appear, and the runner checks that at least one did.
 * Both sides read the page through `contextExpression`, the capture the
 * privacy boundary already reviews, so no new attribute and no value is read.
 * The keys live in memory only: the recorder persists a count, never a name.
 */

import type { Page } from "playwright";
import { contextExpression, type ContextElement } from "./page-context.js";

/**
 * High enough that the count is about the page, not the repair payload's
 * 120-element budget. Truncation is in document order, so a page past this
 * would lose controls portaled to the end of the body first; none of the
 * gate's pages comes within an order of magnitude.
 */
export const CONTROL_SET_LIMIT = 10_000;

/**
 * Every visible control, with the repair context's dialog-first filtering
 * OFF (#230 review). That filtering drops what sits behind a modal, so a set
 * taken with a modal open and one taken after it closed would differ by the
 * whole page, and closing a modal would count as everything "appearing".
 */
export async function visibleControlKeys(page: Page): Promise<Set<string>> {
  const elements = (await page.evaluate(
    contextExpression("interactive", CONTROL_SET_LIMIT, false),
  )) as ContextElement[];
  return new Set(elements.map((e) => `${e.role}\u0000${e.name}`));
}

/** How long the control set must hold still before a "before" snapshot is taken. */
export const CONTROLS_QUIET_MS = 300;
/** The most a "before" snapshot waits for the page to hold still. */
export const CONTROLS_SETTLE_MAX_MS = 2_000;

/**
 * A "before" snapshot taken once the page has stopped rendering (#230
 * review): two reads `CONTROLS_QUIET_MS` apart that agree, within
 * `CONTROLS_SETTLE_MAX_MS`. Taken the instant the previous step passed, a
 * snapshot would miss controls still rendering from it, and those would then
 * count as revealed by a click that did nothing. If the page never holds
 * still, the last read is used: a churning page is not made quiet by waiting.
 */
export async function settledControlKeys(page: Page): Promise<Set<string>> {
  const deadline = Date.now() + CONTROLS_SETTLE_MAX_MS;
  let last = await visibleControlKeys(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(CONTROLS_QUIET_MS);
    const now = await visibleControlKeys(page);
    if (now.size === last.size && countAppeared(last, now) === 0) return now;
    last = now;
  }
  return last;
}

/** How many keys in `after` were not in `before`. */
export function countAppeared(before: ReadonlySet<string>, after: ReadonlySet<string>): number {
  let n = 0;
  for (const key of after) if (!before.has(key)) n += 1;
  return n;
}
