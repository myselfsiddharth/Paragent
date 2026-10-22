/**
 * The repair model's context budget (ADR-0012, issue #125).
 *
 * `RepairContext.page_state` used to be exactly one thing: `url`, `title`,
 * `network_idle`, and a list of ARIA **landmark role names** — `["main",
 * "navigation"]`. The task set for the model was: given a failed locator, a
 * URL, a title and the string `"main"`, produce a corrected locator that
 * resolves on a page it cannot see.
 *
 * That is not a hard task, it is an underdetermined one. #125's argument is the
 * reason this module exists: on a cache miss the system pays replay **plus**
 * repair **plus** the fresh run it still has to do, so a repair that reliably
 * fails is worse than never having cached. And PRD §9's kill line is a *ratio*
 * — `mean repair cost ≥ 70% of fresh` — so a structurally impossible repair
 * does not merely score badly, it pushes the project toward FAIL for a reason
 * that is a design parameter rather than a property of the thesis under test.
 *
 * ## The levels
 *
 * | Level | Adds | Status |
 * | --- | --- | --- |
 * | `landmarks` | landmark role names | the pre-#125 behaviour, kept as the floor |
 * | `interactive` | role + accessible name of interactive elements | **the chosen default** |
 * | `tree` | the above, plus non-interactive structure, values stripped | available, not default |
 *
 * A fourth level — a DOM excerpt with allowlisted attributes — was considered
 * and **rejected** in ADR-0012 rather than left unimplemented-but-blessed. See
 * that ADR for why; the short version is that it is the first level whose
 * output cannot be reviewed by reading a fixed field list.
 *
 * ## What every level excludes, unconditionally
 *
 * No text content, no input values, no attribute values other than the
 * allowlisted structural ones, no cookies, no storage. The capture reads
 * `role`, accessible `name`, and a small set of state flags — and an element's
 * *value* is never read, at any level, which is what keeps a filled password
 * field from becoming context. `stripValues` is not a setting.
 *
 * ## Why a JS source string
 *
 * Same reason as `src/shared/landmarks.ts`, and the reason is load-bearing:
 * esbuild (through tsx and vitest) applies `keepNames`, which wraps named
 * function expressions in `__name(...)`. That helper does not exist in the
 * browser, so a serialized callback throws `ReferenceError: __name is not
 * defined` (PR #73). The shared unit is text, not a function.
 */

import { VISIBILITY_PREDICATE_JS } from "./landmarks.js";

/** Context levels, ordered by increasing capability and increasing exposure. */
export const CONTEXT_LEVELS = ["landmarks", "interactive", "tree"] as const;

export type ContextLevel = (typeof CONTEXT_LEVELS)[number];

/**
 * What a repair gets unless a caller says otherwise.
 *
 * `interactive` rather than `landmarks`: a corrected **locator** is a role plus
 * an accessible name, so a context carrying no role/name pairs cannot contain
 * the answer the model is asked to produce. At `landmarks` that is true by
 * construction — `elements` is empty — which is a property of the design, not a
 * measurement, and ADR-0012 states it that way.
 *
 * `interactive` rather than `tree`: measured on live Grafana 9.5.21
 * (ADR-0012), `tree` found **no target the `interactive` level did not** on
 * either page sampled, while adding 19% to the payload on `/dashboard/new` and
 * 63% on the home page. A repair proposes an action against something
 * actionable; non-interactive structure is orientation the model did not need
 * to locate any of the task's targets.
 */
export const DEFAULT_CONTEXT_LEVEL: ContextLevel = "interactive";

/** One interactive element, as the model is allowed to see it. */
export interface ContextElement {
  role: string;
  /** Accessible name. Never an input's value — see the module note. */
  name: string;
  /** Present only when the element is disabled/checked/expanded. */
  state?: string[];
  /**
   * Present only when the element is inside the open dialog in front of the
   * page (#212). A dialog's elements are listed before everything else, so the
   * 120-element cap can no longer fill up with the inert background first.
   */
  in_dialog?: true;
}

/**
 * Attributes the capture may read to compute a role or an accessible name.
 *
 * An allowlist rather than a denylist, and a short one: everything here is
 * structural or ARIA. `value`, `placeholder`, `title` and `alt` are absent on
 * purpose — each can carry user- or tenant-authored text, and `placeholder` in
 * particular is a real locator strategy the compiler uses, which makes it
 * tempting and wrong to include here.
 */
