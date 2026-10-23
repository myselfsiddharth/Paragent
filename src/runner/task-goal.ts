/**
 * The task goal's boundary rules (ADR-0025), in one place: the runner refuses
 * a run with them, the egress drops a goal by them, and the gate driver checks
 * them before anything boots.
 */

import { createHash } from "node:crypto";
import type { ParamBindings } from "./types.js";

/**
 * The shortest bound value the guard compares. Shorter values ("5", "on")
 * occur in ordinary prose; refusing on them would refuse every goal, and a
 * value that short is not a secret worth the check.
 */
export const TASK_GOAL_MIN_PARAM_LENGTH = 4;

/**
 * The name of a param whose bound value appears in the goal, or undefined.
 *
 * Strings and numbers both: a PIN or an account id is often bound as a
 * number. Case-insensitive, because a value is no less a leak for being
 * capitalised differently. Fails closed on ordinary words too: a placeholder
 * binding that happens to appear in the goal is refused, and the fix is to
 * bind something else, never to loosen the check.
 */
export function paramInTaskGoal(goal: string, params: ParamBindings): string | undefined {
  const haystack = goal.toLowerCase();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const needle = String(value).toLowerCase();
    if (needle.length >= TASK_GOAL_MIN_PARAM_LENGTH && haystack.includes(needle)) return name;
  }
  return undefined;
}

/** A goal as it may leave: trimmed, and undefined when blank. */
export function normalizeTaskGoal(goal: string | undefined): string | undefined {
  const trimmed = goal?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Which goal a run used, without the text: rows from runs told different
 * goals are not comparable, and a digest is enough to tell them apart.
 */
export function taskGoalDigest(goal: string): string {
  return createHash("sha256").update(goal).digest("hex").slice(0, 12);
}
