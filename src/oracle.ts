// oracle.ts — the bridge's adjudicator seat, as an on-chain oracle.
//
// When the market contract sees an `accept` verdict signed by a registered
// oracle pubkey it releases escrow — no payer signature needed. The bridge
// signs `wide-verdict|{marketId}|{claimHash}|{verdict}|{deadline}` with an
// Ed25519 key whose pubkey is registered via registerOracle. Combined with
// the NEAR AI Cloud provider_tee signature on the model output, the chain
// of custody is: TEE-run inference → signed oracle verdict → escrow release.

export interface OracleConfig {
  contract: string;         // NEAR_CONTRACT account id
  rpc: string;              // NEAR_RPC_URL
  accountId: string;        // caller account (holds the NEAR to pay gas)
  secretKey: string;        // ed25519:... — signs the NEAR tx
  oracleKeyHex: string;     // 32-byte seed hex — the oracle's own signing key
  oraclePubkeyHex: string;  // matching pubkey, registered via registerOracle
}

const te = new TextEncoder();
const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function ed25519Sign(msg: string, seedHex: string): Promise<string> {
  const seed = Uint8Array.from(seedHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    // PKCS8 wrap for raw Ed25519 seed (DER prefix).
    new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,
                    0x04,0x22,0x04,0x20, ...seed]),
    { name: "Ed25519" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("Ed25519", key, te.encode(msg));
  return toHex(new Uint8Array(sig));
}

/** The oracle verdict envelope — exactly what release() binds on-chain. */
export async function signVerdict(
  cfg: OracleConfig,
  marketId: string,
  claimHash: string,
  verdict: "accept" | "reject",
  deadline: string,
): Promise<{ sig: string; pubkey: string }> {
  const msg = `wide-verdict|${marketId}|${claimHash}|${verdict}|${deadline}`;
  const sig = await ed25519Sign(msg, cfg.oracleKeyHex);
  return { sig, pubkey: cfg.oraclePubkeyHex };
}

/** Build the oracle config from env — the oracle's pubkey is provisioned
 * alongside its seed (a one-time `src/oracle-keygen.js` emits the pair). */
export function oracleEnv(env: {
  NEAR_CONTRACT?: string; NEAR_RPC_URL?: string;
  ORACLE_ACCOUNT?: string; ORACLE_SECRET_KEY?: string;
  ORACLE_SEED_HEX?: string; ORACLE_PUBKEY_HEX?: string;
  NEAR_OPS_ACCOUNT?: string; NEAR_OPS_SECRET_KEY?: string;
}): OracleConfig | null {
  if (!env.NEAR_CONTRACT || !env.ORACLE_SEED_HEX || !env.ORACLE_PUBKEY_HEX) {
    return null;
  }
  return {
    contract: env.NEAR_CONTRACT,
    rpc: env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
    accountId: env.ORACLE_ACCOUNT ?? "",
    secretKey: env.ORACLE_SECRET_KEY ?? "",
    oracleKeyHex: env.ORACLE_SEED_HEX,
    oraclePubkeyHex: env.ORACLE_PUBKEY_HEX,
  };
}

/* ---------- on-chain M-of-N oracle votes ------------------------------- */

import { nearFunctionCall, nearViewCall } from "./nearops";

// 100 Tgas: submitVerdict deserializes all contract state; ~31T burnt
// observed at 22 markets — headroom for growth, unspent gas is refunded.
const GAS = BigInt("100000000000000");

export interface OracleVoteResult {
  voted: boolean;
  claimId?: string;
  verdict?: "accept" | "reject";
  already_voted?: boolean;
  released?: { txHash: string; status: unknown } | null;
  quorum_pending?: boolean;
  acceptVotes?: number;
  quorumM?: number;
  error?: string;
}

interface VerdictsView {
  quorumM?: number;
  allowlist?: string[] | null;
  votes?: Record<string, { claimId: string; verdict: string }>;
  acceptTally?: Record<string, number>;
}

function txFailed(status: unknown): boolean {
  return /EXECUTED_FAILURE|"Failure"|FunctionCallError|ActionError/.test(
    JSON.stringify(status ?? ""));
}