export const CONTEXT_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-disabled",
  "aria-checked",
  "aria-expanded",
  // #212: whether the open dialog makes everything behind it inert.
  "aria-modal",
  // #212: a content-derived name skips aria-hidden children, as the
  // accessible name does.
  "aria-hidden",
  "disabled",
  "type",
];

/**
 * Browser-side capture, as text.
 *
 * Returns `ContextElement[]`. Visibility is `VISIBILITY_PREDICATE_JS`,
 * interpolated from `landmarks.ts` rather than restated — a repair shown
 * elements the recorder never saw is the ADR-0007 bug in a new place, and a
 * second copy of the predicate is the #74 bug in a new place.
 *
 * That import is also why this file must not spell the DOM API name in prose:
 * `tests/unit/landmarks.test.ts` greps `src/` for it and asserts exactly one
 * carrier. The guard caught a real second copy here during #125 and then caught
 * this comment — narrow, but it is the narrowness that makes it hold.
 *
 * The `level` argument is interpolated by the caller, not read from scope: the
 * body is serialized into a page that has no access to this module.
 */
export function contextExpression(level: ContextLevel): string {
  // Interactive roles a repair could plausibly target. Deliberately not "every
  // element": a corrected action clicks, fills or selects something.
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=textbox]",
    "[role=combobox]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=switch]",
    "[role=option]",
  ].join(",");

  // Structural roles added at `tree`. Non-interactive, so they cannot be the
  // target of a corrected action — they are orientation only.
  const structuralSelector = [
    "[role=heading]",
    "h1",
    "h2",
    "h3",
    "[role=tablist]",
    "[role=dialog]",
    "[role=list]",
  ].join(",");

  const selector =
    level === "tree" ? `${interactiveSelector},${structuralSelector}` : interactiveSelector;

  // ADR-0021: controls built as a role-less <div aria-label> with a script click
  // handler. Grafana 9.5.21's visualization picker card ("Plugin visualization
  // item Stat") is one; it matched nothing above, so neither the repair model
  // nor the fresh baseline could ever see — or therefore target — it. They are
  // admitted only when they render as clickable (cursor: pointer), so labelled
  // layout wrappers such as "TestData series count" stay out. No new attribute
  // is read: aria-label was already the first source of every name here. They
  // are reported with their true ARIA role, "generic"; `resolveLocator` maps
  // role_name + generic to an exact label lookup, because getByRole("generic")
  // never matches a name.
  const labelledClickableSelector = "[aria-label]";

  // #212: an open dialog. Grafana 10.0.13's "Select data source" modal is
  // rendered at the end of the DOM, and in document order the editor's option
  // panes filled the 120-element cap first. The repair model was shown the
  // background and none of the dialog's 10 controls. So the frontmost visible
  // dialog's elements go first, each flagged `in_dialog`. When it is declared
  // modal (aria-modal, or a <dialog> opened with showModal()), the elements
  // behind it are inert and are dropped. A non-modal dialog only demotes them.
  // The one new attribute read is aria-modal, which is structural and on the
  // allowlist. A <dialog>'s `open` is only matched by the selector.
  const dialogSelector = "[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]";

  // A name read from content must be the name a locator will match. Raw
  // textContent was not: on Grafana 10.0.13 the data-source card reads
  // "Paragent TestData defaultTestData", while its accessible name is
  // "Paragent TestData Tags TestData", because the tag list's aria-label stands
  // in for its content and block-level children are separated by spaces. The
  // model proposed the name it was shown and no locator matched it. So text
  // names follow the accessible-name rules Playwright's role engine applies to
  // content: a labelled child contributes its aria-label, an aria-hidden or
  // undisplayed child contributes nothing, and a child that is not
  // display:inline is space-separated. No new source of text: it is the same
  // text nodes and the same allowlisted aria-label, now assembled correctly.
  const textNameJs = `const paragentTextName = (root) => {
      const parts = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) { parts.push(child.textContent || ""); continue; }
          if (child.nodeType !== 1) continue;
          if (child.getAttribute("aria-hidden") === "true") continue;
          const cs = getComputedStyle(child);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const spaced = cs.display !== "inline" || child.tagName === "BR";
          if (spaced) parts.push(" ");
          const label = child.getAttribute("aria-label");
          if (label) parts.push(label);
          else walk(child);
          if (spaced) parts.push(" ");
        }
      };
      walk(root);
      return parts.join("").replace(/\\s+/g, " ").trim();
    };`;

  return `(() => {
    if (${level === "landmarks" ? "true" : "false"}) return [];
    ${VISIBILITY_PREDICATE_JS}
    ${textNameJs}
    const out = [];
    const seen = new Set();
    const primary = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const primarySet = new Set(primary);
    const extra = Array.from(document.querySelectorAll(${JSON.stringify(labelledClickableSelector)}))
      .filter((el) => !primarySet.has(el) && !el.hasAttribute("role")
        && getComputedStyle(el).cursor === "pointer");
    const extraSet = new Set(extra);
    let candidates = primary.concat(extra)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    // Last in document order is the frontmost: portals append to the body, and
    // a dialog nested in another comes after its parent.
    const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(dialogSelector)}))
      .filter((el) => paragentIsVisible(el));
    const dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
    if (dialog) {
      let modal = dialog.getAttribute("aria-modal") === "true";
      if (!modal) {
        try { modal = dialog.matches(":modal"); } catch (e) { modal = false; }
      }
      const inside = candidates.filter((el) => dialog.contains(el));
      candidates = modal ? inside : inside.concat(candidates.filter((el) => !dialog.contains(el)));
    }
    for (const el of candidates) {
      if (!paragentIsVisible(el)) continue;

      // Role: explicit first, then a small implicit map. No text is read here.
      let role = el.getAttribute("role");
      if (!role && extraSet.has(el)) role = "generic";
      if (!role) {
        const tag = el.tagName.toLowerCase();
        if (tag === "a") role = "link";
        else if (tag === "button" || tag === "summary") role = "button";
        else if (tag === "select") role = "combobox";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "h1" || tag === "h2" || tag === "h3") role = "heading";
        else if (tag === "input") {
          const t = (el.getAttribute("type") || "text").toLowerCase();
          // The ARIA implicit roles Playwright's role engine uses. "textbox" for
          // every other type was a lie for number/range/search inputs: the gate
          // task's "Series count" is type=number (spinbutton), the model was told
          // textbox, and getByRole("textbox") never matched it — 19 of 30 turns
          // of a fresh-baseline attempt, spent on one field.
          role = t === "checkbox" ? "checkbox"
               : t === "radio" ? "radio"
               : t === "submit" || t === "button" || t === "reset" ? "button"
               : t === "number" ? "spinbutton"
               : t === "range" ? "slider"
               : t === "search" ? "searchbox"
               : "textbox";
        } else role = tag;
      }

      // Accessible name: aria-label, then the referenced label, then the
      // associated <label>, then trimmed text for elements whose name comes
      // from content. An input's VALUE is never read — that is the line this
      // capture does not cross, at any level.
      let name = el.getAttribute("aria-label") || "";
      if (!name) {
        const ref = el.getAttribute("aria-labelledby");
        if (ref) {
          const labelled = ref.split(/\\s+/).map((id) => {
            const n = document.getElementById(id);
            return n ? paragentTextName(n) : "";
          }).filter(Boolean).join(" ");
          if (labelled) name = labelled;
        }
      }
      if (!name && el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) name = paragentTextName(lab);
      }
      if (!name) {
        const closestLabel = el.closest("label");
        if (closestLabel) name = paragentTextName(closestLabel);
      }
      if (!name && (role === "button" || role === "link" || role === "heading" || role === "tab" || role === "menuitem" || role === "option")) {
        name = paragentTextName(el);
      }
      // ADR-0021: a control with no accessible name of its own takes the
      // aria-label of its nearest labelled container (Grafana's panel-title
      // input sits in "Panel options Title field property editor" and is
      // otherwise an indistinguishable textbox ""). Still aria-label only — the
      // allowlisted attribute every name here already comes from. Bounded, and
      // never for "generic" (those are named by their own label by definition).
      if (!name && role !== "generic") {
        let anc = el.parentElement;
        for (let depth = 0; anc && anc !== document.body && depth < 8; depth++, anc = anc.parentElement) {
          const label = anc.getAttribute("aria-label");
          if (label) { name = label; break; }
        }
      }
      name = name.replace(/\\s+/g, " ").trim().slice(0, 120);

      const state = [];
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") state.push("disabled");
      if (el.getAttribute("aria-checked") === "true") state.push("checked");
      if (el.getAttribute("aria-expanded") === "true") state.push("expanded");

      // Collapse duplicates: a list of forty identical "Delete" buttons tells
      // the model nothing it does not learn from one.
      const key = role + "\\u0000" + name;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = { role: role, name: name };
      if (state.length > 0) entry.state = state;
      if (dialog && dialog.contains(el)) entry.in_dialog = true;
      out.push(entry);
      if (out.length >= 120) break;
    }
    return out;
  })()`;
}
