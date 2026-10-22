/**
 * Write-time privacy enforcement for the trajectory cache.
 * Sources: Wave pack Agent B5; contracts/cache-row.schema.json.
 */

import { isChromeName, isTemplateOnly } from "./allowlist.js";
import type { CacheStore } from "./store.js";
import { checkLocatorTaint, createTaintChecker, type TaintRule } from "./taint.js";
import type {
  AssertionLike,
  CacheRow,
  CacheRowCandidate,
  CompiledLocator,
  PoolIneligibleReason,
} from "./types.js";

export class CacheWriteRejectedError extends Error {
  readonly code = "CACHE_WRITE_REJECTED" as const;
  constructor(
    message: string,
    readonly reason: PoolIneligibleReason | "pool_leak_refused",
  ) {
    super(message);
    this.name = "CacheWriteRejectedError";
  }
}

export interface WriteLogSink {
  info?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

export interface WriteOptions {
  store?: CacheStore;
  log?: WriteLogSink;
  taintRules?: readonly TaintRule[];
  failClosed?: boolean;
}

function taintChecker(options?: WriteOptions) {
  if (options?.taintRules) return createTaintChecker(options.taintRules);
  return checkLocatorTaint;
}

function assertionHasTenantLiteral(assertion: AssertionLike): boolean {
  const expected = assertion.expected;
  if (expected?.template) {
    const t = expected.template;
    const withoutHoles = t.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "").trim();
    if (
      withoutHoles.length > 0 &&
      !isChromeName(withoutHoles) &&
      !isTemplateOnly(t) &&
      !isChromeName(t)
    ) {
      return true;
    }
  }
  const loc = assertion.target?.locator;
  if (loc && checkLocatorTaint(loc).tainted) return true;
  const stripped = JSON.stringify(assertion).replace(/\{[^}]+\}/g, "");
  return /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(stripped);
}

function classifyLocators(
  chain: CompiledLocator[],
  check: (l: CompiledLocator) => ReturnType<typeof checkLocatorTaint>,
) {
  const poolSafe: CompiledLocator[] = [];
  const tenantOnly: CompiledLocator[] = [];
  const reasons = new Set<PoolIneligibleReason>();
  for (const loc of chain) {
    const result = check(loc);
    if (result.tainted) {
      tenantOnly.push({ ...loc, tenant_scoped: true });
      if (result.reasons.includes("non_vocab_attr")) reasons.add("tainted_attribute");
      else if (result.reasons.includes("non_vocab_role")) reasons.add("non_vocab_role");
      else reasons.add("tenant_locator_text");
    } else {
      poolSafe.push({ ...loc, tenant_scoped: false });
    }
  }
  return { poolSafe, tenantOnly, reasons: [...reasons] };
}

/**
 * Every locator a row carries: its pre-actions' (ADR-0024), then its action's.
 * The pool checks below walk this, so a pre-action is held to exactly the
 * boundary `compiled_action` is.
 */
function allLocators(row: CacheRow): CompiledLocator[] {
  return [
    ...(row.pre_actions ?? []).flatMap((a) => a.locator_fallback_chain),
    ...row.compiled_action.locator_fallback_chain,
  ];
}

/**
 * Pool-safe chains for a candidate's pre-actions, or the reason the row cannot
 * be pooled (ADR-0024).
 *
 * A pre-action that had locators and keeps none cannot run from the pool. The
 * row then cannot be pooled at all: a sequence missing an action replays a
 * different task. There is no topology fallback here, unlike `compiled_action`,
 * because a step's topology describes its own action, not the ones before it.
 * A pre-action recorded with no locators (`press`, `navigate`) keeps none.
 */
function poolPreChains(
  candidate: CacheRowCandidate,
  check: (l: CompiledLocator) => ReturnType<typeof checkLocatorTaint>,
): { chains: CompiledLocator[][]; refused?: PoolIneligibleReason } {
  const chains: CompiledLocator[][] = [];
  for (const action of candidate.pre_actions ?? []) {
    const { poolSafe, reasons } = classifyLocators(action.locator_fallback_chain, check);
    if (action.locator_fallback_chain.length > 0 && poolSafe.length === 0) {
      return { chains: [], refused: reasons[0] ?? "other" };
    }
    chains.push(poolSafe);
  }
  return { chains };
}