/** Cast this oracle's M-of-N vote on-chain. The tx signs from
 * cfg.accountId — it MUST be the registered oracle's owner account (the
 * contract rejects verdicts from any other caller; naming our pubkey is
 * not authority).
 *
 * accept → submitVerdict persists our vote, then release() settles if
 * the market's quorumM is now met (reverts harmlessly if still short —
 * a later vote or the claimant can trigger the same release; funds are
 * never hostage to us being online).
 * reject → submitVerdict only; votes are public and correction-capable. */
export async function oracleVote(
  env: { NEAR_RPC_URL?: string },
  cfg: OracleConfig,
  opts: {
    marketId: string;
    claimId?: string;
    claimHash?: string;
    verdict: "accept" | "reject";
    verdictSig?: string;
  },
): Promise<OracleVoteResult> {
  const ops = { accountId: cfg.accountId, secretKey: cfg.secretKey };
  let claimId = opts.claimId ? String(opts.claimId) : "";
  if (!claimId && opts.claimHash) {
    const page = await nearViewCall(env, cfg.contract, "getClaims",
      { marketId: opts.marketId, from: 0, limit: 200 }) as {
        claims?: { claimId: string; claimHash: string; status: string }[];
      } | null;
    const hit = page?.claims?.find((c) => c.claimHash === opts.claimHash && c.status === "pending");
    if (!hit) return { voted: false, error: "no pending claim matches claimHash" };
    claimId = hit.claimId;
  }
  if (!claimId) return { voted: false, error: "claimId or claimHash required" };

  const prior = await nearViewCall(env, cfg.contract, "getVerdicts",
    { marketId: opts.marketId }).catch(() => null) as VerdictsView | null;
  const mine = prior?.votes?.[cfg.oraclePubkeyHex];
  const already = mine?.verdict === opts.verdict && mine?.claimId === claimId;

  if (!already) {
    // VERDICT_STAKE_YOCTO: the contract holds a 0.0025 NEAR storage stake
    // per oracle's first verdict on each market; excess is refunded.
    const v = await nearFunctionCall(env, ops, cfg.contract, {
      methodName: "submitVerdict",
      args: {
        marketId: opts.marketId, claimId,
        verdict: opts.verdict, oraclePubkey: cfg.oraclePubkeyHex,
        verdictSig: opts.verdictSig ?? null,
      },
      gas: GAS, deposit: 2500000000000000000000n,
    }).catch((e) => ({ txHash: "", status: String(e) }));
    if (!v.txHash || txFailed(v.status)) {
      return { voted: false, claimId, error: `submitVerdict failed: ${JSON.stringify(v.status).slice(0, 300)}` };
    }
  }

  if (opts.verdict === "reject") {
    const tally = await nearViewCall(env, cfg.contract, "getVerdicts",
      { marketId: opts.marketId }).catch(() => null) as VerdictsView | null;
    return { voted: true, claimId, verdict: "reject", already_voted: already,
      acceptVotes: tally?.acceptTally?.[claimId] ?? 0, quorumM: tally?.quorumM };
  }

  const rel = await nearFunctionCall(env, ops, cfg.contract, {
    methodName: "release",
    args: {
      marketId: opts.marketId, oraclePubkey: cfg.oraclePubkeyHex,
      verdictSig: opts.verdictSig ?? null, winningClaimId: claimId,
    },
    gas: GAS, deposit: 0n,
  }).catch((e) => ({ txHash: "", status: String(e) }));
  if (!rel.txHash || txFailed(rel.status)) {
    const tally = await nearViewCall(env, cfg.contract, "getVerdicts",
      { marketId: opts.marketId }).catch(() => null) as VerdictsView | null;
    return { voted: true, claimId, verdict: "accept", already_voted: already,
      quorum_pending: true, released: null,
      acceptVotes: tally?.acceptTally?.[claimId], quorumM: tally?.quorumM };
  }
  return { voted: true, claimId, verdict: "accept", already_voted: already,
    released: rel, quorum_pending: false };
}
