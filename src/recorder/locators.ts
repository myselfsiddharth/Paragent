import type { Locator } from "playwright";
import type { LocatorCandidate } from "./types.js";

/**
 * Preference order: role_name > label > testid > css_vocab (anchored) > structural > text
 * Sources: https://playwright.dev/docs/locators — access_date: 2026-07-25
 *
 * ## Structural paths are capped, and a capped path must not claim `body`
 *
 * The walk up to `<body>` stops after MAX_PATH_DEPTH levels. Until the first
 * live replay of the gate bundle on 9.5.21 the result was always prefixed
 * `body > `, so any element deeper than the cap got a path asserting it sat
 * exactly N levels under `<body>` — which matched nothing, on the very version
 * it was recorded on (steps 5 and 6 of the gate bundle: both exactly at the
 * cap). A truncated path is now emitted unanchored, as the descendant suffix it
 * actually is.
 *
 * ## The anchored candidate (`css_vocab`)
 *
 * An element with no accessible name of its own (Grafana's panel-title input)
 * had only that structural path to go on. The nearest ancestor carrying an
 * `aria-label` is usually a product-vocabulary landmark ("Options group Panel
 * options"); a short path from it survives layout changes elsewhere on the page
 * that break a body-rooted path. Emitted as `css_vocab`, tenant-scoped like
 * every other label-derived candidate — an ancestor label can be tenant text,
 * and the compiler's `looksLikeTenantSelector` screen decides poolability.
 */

interface ElementLocatorSignals {
  role: string | null;
  accessibleName: string | null;
  label: string | null;
  testid: string | null;
  placeholder: string | null;
  text: string | null;
  structuralPath: string;
  anchoredPath: string | null;
}

function truncate(s: string | null | undefined, max = 80): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Built at runtime so tsx/esbuild cannot inject `__name` into the browser VM. */
const EXTRACT_LOCATOR_SIGNALS = new Function(
  "el",
  `
    const implicitRole = () => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "a" && el.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "input") {
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        if (type === "password" || type === "email" || type === "text" || type === "search" || type === "")
          return "textbox";
      }
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (["h1","h2","h3","h4","h5","h6"].includes(tag)) return "heading";
      return el.getAttribute("role");
    };
    const labelledBy = el.getAttribute("aria-labelledby");
    let labelText = null;
    if (labelledBy) {
      labelText = labelledBy.split(/\\s+/).map((id) => {
        const node = document.getElementById(id);
        return node ? (node.textContent || "") : "";
      }).join(" ").trim();
    }
    if (!labelText && el.labels && el.labels.length) {
      labelText = Array.from(el.labels).map((l) => l.textContent || "").join(" ").trim();
    }
    if (!labelText) labelText = el.getAttribute("aria-label");
    const accessibleName =
      el.getAttribute("aria-label") || labelText || el.placeholder ||
      (el.textContent || "").trim() || null;
    const MAX_PATH_DEPTH = 12;
    const MAX_ANCHOR_DEPTH = 8;
    const step = (node, parent) => {
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tag);
      const idx = sameTag.indexOf(node) + 1;
      return sameTag.length > 1 ? tag + ":nth-of-type(" + idx + ")" : tag;
    };
    const pathParts = [];
    let cur = el;
    while (cur && cur !== document.body && pathParts.length < MAX_PATH_DEPTH) {
      const parent = cur.parentElement;
      if (!parent) break;
      pathParts.unshift(step(cur, parent));
      cur = parent;
    }
    // Reached <body> (or the root) only if the walk was not cut off by the cap.
    const reachedBody = !cur || cur === document.body;

    // Nearest labelled ancestor, and the short relative path down to el.
    let anchoredPath = null;
    {
      const rel = [];
      let node = el;
      while (node.parentElement && node.parentElement !== document.body && rel.length < MAX_ANCHOR_DEPTH) {
        const parent = node.parentElement;
        rel.unshift(step(node, parent));
        const label = parent.getAttribute("aria-label");
        if (label) {
          const quoted = label.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
          anchoredPath = '[aria-label="' + quoted + '"] > ' + rel.join(" > ");
          break;
        }
        node = parent;
      }
    }
    return {
      role: el.getAttribute("role") || implicitRole(),
      accessibleName,
      label: labelText,
      testid: el.getAttribute("data-testid"),
      placeholder: el.getAttribute("placeholder"),
      text: (el.textContent || "").trim().slice(0, 120) || null,
      structuralPath: !pathParts.length ? "body"
        : reachedBody ? "body > " + pathParts.join(" > ")
        : pathParts.join(" > "),
      anchoredPath,
    };
  `,
) as (el: unknown) => ElementLocatorSignals;

export async function collectLocatorCandidates(
  locator: Locator,
): Promise<LocatorCandidate[]> {
  const signals = (await locator.evaluate(EXTRACT_LOCATOR_SIGNALS)) as ElementLocatorSignals;

  const candidates: LocatorCandidate[] = [];
  let rank = 1;
  // Handing out ranks through a closure keeps the counter correct however many
  // candidates end up being pushed, including the last one.
  const nextRank = () => rank++;
  const name = truncate(signals.accessibleName);
  const label = truncate(signals.label);
  const text = truncate(signals.text);
  const placeholder = truncate(signals.placeholder);

  if (signals.role && name) {
    candidates.push({
      strategy: "role_name",
      rank: nextRank(),
      role: signals.role,
      name,
      tenant_scoped: true,
    });
  }
  if (label) {
    candidates.push({ strategy: "label", rank: nextRank(), label, tenant_scoped: true });
  }
  if (signals.testid) {
    candidates.push({
      strategy: "testid",
      rank: nextRank(),
      testid: signals.testid,
      tenant_scoped: false,
    });
  }
  if (signals.anchoredPath) {
    candidates.push({
      strategy: "css_vocab",
      rank: nextRank(),
      css: signals.anchoredPath,
      tenant_scoped: true,
    });
  }
  candidates.push({
    strategy: "structural",
    rank: nextRank(),
    structural_path: signals.structuralPath,
    tenant_scoped: false,
  });
  if (text && text !== name && text !== label) {
    candidates.push({ strategy: "text", rank: nextRank(), text, tenant_scoped: true });
  }
  if (placeholder) {
    candidates.push({
      strategy: "placeholder",
      rank: nextRank(),
      name: placeholder,
      tenant_scoped: true,
    });
  }
  return candidates;
}
