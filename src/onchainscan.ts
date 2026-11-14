// onchainscan.ts — automated adjudication + settlement for on-chain
// markets. Removes the last human-required step in the money path:
// shipClaim'd attested claims get judged and voted on by this oracle
// seat without any operator action.
//
// The contract IS the substrate — its state is consensus-verified, so
// claims carry no forge hash-chain; `chain.checked: 0` honestly marks
// "no forge replay" and `commits.source: "unavailable"` marks evidence
// we didn't recompute. The judge sees the market spec + claim payload
// and fails closed to reject on thin evidence, same as the forge lane.
//
// Two jobs per scan:
//   1. markets: listOpen → pending ATTESTED claims we haven't voted on
//      → adjudicate → signVerdict → submitVerdict (+ release when our
//      vote completes the market's quorumM).
//   2. mirror payouts: won settlements with an escrowed market but no
//      payout tx → ops ships the winning claim on-chain and releases
//      as payer — replaces the old "a human runs release.js" queue.

import type { Env, Bounty, OpLogEntry, ChainVerification, CommitEvidence, Crosscheck, ShipClaim } from "./types";
import { nearFunctionCall, nearViewCall } from "./nearops";
import { oracleEnv, oracleVote, signVerdict, type OracleVoteResult } from "./oracle";
import { adjudicateContest } from "./adjudicator";
import { crosscheck, gatherCommitEvidence } from "./evidence";

const SCAN_MARKETS = 20;
const CLAIMS_PER_MARKET = 5;
const PAYOUTS_PER_SCAN = 5;
const GAS = BigInt("100000000000000");

function txFailed(status: unknown): boolean {
  return /EXECUTED_FAILURE|"Failure"|FunctionCallError|ActionError/.test(
    JSON.stringify(status ?? ""));
}

interface OnchainClaim {
  claimId: string; claimHash: string; actor?: string; commits?: string[];
  evidence?: Record<string, unknown>; claimant?: string; shippedBy?: string;
  attested?: boolean; status?: string; ts?: string;
}

interface OnchainMarket {
  marketId: string; payer: string; specHash: string; spec?: string;
  locked: string; deadline?: string | null; oracleQuorumM?: number; status: string;
  commitReveal?: boolean;
}

const voteKey = (marketId: string, claimId: string) => `ocv:${marketId}:${claimId}`;

async function judgedAlready(env: Env, marketId: string, claimId: string): Promise<boolean> {
  return !!(await env.CLAIMS.get(voteKey(marketId, claimId)));
}

async function putJudged(env: Env, marketId: string, claimId: string, rec: Record<string, unknown>): Promise<void> {
  await env.CLAIMS.put(voteKey(marketId, claimId), JSON.stringify({ ...rec, judged_at: Date.now() }));
}

/** Build the judge input for one on-chain claim. On-chain claims have no
 * forge chain to replay — the contract record is consensus-verified — so
 * the hash-chain field is an honest stub. Commit evidence IS replayed:
 * evidence.repo locates the upstream (github by convention) and each
 * claimed sha is diff-fetched so judges weigh real work, not bare hashes.
 * Without this the panel sees `unavailable` for every commit and fails
 * closed on all on-chain claims regardless of quality. */
