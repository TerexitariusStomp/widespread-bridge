// judge/ — science-current verifier layer (see SCIENCE.md).
// Findings → mechanisms:
//  TNR<25%: judges approve slop → minority-veto panel (exists in adjudicator)
//  pairwise flips 35% on distractors vs 9% absolute → rank by absolute rubric
//  position bias → order-swap when comparisons are unavoidable
//  verbosity bias → observable length normalization
//  uncalibrated confidence → per-model rolling accuracy, Platt-style adjust
//  slop economics → rolling FP-rate claim cost (no blanket bond)
//  dedupe before judges (Hai Triage) → content-hash + similarity pre-check
import type { Env } from "../types";

/** Absolute rubric: score one submission 0-100 against the spec.
 * Absolute scoring resists distractor-feature manipulation (arxiv 2504.14716). */
export const ABSOLUTE_RUBRIC = `Score this submission against the acceptance spec on a 0-100 absolute scale.
Penalize length beyond what the spec requires — padding is not quality.
Return JSON only: {"score": <0-100>, "verdict": "accept"|"reject", "reasoning": "<2 sentences citing concrete evidence>"}`;

/** Order-swap: run the prompt with content in both orders, average the
 * result — cancels position bias (Verdict-Bench 2025). */
export function orderSwapped(contents: [string, string]): [string, string][] {
  return [contents, [contents[1], contents[0]]];
}

/** Verbosity correction: normalize a raw score by the deliverable's length
 * vs the spec's expectation — observable, not learned. */
export function verbosityAdjust(score: number, text: string, specMaxLen?: number): number {
  const len = text.length;
  const cap = specMaxLen ?? 4000;
  if (len <= cap) return score;
  const over = Math.log(len / cap) / Math.log(10);           // decades over cap
  return Math.max(0, score - Math.min(20, over * 15));       // ≤20pt penalty
}

/** Rolling FP-rate claim cost: claimants with high recent reject rate pay a
 * small escalating cost, refunded on accept. Window (last N=10), not lifetime
 * — reinsertion is always possible. Stays permissionless: no blanket bond. */
const FP_WINDOW = 10;
export async function claimCost(env: Env, actor: string): Promise<{ cost: string; window_rejects: number; window_total: number }> {
  const rec = (await env.CLAIMS.get(`fprate:${actor}`, "json").catch(() => null)) as { rejects?: number[] } | null;
  const w = (rec?.rejects ?? []).slice(-FP_WINDOW);
  const total = w.length, rejects = w.reduce((a, b) => a + b, 0);
  const rate = total >= 3 ? rejects / total : 0;
  const cost = rate <= 0.3 ? "0" : (0.5 * (rate - 0.3) * 10).toFixed(2); // $0 → $3.50 max
  return { cost, window_rejects: rejects, window_total: total };
}
export async function recordOutcome(env: Env, actor: string, accepted: boolean): Promise<void> {
  const rec = (await env.CLAIMS.get(`fprate:${actor}`, "json").catch(() => null)) as { rejects?: number[] } | null;
  const rejects = [...(rec?.rejects ?? []), accepted ? 0 : 1].slice(-FP_WINDOW);
  await env.CLAIMS.put(`fprate:${actor}`, JSON.stringify({ rejects }));
}

/** Content dedupe — exact hash + n-gram jaccard vs other submissions on the
 * market. Exact dupes reject free; near-dupes compete on earliest timestamp. */
const grams = (s: string, n = 5) => { const out = new Set<string>(); const w = s.toLowerCase().replace(/\s+/g, " "); for (let i = 0; i <= w.length - n; i++) out.add(w.slice(i, i + n)); return out; };
const jaccard = (a: Set<string>, b: Set<string>) => { let i = 0; for (const g of a) if (b.has(g)) i++; return i / (a.size + b.size - i || 1); };

export async function dedupe(env: Env, marketId: string, contentHash: string, text: string): Promise<{ dup: "exact" | "near" | null; similarity: number }> {
  const seen = (await env.CLAIMS.get(`subs:${marketId}`, "json").catch(() => null)) as { hash: string; text: string }[] | null ?? [];
  if (seen.some((s) => s.hash === contentHash)) return { dup: "exact", similarity: 1 };
  const g = grams(text);
  let best = 0;
  for (const s of seen) best = Math.max(best, jaccard(g, grams(s.text)));
  if (seen.length >= 50) seen.shift();
  seen.push({ hash: contentHash, text: text.slice(0, 4000) });
  await env.CLAIMS.put(`subs:${marketId}`, JSON.stringify(seen));
  return { dup: best > 0.85 ? "near" : null, similarity: best };
}

/** Per-model calibration: track rolling accuracy vs outcomes; adjust raw
 * confidence by the model's observed calibration factor (Platt-lite). */
export async function calibratedConfidence(env: Env, model: string, raw: number): Promise<number> {
  const cal = (await env.CLAIMS.get(`jcal:${model}`, "json").catch(() => null)) as { n?: number; ece?: number } | null;
  const bias = cal?.ece ?? 0;
  return Math.max(0, Math.min(1, raw - bias));
}
export async function recordJudgeOutcome(env: Env, model: string, confidence: number, correct: boolean): Promise<void> {
  const cal = (await env.CLAIMS.get(`jcal:${model}`, "json").catch(() => null)) as { n?: number; ece?: number } | null;
  const n = (cal?.n ?? 0) + 1;
  const err = Math.abs(confidence - (correct ? 1 : 0));
  const ece = ((cal?.ece ?? 0) * (n - 1) + err) / n;
  await env.CLAIMS.put(`jcal:${model}`, JSON.stringify({ n, ece }));
}