function finalize(
  candidate: CacheRowCandidate,
  chain: CompiledLocator[],
  poolEligible: boolean,
  reason: PoolIneligibleReason | null,
  options?: WriteOptions,
  preChains: CompiledLocator[][] = [],
): CacheRow {
  const row: CacheRow = {
    schema_version: "1.0.0",
    row_id: candidate.row_id,
    site_key: candidate.site_key,
    task_key: candidate.task_key,
    step_index: candidate.step_index,
    compiled_action: {
      ...candidate.compiled_action,
      locator_fallback_chain: chain,
    },
    assertion: JSON.parse(JSON.stringify(candidate.assertion)) as AssertionLike,
    confidence: candidate.confidence,
    success_count: candidate.success_count,
    failure_count: candidate.failure_count,
    last_verified_at: candidate.last_verified_at,
    pool_eligible: poolEligible,
    pool_ineligible_reason: poolEligible ? null : reason,
  };
  if (candidate.flow_topology) row.flow_topology = { ...candidate.flow_topology };
  // ADR-0024. Each pre-action gets the chain its caller classified for it, and
  // an empty one when none was given, which is what a refused row needs.
  if (candidate.pre_actions && candidate.pre_actions.length > 0) {
    row.pre_actions = candidate.pre_actions.map((a, i) => ({
      ...a,
      locator_fallback_chain: preChains[i] ?? [],
    }));
  }
  // finalize() builds the row explicitly rather than spreading, so anything the
  // update path sets has to be carried here or writeCacheRow — the only writer —
  // would silently drop it (ADR-0009).
  //
  // `program` is the ADR-0013 case, and dropping it would be quiet in the worst
  // way: every confidence rewrite would strip a row's program identity, so a
  // task would become unresolvable precisely *because* it had been replayed
  // successfully. Carried through unchanged — a rewrite changes what a step
  // does, never which program it belongs to.
  if (candidate.program) row.program = { ...candidate.program };
  if (candidate.invalidated_at !== undefined) {
    row.invalidated_at = candidate.invalidated_at;
  }
  if (candidate.repair_provenance) {
    row.repair_provenance = { ...candidate.repair_provenance };
  }

  if (row.pool_eligible) {
    for (const loc of allLocators(row)) {
      if (loc.tenant_scoped === true && options?.failClosed !== false) {
        throw new CacheWriteRejectedError(
          "pool_eligible row must not include tenant_scoped locators",
          "pool_leak_refused",
        );
      }
      if (loc.strategy === "text") {
        throw new CacheWriteRejectedError(
          "pool_eligible row must not include free-text locators",
          "tenant_locator_text",
        );
      }
    }
  }
  return row;
}

export function buildPoolRow(
  candidate: CacheRowCandidate,
  options?: WriteOptions,
): CacheRow {
  const check = taintChecker(options);
  const { poolSafe, reasons } = classifyLocators(
    candidate.compiled_action.locator_fallback_chain,
    check,
  );
  if (assertionHasTenantLiteral(candidate.assertion)) {
    return finalize(candidate, [], false, "literal_in_assertion", options);
  }
  const pre = poolPreChains(candidate, check);
  if (pre.refused !== undefined) {
    return finalize(candidate, [], false, pre.refused, options);
  }
  if (poolSafe.length > 0) {
    return finalize(candidate, poolSafe, true, null, options, pre.chains);
  }
  if (candidate.flow_topology) {
    return finalize(
      candidate,
      [{ strategy: "topology_only", tenant_scoped: false }],
      true,
      null,
      options,
      pre.chains,
    );
  }
  return finalize(candidate, [], false, reasons[0] ?? "other", options);
}