async function onchainInput(env: Env, market: OnchainMarket, claim: OnchainClaim): Promise<{
  repo: string; entry: OpLogEntry; chain: ChainVerification;
  bounty: Bounty; commits: CommitEvidence[]; check: Crosscheck;
}> {
  const entry: OpLogEntry = {
    seq: Number(claim.claimId), hash: claim.claimHash, prev_hash: "",
    kind: "ship", actor: claim.actor ?? claim.shippedBy ?? "unknown",
    payload: { marketId: market.marketId, claimId: claim.claimId,
               evidence: claim.evidence ?? {}, commits: claim.commits ?? [] },
    created_at: claim.ts ? Math.floor(Number(claim.ts) / 1e6) : Date.now(),
  };
  const chain: ChainVerification = {
    valid: true, checked: 0, tip_hash: claim.claimHash,
    tip_seq: entry.seq, broken_at_seq: null,
  };
  // Repo locator: "owner/name" → github convention; a full URL passes through.
  const evRepo = typeof claim.evidence?.repo === "string" ? claim.evidence.repo : null;
  const upstream = evRepo
    ? /^https?:\/\//.test(evRepo) ? evRepo : `https://github.com/${evRepo}`
    : null;
  const repo = evRepo ?? `onchain:${market.marketId}`;
  const commits: CommitEvidence[] = upstream
    ? await Promise.all((claim.commits ?? []).map((sha) =>
        gatherCommitEvidence(env, repo, sha, upstream)
          .catch((): CommitEvidence => ({
            sha, source: "unavailable" as const, message: null, files: [],
            lines_added: 0, lines_removed: 0, diff_excerpt: null,
            evidence_url: null, patch_fingerprint: null,
          }))))
    : (claim.commits ?? []).map((sha) => ({
        sha, source: "unavailable" as const, message: null, files: [],
        lines_added: 0, lines_removed: 0, diff_excerpt: null,
        evidence_url: null, patch_fingerprint: null,
      }));
  // On-chain claims carry no self-reported files/lines — claimed_* stay null.
  const check = crosscheck({} as ShipClaim, commits);
  console.log(`onchainInput m${market.marketId}/c${claim.claimId}: repo=${repo} upstream=${upstream} commits=${JSON.stringify(commits.map((c) => ({ sha: c.sha.slice(0, 8), src: c.source, files: c.files.length, diff: c.diff_excerpt?.length ?? 0 })))}`);
  const bounty: Bounty = {
    repo: `onchain:${market.marketId}`,
    spec: market.spec ?? "",
    amount: market.locked, currency: "NEAR",
    receiver_account: claim.claimant ?? "",
    domain: "other", floor_flags: [],
    created_at: Number(market.marketId) || Date.now(),
  } as Bounty;
  return { repo: bounty.repo, entry, chain, bounty, commits, check };
}

export async function scanOnchain(env: Env): Promise<{ reviewed: number; voted: number }> {
  const oc = oracleEnv(env);
  if (!oc?.accountId || !oc.secretKey || !env.NEAR_CONTRACT) return { reviewed: 0, voted: 0 };
  const markets = (await nearViewCall(env, oc.contract, "listOpen", {})
    .catch(() => null)) as OnchainMarket[] | null;
  if (!Array.isArray(markets)) return { reviewed: 0, voted: 0 };

  const minConf = Number(env.MIN_CONFIDENCE ?? "0.6");
  // Contest candidate cap: bounds prompt size — and therefore inference
  // cost — regardless of how many pending claims a market attracts.
  const contestMax = Number((env as { CONTEST_MAX_CLAIMS?: string }).CONTEST_MAX_CLAIMS ?? CLAIMS_PER_MARKET);
  let reviewed = 0, voted = 0;
  for (const market of markets.slice(0, SCAN_MARKETS)) {
    // Confidential markets carry a stub spec — the judge can't weigh a
    // spec it can't read; those claims adjudicate through the sealed
    // claim lane where the funder's collective key opens them.
    if (market.spec?.startsWith("[confidential:")) continue;
    // Commit-reveal markets refuse submitVerdict — independent oracle
    // runners handle the blind lane; this seat skips them.
    if (market.commitReveal) continue;
    const bag = (await nearViewCall(env, oc.contract, "getClaims",
      { marketId: market.marketId, from: 0, limit: 50 }).catch(() => null)) as
      { claims?: OnchainClaim[] } | null;
    const candidates: OnchainClaim[] = [];
    for (const claim of bag?.claims ?? []) {
      if (claim.status !== "pending" || !claim.attested) continue;
      if (await judgedAlready(env, market.marketId, claim.claimId)) continue;
      candidates.push(claim);
      if (candidates.length >= contestMax) break;
    }
    if (!candidates.length) continue;
    reviewed += candidates.length;
    try {
      // One panel call per market: judges pick the single best claim,
      // matching the contract's winner-selection semantics — and one
      // verdict slot per seat per market on-chain.
      const inputs = await Promise.all(candidates.map((c) => onchainInput(env, market, c)));
      const adj = await adjudicateContest(env, inputs);
      const winner = adj.winnerIndex >= 0 ? candidates[adj.winnerIndex] : null;
      let res: OracleVoteResult | null = null;
      if (winner && adj.confidence >= minConf) {
        const { sig } = await signVerdict(oc, market.marketId, winner.claimHash,
          "accept", String(market.deadline ?? "")).catch(() => ({ sig: "", pubkey: "" }));
        res = await oracleVote(env, oc, {
          marketId: market.marketId, claimId: winner.claimId,
          verdict: "accept", verdictSig: sig || undefined,
        });
        if (res.voted) voted++;
      }
      for (const claim of candidates) {
        const isWinner = claim === winner;
        await putJudged(env, market.marketId, claim.claimId, {
          verdict: isWinner && res?.voted ? "accept"
            : winner ? "not-picked" : "none-acceptable",
          picked: winner?.claimId ?? null,
          confidence: adj.confidence, model: adj.model,
          reasoning: adj.reasoning?.slice(0, 1200),
          panel: (adj as { panel?: unknown }).panel ?? null,
          voted: isWinner ? res?.voted ?? false : false,
          released_tx: isWinner ? res?.released?.txHash ?? null : null,
          quorum_pending: isWinner ? res?.quorum_pending ?? false : false,
          error: isWinner ? res?.error ?? null : null,
        });
      }
    } catch (e) {
      for (const claim of candidates) {
        await putJudged(env, market.marketId, claim.claimId, {
          verdict: "error", error: String(e).slice(0, 200),
        });
      }
    }
  }
  return { reviewed, voted };
}

