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
 * budget: Grafana's panel editor alone fills the 120-element repair cap.
 */
export const CONTROL_SET_LIMIT = 2_000;

export async function visibleControlKeys(page: Page): Promise<Set<string>> {
  const elements = (await page.evaluate(
    contextExpression("interactive", CONTROL_SET_LIMIT),
  )) as ContextElement[];
  return new Set(elements.map((e) => `${e.role}\u0000${e.name}`));
}

/** How many keys in `after` were not in `before`. */
export function countAppeared(before: ReadonlySet<string>, after: ReadonlySet<string>): number {
  let n = 0;
  for (const key of after) if (!before.has(key)) n += 1;
  return n;
}
