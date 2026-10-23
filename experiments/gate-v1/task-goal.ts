/**
 * The gate task's stated goal, in prose — never the compiled program's steps,
 * locators, or assertions. Phrased at the same level of intent as ADR-0006's
 * decision table, deliberately not its per-step DOM detail: a fresh agent is
 * told what "done" looks like, not how a recording already got there.
 *
 * Shared by both sides of the §9 ratio (ADR-0025): the fresh baseline is given
 * it as its task, and the repair model the same text, so the two are equally
 * informed about what the task is for. One definition, so they cannot drift
 * apart while a ratio is computed across them.
 *
 * Overridable via `--task-goal` (in `gate:baseline` and `gate:matrix`) for a
 * different program under test.
 */
export const DEFAULT_TASK_GOAL =
  "Create a new dashboard. Add a panel to it using the TestData data source, and " +
  "configure the panel as a Stat visualization with a query alias and a series " +
  "count of your choosing. Give the panel a title. Apply the panel back to the " +
  "dashboard, then save the dashboard under a title of your choosing. Confirm the " +
  "saved dashboard appears in the dashboards list. The task is done once the " +
  "dashboard is saved and visible in that list.";
