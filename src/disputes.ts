// disputes.ts — D4 appeal layer. Bonded disputes freeze release() on the
// market contract until the arbitrator rules; the ruling replaces the
// oracle verdict. This module:
//   disputePlan     — the tx args a disputer broadcasts from THEIR account
//                     (their bond, their key — we never custody it)
//   getDisputes     — the public docket (view proxy)
//   evidenceBundle  — Kleros-Evidence-shaped JSON a disputer pins to IPFS;
//                     the CID goes on-chain as the dispute's evidenceCid
//   submitRuling    — interim arbitrator path (the contract account rules
//                     until the DAO rotates a Kleros-proxy arbitrator)
import type { Env } from "./types";
import { nearFunctionCall, nearViewCall } from "./nearops";
import { oracleEnv } from "./oracle";

const GAS = 50_000_000_000_000n;
const DEFAULT_BOND_YOCTO = "100000000000000000000000"; // 0.1 NEAR

/** Public docket for a market — open + resolved disputes. */
export async function getDisputes(env: Env, marketId: string): Promise<unknown> {
  const contract = env.NEAR_CONTRACT;
  if (!contract) return { error: "NEAR_CONTRACT not configured" };
  return nearViewCall(env, contract, "getDisputes", { marketId }) ?? [];
}

/** The tx args for a bonded dispute — the disputer signs + broadcasts
 *  from their own account (their bond moves, not ours). Mirrors the
 *  escrow-plan discipline: we prepare, they pay. */
export async function disputePlan(
  env: Env, marketId: string, claimId?: string, evidenceCid?: string,
): Promise<unknown> {
  const contract = env.NEAR_CONTRACT;
  if (!contract) return { error: "NEAR_CONTRACT not configured" };
  const market = await nearViewCall(env, contract, "getMarket", { marketId })
    .catch(() => null) as { status?: string; disputeBondYocto?: string | null } | null;
  if (!market) return { error: "market not found" };
  if (market.status !== "open") return { error: `market is ${market.status} — only open markets are disputable` };
  const open = await getDisputes(env, marketId) as { status?: string }[] | { error: string };
  if (Array.isArray(open) && open.some((d) => d.status === "open")) {
    return { error: "an open dispute already freezes this market" };
  }
  return {
    call: {
      receiver: contract, method: "dispute",
      args: { marketId, claimId: claimId ?? null, evidenceCid: evidenceCid ?? null },
      deposit_yocto: market.disputeBondYocto ?? DEFAULT_BOND_YOCTO,
    },
    guide: [
      "sign + broadcast `dispute` from YOUR account — the attached bond is yours",
      "open disputes freeze release + refund market-wide until the arbitrator rules",
      "upheld rulings refund the bond; dismiss burns it to the DAO sink",
      "pin your evidence bundle to IPFS first, pass its CID as evidenceCid",
    ],
  };
}

/** Kleros-Evidence-shaped bundle for a claim — the disputer pins this to
 *  IPFS and puts the CID on-chain so the arbitrator (human court or
 *  proxy) judges the same record everyone else sees. */
export async function evidenceBundle(
  env: Env, marketId: string, claimId?: string,
): Promise<unknown> {
  const contract = env.NEAR_CONTRACT;
  if (!contract) return { error: "NEAR_CONTRACT not configured" };
  const [market, claims, verdicts] = await Promise.all([
    nearViewCall(env, contract, "getMarket", { marketId }).catch(() => null),
    nearViewCall(env, contract, "getClaims", { marketId, from: 0, limit: 200 }).catch(() => null),
    nearViewCall(env, contract, "getVerdicts", { marketId }).catch(() => null),
  ]);
  if (!market) return { error: "market not found" };
  const claim = claimId != null
    ? ((claims as { claims?: { claimId: string }[] } | null)?.claims ?? [])
        .find((c) => c.claimId === String(claimId)) ?? null
    : null;
  // Bridge-side context the chain can't carry: our review record for the
  // claim's work_id (redacted — ciphertext + hashes only).
  let record = null;
  const workId = (market as { specHash?: string }).specHash;
  if (workId) {
    const recs = await env.CLAIMS.list({ prefix: "record:" }).catch(() => ({ keys: [] }));
    for (const k of (recs as { keys: { name: string }[] }).keys.slice(0, 200)) {
      const r = await env.CLAIMS.get(k.name, "json").catch(() => null) as
        { claim?: { payload?: { work_id?: string } } } | null;
      if (r?.claim?.payload?.work_id === workId) { record = r; break; }
    }
  }
  return {
    "@context": "https://kleros.gitbook.io/docs/integrations/types-of-integrations/1.-dispute-resolution-integration-plan/2.-evidence-standard",
    name: `Widespread market ${marketId}${claimId ? ` claim ${claimId}` : ""} dispute`,
    description: "Bonded appeal on a Widespread escrow market — the arbitrator rules against the on-chain record + sealed evidence below.",
    market, claim, verdicts, bridge_record: record,
    note: "sealed ciphertext is funder/oracle-addressable; spec_hash binds the declared task",
    generated_at: Date.now(),
  };
}

/** Interim arbitrator ruling — called by the contract account (the
 *  bridge's oracle key is its owner). Rotates to a Kleros-proxy account
 *  via setArbitrator when the arbitration rail goes live. */
export async function submitRuling(
  env: Env, marketId: string, claimId: string | null, ruling: string,
): Promise<unknown> {
  const cfg = oracleEnv(env);
  if (!cfg) return { error: "oracle credentials not configured" };
  if (!["pay_claim", "reject_claim", "refund", "dismiss"].includes(ruling)) {
    return { error: "ruling must be pay_claim | reject_claim | refund | dismiss" };
  }
  const res = await nearFunctionCall(env, { accountId: cfg.accountId, secretKey: cfg.secretKey },
    cfg.contract, {
      methodName: "resolveDispute",
      args: { marketId, claimId, ruling },
      gas: GAS, deposit: 0n,
    }).catch((e) => ({ txHash: "", status: String(e) }));
  if (!res.txHash) return { ruled: false, error: res.status };
  const { emitEvent } = await import("./events");
  await emitEvent(env, "ruling", `${marketId}:${claimId ?? "*"}`,
    { marketId, claimId, ruling, txHash: res.txHash });
  return { ruled: true, ruling, txHash: res.txHash };
}
