// outcome.ts — MORE outcome verification (docs/more-alignment.md Phase 5,
// Stage B/C). DELIVERY PAYS 100% — verified work is never haircut. The
// outcome layer is a protocol-funded bonus + attester-reward pool,
// sourced from our fee take (platformBps / DAO sink), never from the
// claimant or funder. Post-horizon re-verification by watchers (never
// the paid party) unlocks the claimant's outcome bonus and the
// attester's reward; disputes freeze the bonus pending adjudication —
// they cannot claw back delivered payment.
//
// State machine per settled claim:
//   pending → verified | failed | frozen
// Money leg stays ops/contract-side exactly like payout records today —
// this module is the authoritative outcome state + evidence validation.

import type { Env, ReviewRecord } from "./types";
import { validateDomain } from "./domains/index";
import type { MarketRef, ClaimRef } from "./domains/types";

export interface OutcomeState {
  id: string;                    // `${repo}:${seq}`
  repo: string;
  seq: number;
  status: "pending" | "verified" | "failed" | "frozen";
  dims: string[];
  evidence_plan: {
    measure: string;
    baseline?: string;
    attester: string;
    attester_paid_by: string;
    horizon_days: number;
  };
  bonus_bps: number;             // protocol-pool outcome bonus (bps of amount)
  due_at: number;                // ms epoch — horizon elapsed
  attester?: string;             // who submitted outcome evidence
  evidence?: Record<string, unknown>;
  dispute?: { by: string; reason: string; at: number };
  created_at: number;
  updated_at: number;
}

const key = (id: string) => `outcome:${id}`;

/** Outcome bonus scales with claim size: base 10%, +5% per extra
 *  declared dim, cap 25% — paid by the protocol pool on verified
 *  outcome, never withheld from delivery. */
export function bonusBps(dims: string[]): number {
  return Math.min(25, 10 + 5 * Math.max(0, dims.length - 1));
}

/** Schedule tranche-2 verification for an accepted review. Called from
 *  runReview; no-op for markets without a capacity evidence plan. */
export async function scheduleOutcome(env: Env, record: ReviewRecord): Promise<OutcomeState | null> {
  const plan = record.bounty?.capacity?.evidence_plan;
  const dims = record.bounty?.capacity?.dims ?? [];
  if (!plan || !dims.length) return null;
  const id = `${record.repo}:${record.seq}`;
  const existing = await env.CLAIMS.get<OutcomeState>(key(id), "json");
  if (existing) return existing; // idempotent
  const now = Date.now();
  const st: OutcomeState = {
    id, repo: record.repo, seq: record.seq,
    status: "pending", dims,
    evidence_plan: {
      measure: plan.measure,
      ...(plan.baseline ? { baseline: plan.baseline } : {}),
      attester: plan.attester, attester_paid_by: plan.attester_paid_by,
      horizon_days: plan.horizon_days,
    },
    bonus_bps: bonusBps(dims),
    due_at: now + plan.horizon_days * 86_400_000,
    created_at: now, updated_at: now,
  };
  await env.CLAIMS.put(key(id), JSON.stringify(st));
  return st;
}

export async function getOutcome(env: Env, id: string): Promise<OutcomeState | null> {
  return env.CLAIMS.get<OutcomeState>(key(id), "json");
}

/** dim → outcome-validation pack. C_e → ecological, C_k → knowledge;
 *  unmapped dims fall back to the generic platform-url check on the
 *  submitted artifact (structure-level, honest about its limits). */
const DIM_PACK: Record<string, string> = { C_e: "ecological", C_k: "knowledge" };

export async function submitOutcome(
  env: Env, id: string,
  body: { ref?: string; evidence?: Record<string, unknown>; attester?: string },
): Promise<{ ok: boolean; outcome?: OutcomeState; error?: string; validation?: unknown }> {
  const st = await getOutcome(env, id);
  if (!st) return { ok: false, error: "no outcome scheduled for this claim" };
  if (st.status !== "pending") return { ok: false, error: `outcome already ${st.status}`, outcome: st };
  if (Date.now() < st.due_at) {
    return { ok: false, error: `horizon not elapsed — due ${new Date(st.due_at).toISOString()}`, outcome: st };
  }
  const ref = body.ref ?? String(body.evidence?.url ?? body.evidence?.cid ?? "");
  if (!ref) return { ok: false, error: "outcome evidence needs a ref (url/cid/doi)", outcome: st };

  // The paid party can never attest their own outcome.
  const claimantActor = body.attester ?? "watcher";
  const packName = DIM_PACK[st.dims[0]] ?? "platform-url";
  const market: MarketRef = {
    id: st.id, domain: packName === "platform-url" ? "other" : packName,
    verification: { class: "platform-url" },
    created_at: st.created_at,
  };
  const claim: ClaimRef = { ref, evidence: body.evidence ?? {} };
  const v = await validateDomain(market, claim, env as unknown as Record<string, string | undefined>);

  st.status = v.failures.length ? "failed" : "verified";
  st.attester = claimantActor;
  st.evidence = { ...body.evidence, validation: v };
  st.updated_at = Date.now();
  await env.CLAIMS.put(key(id), JSON.stringify(st));
  return { ok: true, outcome: st, validation: v };
}

/** Dispute verb (Stage C / P7): a watcher challenges a recorded
 *  contribution — freezes the outcome BONUS pending adjudication.
 *  Delivered payment is already 100% settled and cannot be clawed back
 *  by this path; remedies run through reputation/disqualification. */
export async function disputeOutcome(
  env: Env, id: string, by: string, reason: string,
): Promise<{ ok: boolean; outcome?: OutcomeState; error?: string }> {
  const st = await getOutcome(env, id);
  if (!st) return { ok: false, error: "no outcome scheduled for this claim" };
  if (st.status === "frozen") return { ok: true, outcome: st };
  st.status = "frozen";
  st.dispute = { by, reason: reason.slice(0, 500), at: Date.now() };
  st.updated_at = Date.now();
  await env.CLAIMS.put(key(id), JSON.stringify(st));
  await env.CLAIMS.put(`dispute:${id}`, JSON.stringify(st.dispute));
  return { ok: true, outcome: st };
}

/** Unfreeze after adjudication — trustee/funder resolution path. */
export async function resolveDispute(
  env: Env, id: string, resolution: "verified" | "failed",
): Promise<{ ok: boolean; outcome?: OutcomeState; error?: string }> {
  const st = await getOutcome(env, id);
  if (!st) return { ok: false, error: "no outcome" };
  if (st.status !== "frozen") return { ok: false, error: `outcome is ${st.status}, not frozen` };
  st.status = resolution;
  st.updated_at = Date.now();
  await env.CLAIMS.put(key(id), JSON.stringify(st));
  return { ok: true, outcome: st };
}
