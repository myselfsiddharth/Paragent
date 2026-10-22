/**
 * Locator resolution via Playwright preferred APIs.
 *
 * ## Every text-bearing strategy matches EXACTLY
 *
 * Playwright's `getByRole({ name })`, `getByLabel`, `getByText` and
 * `getByPlaceholder` default to case-insensitive SUBSTRING matching, and
 * `resolveWithFallback` takes `.first()` of whatever matched. Together those
 * silently pick the wrong element whenever a recorded name is contained in
 * another one. The first live replay of the gate bundle on its own recording
 * version (9.5.21) failed exactly that way: `label: "Series count"` resolved to
 * `<div aria-label="TestData series count">` (earlier in the DOM than the
 * input) and the fill threw PAGE_ERROR. Step 1's `"Add new panel"` only
 * survived because the right button happened to precede "Add new panel from
 * panel library".
 *
 * The recorder captures accessible names verbatim, so exact matching is what
 * "replay what was recorded" means. The cost is real and deliberate: a label
 * that changes by a character under churn now fails instead of being loosely
 * re-found — which is a repair, measured as one, rather than a silent guess
 * the §9 aggregates would count as a clean replay.
 *
 * Sources:
 * - contracts/cache-row.schema.json locator strategies
 * - https://playwright.dev/docs/locators — access_date: 2026-07-24
 */

import type { Locator, Page } from "playwright";
import type { LocatorSpec } from "./types.js";

export class LocatorNotFoundError extends Error {
  readonly chain: LocatorSpec[];

  constructor(message: string, chain: LocatorSpec[] = []) {
    super(message);
    this.name = "LocatorNotFoundError";
    this.chain = chain;
  }
}

export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.strategy) {
    case "role_name": {
      if (!spec.role) {
        throw new LocatorNotFoundError(
          "role_name locator missing role",
          [spec],
        );
      }
      // ADR-0021: a role-less labelled control is captured as role "generic",
      // and getByRole("generic", { name }) never matches — generic elements
      // take no accessible name in Playwright's role engine. Its name IS its
      // aria-label, so resolve it the way it was captured.
      if (spec.role === "generic" && spec.name !== undefined) {
        return page.getByLabel(spec.name, { exact: true });
      }
      const role = spec.role as Parameters<Page["getByRole"]>[0];
      if (spec.name === undefined) return page.getByRole(role);
      // ADR-0021: an unnamed control is captured under the name of its nearest
      // labelled container, so "role R named N" also means "the R inside the
      // container labelled N". `.or()` keeps both; resolveWithFallback takes
      // the first in document order, as it always has.
      return page
        .getByRole(role, { name: spec.name, exact: true })
        .or(page.getByLabel(spec.name, { exact: true }).getByRole(role));
    }
    case "label": {
      if (!spec.label) {
        throw new LocatorNotFoundError("label locator missing label", [spec]);
      }
      return page.getByLabel(spec.label, { exact: true });
    }
    case "testid": {
      if (!spec.testid) {
        throw new LocatorNotFoundError(
          "testid locator missing testid",
          [spec],
        );
      }
      return page.getByTestId(spec.testid);
    }
    case "text": {
      if (!spec.text) {
        throw new LocatorNotFoundError("text locator missing text", [spec]);
      }
      return page.getByText(spec.text, { exact: true });
    }
    case "placeholder": {
      if (!spec.text && !spec.name) {
        throw new LocatorNotFoundError(
          "placeholder locator missing text/name",
          [spec],
        );
      }
      return page.getByPlaceholder(spec.text ?? spec.name!, { exact: true });
    }
    case "structural": {
      if (!spec.structural_path) {
        throw new LocatorNotFoundError(
          "structural locator missing structural_path",
          [spec],
        );
      }
      return page.locator(spec.structural_path);
    }
    case "css_vocab": {
      if (!spec.css) {
        throw new LocatorNotFoundError(
          "css_vocab locator missing css",
          [spec],
        );
      }
      return page.locator(spec.css);
    }
    case "topology_only": {
      // Degraded pool-safe stub — no concrete selector (cache-row.schema.json).
      throw new LocatorNotFoundError(
        "topology_only has no concrete selector; cannot resolve",
        [spec],
      );
    }
    default: {
      const _exhaustive: never = spec.strategy;
      throw new LocatorNotFoundError(
        `unknown locator strategy: ${String(_exhaustive)}`,
        [spec],
      );
    }
  }
}

/**
 * Try each locator in order; return the first with count > 0.
 * Throws LocatorNotFoundError if the chain is empty or all fail.
 */
export async function resolveWithFallback(
  page: Page,
  chain: LocatorSpec[],
): Promise<Locator> {
  if (chain.length === 0) {
    throw new LocatorNotFoundError("empty locator_fallback_chain", chain);
  }
  const failures: string[] = [];
  for (const spec of chain) {
    try {
      const loc = resolveLocator(page, spec);
      const count = await loc.count();
      if (count > 0) return loc.first();
      failures.push(`${spec.strategy}: matched 0`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${spec.strategy}: ${msg}`);
    }
  }
  throw new LocatorNotFoundError(
    `no locator matched (${failures.join("; ")})`,
    chain,
  );
}
