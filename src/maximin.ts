// maximin.ts — MORE maximin matching pool (docs/more-alignment.md Phase 6,
// Stage C). The DAO fee sink becomes a matching fund that multiplies
// small funders' bounties in the least-funded capacity dimension — W's
// min-term in production. Scarcity is measured from declared-market
// stats; the pool subsidizes, never taxes.
//
// This module is the selector + ledger. The PotLock pot wiring (NEAR
// donation contracts, MIT) is the money leg — flagged in OSS-LEDGER;
// until wired, matches are recorded entitlements ops can honor.

import type { Env, CapacityDim } from "./types";

const DIMS: CapacityDim[] = ["C_e", "C_h", "C_k", "C_inst", "C_m"];
const statsKey = "pool:funded";

interface DimStats { count: number; amount: number }
type PoolStats = Partial<Record<CapacityDim, DimStats>>;

async function loadStats(env: Env): Promise<PoolStats> {
  return (await env.CLAIMS.get<PoolStats>(statsKey, "json")) ?? {};
}

/** Record declared funding toward each claimed dim. Called from
 *  bountyDeclare — every market is capacity-tagged, so the scarcity
 *  signal is complete by construction. */
export async function recordFunding(env: Env, dims: CapacityDim[], amount: string): Promise<void> {
  const stats = await loadStats(env);
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return;
  for (const d of dims) {
    const s = (stats[d] ??= { count: 0, amount: 0 });
    s.count += 1; s.amount += n;
  }
  await env.CLAIMS.put(statsKey, JSON.stringify(stats));
}

/** The least-funded declared dimension — the maximin target. Ties break
 *  toward the earlier dim in canonical order (deterministic). */
export function leastFunded(stats: PoolStats): CapacityDim {
  let best: CapacityDim = DIMS[0];
  let bestAmt = Infinity;
  for (const d of DIMS) {
    const amt = stats[d]?.amount ?? 0;
    if (amt < bestAmt) { bestAmt = amt; best = d; }
  }
  return best;
}

/** Suggested match multiplier for a declaration: markets tagged with
 *  the least-funded dim get the subsidy hint. Advisory — the pot
 *  contract is the enforcement. */
export function matchHint(stats: PoolStats, dims: CapacityDim[]): {
  least_funded_dim: CapacityDim; matched: boolean; match_bps: number;
} {
  const least = leastFunded(stats);
  const matched = dims.includes(least);
  // Subsidy scales inversely with how far ahead the dim is — capped so
  // the pool stays a matching fund, not a money pump.
  const total = DIMS.reduce((n, d) => n + (stats[d]?.amount ?? 0), 0) || 1;
  const share = (stats[least]?.amount ?? 0) / total;
  const match_bps = matched ? Math.min(500, Math.round(500 * (1 - share * DIMS.length))) : 0;
  return { least_funded_dim: least, matched, match_bps };
}

export async function matchFor(env: Env, dims: CapacityDim[]) {
  return matchHint(await loadStats(env), dims);
}

export async function poolStatus(env: Env) {
  const stats = await loadStats(env);
  return {
    dims: Object.fromEntries(DIMS.map((d) => [d, stats[d] ?? { count: 0, amount: 0 }])),
    least_funded_dim: leastFunded(stats),
    note: "advisory matching — PotLock pot wiring pending (OSS-LEDGER §Phase 6)",
  };
}