/** Auto-execute won mirror settlements: ship the winning claim on-chain
 * (ops as attesting relayer) then release as payer — the market's
 * escrow pays the winner's NEAR claimant with zero ops clicks. */
export async function scanMirrorPayouts(env: Env): Promise<number> {
  const acct = env.NEAR_OPS_ACCOUNT, key = env.NEAR_OPS_SECRET_KEY, contract = env.NEAR_CONTRACT;
  if (!acct || !key || !contract) return 0;
  const list = await env.CLAIMS.list({ prefix: "msettle:", limit: 100 }).catch(() => null);
  if (!list?.keys?.length) return 0;
  const ops = { accountId: acct, secretKey: key };
  let executed = 0;
  for (const k of list.keys) {
    if (executed >= PAYOUTS_PER_SCAN) break;
    const s = await env.CLAIMS.get(k.name).then((v) => v ? JSON.parse(v) : null) as {
      status?: string; mirror_id?: string; winning_claim_hash?: string;
      winner?: { actor?: string };
      near?: { market_id?: string | null; to?: string };
      payout?: { status?: string; tx_hash?: string; error?: string };
    } | null;
    if (!s || s.status !== "won" || !s.near?.market_id || !s.near.to) continue;
    if (s.payout?.tx_hash || s.payout?.status === "sending") continue;
    s.payout = { status: "sending" };
    await env.CLAIMS.put(k.name, JSON.stringify(s));
    try {
      // Ship the winner as an on-chain claim (ops = the attesting
      // relayer — our verdict IS the attestation), then release as payer.
      const sc = await nearFunctionCall(env, ops, contract, {
        methodName: "shipClaim",
        args: {
          marketId: String(s.near.market_id),
          claimHash: s.winning_claim_hash ?? `mirror-${s.mirror_id}`,
          actor: s.winner?.actor ?? "mirror",
          commits: [], evidence: { mirror: s.mirror_id },
          claimant: s.near.to, relayer: acct, attested: true,
        },
        gas: GAS, deposit: 0n,
      });
      if (!sc.txHash || txFailed(sc.status)) throw new Error(`shipClaim failed: ${JSON.stringify(sc.status).slice(0, 200)}`);
      const bag = (await nearViewCall(env, contract, "getClaims",
        { marketId: String(s.near.market_id), from: 0, limit: 200 })) as
        { claims?: { claimId: string; claimHash: string; status: string }[] } | null;
      const mine = bag?.claims?.find(
        (c) => c.claimHash === (s.winning_claim_hash ?? `mirror-${s.mirror_id}`) && c.status === "pending");
      if (!mine) throw new Error("shipped claim not found pending");
      const rel = await nearFunctionCall(env, ops, contract, {
        methodName: "release",
        args: { marketId: String(s.near.market_id), winningClaimId: mine.claimId },
        gas: GAS, deposit: 0n,
      });
      if (!rel.txHash || txFailed(rel.status)) throw new Error(`release failed: ${JSON.stringify(rel.status).slice(0, 200)}`);
      s.payout = { status: "paid", tx_hash: rel.txHash };
      await env.CLAIMS.put(k.name, JSON.stringify(s));
      executed++;
    } catch (e) {
      s.payout = { status: "failed", error: String(e).slice(0, 200) };
      await env.CLAIMS.put(k.name, JSON.stringify(s));
    }
  }
  return executed;
}