export function buildTenantRow(
  candidate: CacheRowCandidate,
  options?: WriteOptions,
): CacheRow {
  const check = taintChecker(options);
  const { poolSafe, tenantOnly, reasons } = classifyLocators(
    candidate.compiled_action.locator_fallback_chain,
    check,
  );
  const chain = [
    ...poolSafe.map((l) => ({ ...l, tenant_scoped: false })),
    ...tenantOnly,
  ];
  // The tenant row keeps every pre-action locator, tainted ones marked, as
  // it does for `compiled_action`.
  const preChains = (candidate.pre_actions ?? []).map((a) => {
    const c = classifyLocators(a.locator_fallback_chain, check);
    return [...c.poolSafe, ...c.tenantOnly];
  });
  let reason: PoolIneligibleReason = reasons[0] ?? "other";
  if (assertionHasTenantLiteral(candidate.assertion)) reason = "literal_in_assertion";
  else if (tenantOnly.length > 0 && poolSafe.length === 0) reason = "topology_only_degraded";
  return finalize(candidate, chain, false, reason, options, preChains);
}

export function writeCacheRow(
  candidate: CacheRowCandidate,
  options?: WriteOptions,
): CacheRow {
  const failClosed = options?.failClosed !== false;
  const poolRow = buildPoolRow(candidate, options);
  if (candidate.pool_eligible === true && !poolRow.pool_eligible) {
    throw new CacheWriteRejectedError(
      "caller requested pool_eligible=true but row failed allowlist/taint checks",
      poolRow.pool_ineligible_reason ?? "other",
    );
  }
  if (poolRow.pool_eligible && failClosed) {
    for (const loc of allLocators(poolRow)) {
      const t = taintChecker(options)(loc);
      if (t.tainted) {
        throw new CacheWriteRejectedError(
          `pool write refused: locator still tainted (${t.rulesFired.join(",")})`,
          "pool_leak_refused",
        );
      }
    }
    if (assertionHasTenantLiteral(poolRow.assertion)) {
      throw new CacheWriteRejectedError(
        "pool write refused: assertion contains tenant literal",
        "literal_in_assertion",
      );
    }
  }
  options?.log?.info?.("cache.write", {
    row_id: poolRow.row_id,
    site_key: poolRow.site_key,
    task_key: poolRow.task_key,
    step_index: poolRow.step_index,
    pool_eligible: poolRow.pool_eligible,
    pool_ineligible_reason: poolRow.pool_ineligible_reason ?? null,
    locator_count: poolRow.compiled_action.locator_fallback_chain.length,
  });
  options?.store?.write(poolRow);
  return poolRow;
}

export function writeCacheRowPair(
  candidate: CacheRowCandidate,
  options?: WriteOptions,
): { pool: CacheRow; tenant: CacheRow } {
  const pool = writeCacheRow(candidate, options);
  const tenant = buildTenantRow(candidate, options);

  // The tenant row is persisted too, and only from here — the store routes it
  // to the tenant file on `pool_eligible: false` (src/cache/store.ts). Before
  // #63 nothing wrote it anywhere, so "keep the two apart all the way to disk"
  // was vacuously true: only one of them ever reached a store.
  //
  // This is still the gatekeeper path. `pool` went through writeCacheRow's
  // fail-closed checks above; `tenant` is by construction not pool-eligible, so
  // those checks do not apply to it — it is the row that is *allowed* to carry
  // tenant-scoped locators. What must never happen is a tenant row reaching the
  // pool file, and that is the store's routing rule, asserted from disk in
  // tests/canary/store-leak.test.ts.
  if (tenant.pool_eligible) {
    throw new CacheWriteRejectedError(
      "buildTenantRow produced a pool_eligible row; refusing to persist it",
      "pool_leak_refused",
    );
  }
  options?.log?.info?.("cache.write.tenant", {
    row_id: tenant.row_id,
    site_key: tenant.site_key,
    task_key: tenant.task_key,
    step_index: tenant.step_index,
    pool_eligible: false,
    pool_ineligible_reason: tenant.pool_ineligible_reason ?? null,
    locator_count: tenant.compiled_action.locator_fallback_chain.length,
  });
  options?.store?.write(tenant);

  return { pool, tenant };
}
