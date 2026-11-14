// escrow.ts — ops-account NEAR escrow for mirror markets.
//
// A mirror market's USD face value is converted to NEAR at the Intents
// price and locked by broadcasting createMarket from NEAR_OPS_ACCOUNT —
// the platform cut is taken on-chain at release. Crypto payers escrow
// directly; this lane exists so ops (or a settled fiat leg upstream) can
// front escrow for a priced third-party bounty.
//
// Idempotent: every attempt is recorded in KV and reconciled against the
// contract by specHash before rebroadcasting, so a retry can never
// double-fund a market.

import type { Env, MirrorListing } from "./types";
import { nearFunctionCall, nearPriceUsd, nearViewCall } from "./nearops";

/** Escrow reconciliation state — one record per mirror. The chain is the
 * source of truth; this record only remembers what we attempted so a
 * retry can tell "already landed" from "safe to rebroadcast". */
interface EscrowState {
  mirror_id: string;
  status: "pending" | "confirmed" | "failed";
  usd: string;
  near_price: number;
  near_amount: string;
  deposit_yocto: string;
  txHash?: string;
  marketId?: string;
  error?: string;
  attempts: number;
  updated_at: number;
}

const escrowKey = (mirrorId: string) => `escrowstate:${mirrorId}`;
const PENDING_RETRY_MS = 10 * 60 * 1000;

async function getEscrowState(env: Env, mirrorId: string): Promise<EscrowState | null> {
  return env.CLAIMS.get<EscrowState>(escrowKey(mirrorId), "json");
}

async function putEscrowState(env: Env, s: EscrowState): Promise<void> {
  s.updated_at = Date.now();
  await env.CLAIMS.put(escrowKey(s.mirror_id), JSON.stringify(s));
}

/** Locate the market this mirror's specHash created, if any. listAll is
 * fine at current scale (tens of markets); revisit if it grows. */
async function findMarketBySpecHash(env: Env, contract: string, specHash: string): Promise<string | null> {
  try {
    const markets = (await nearViewCall(env, contract, "listAll", {})) as
      { marketId?: string; specHash?: string }[] | null;
    const hit = Array.isArray(markets) ? markets.find((m) => m?.specHash === specHash) : null;
    return hit?.marketId ?? null;
  } catch { return null; }
}

/** True when the broadcast receipts show a contract/runtime failure —
 * absence of failure markers is treated as ambiguous, not success; the
 * chain lookup above is what actually confirms escrow. */
function nearTxFailed(status: unknown): boolean {
  const s = JSON.stringify(status ?? "");
  return /EXECUTED_FAILURE|"Failure"|FunctionCallError|ActionError/.test(s);
}

/** Ops-account escrow: convert the mirror's USD face value to NEAR at the
 * Intents price and broadcast createMarket from NEAR_OPS_ACCOUNT —
 * contract escrow in, platform cut taken on-chain at release.
 *
 * Idempotent: every attempt is recorded in KV and reconciled against the
 * contract by specHash before rebroadcasting, so a retry can never
 * double-fund a market. */
export async function tryOpsEscrow(env: Env, mirror: MirrorListing): Promise<unknown> {
  const acct = env.NEAR_OPS_ACCOUNT, key = env.NEAR_OPS_SECRET_KEY, contract = env.NEAR_CONTRACT;
  if (!acct || !key || !contract) return { skipped: "NEAR_OPS_ACCOUNT/SECRET_KEY or NEAR_CONTRACT not configured" };
  const usd = mirror.original?.est_usd;
  if (!usd) return { skipped: "mirror has no USD price" };
  const args = mirror.createMarketArgs as Record<string, unknown>;
  const specHash = String(args.specHash ?? "");
  if (!specHash) return { skipped: "mirror has no specHash" };

  const prior = await getEscrowState(env, mirror.id);
  if (prior?.status === "confirmed" && prior.marketId) {
    return { escrowed: true, already: true, market_id: prior.marketId,
             txHash: prior.txHash, near_amount: prior.near_amount, usd: prior.usd };
  }

  // Reconcile any prior attempt against the chain first — a tx that
  // landed but whose response we lost must never be rebroadcast.
  const existing = await findMarketBySpecHash(env, contract, specHash);
  if (existing) {
    const s: EscrowState = {
      mirror_id: mirror.id, status: "confirmed",
      usd: String(prior?.usd ?? usd), near_price: prior?.near_price ?? 0,
      near_amount: prior?.near_amount ?? "", deposit_yocto: prior?.deposit_yocto ?? "",
      txHash: prior?.txHash, marketId: existing,
      attempts: prior?.attempts ?? 1, updated_at: 0,
    };
    await putEscrowState(env, s);
    return { escrowed: true, reconciled: true, market_id: existing, txHash: prior?.txHash };
  }

  // A recent unresolved attempt means the tx may still be propagating —
  // don't stack a second broadcast on top of it.
  if (prior && prior.attempts > 0 && Date.now() - prior.updated_at < PENDING_RETRY_MS) {
    return { pending: "prior escrow attempt unresolved — retry after confirmation window",
             txHash: prior.txHash, market_id: null, attempts: prior.attempts };
  }

  const price = await nearPriceUsd();
  if (!price || !Number.isFinite(price) || price <= 0) {
    return { skipped: "NEAR price unavailable or invalid (intents /tokens)" };
  }
  const nearAmount = usd / price;
  if (nearAmount <= 0.001) return { skipped: `converted ${nearAmount.toFixed(4)} NEAR below minimum` };
  const deposit = BigInt(Math.round(nearAmount * 1e24));

  const state: EscrowState = {
    mirror_id: mirror.id, status: "pending",
    usd: String(usd), near_price: price, near_amount: nearAmount.toFixed(6),
    deposit_yocto: deposit.toString(),
    attempts: (prior?.attempts ?? 0) + 1, updated_at: 0,
  };
  await putEscrowState(env, state);

  let res: { txHash: string; status: unknown };
  try {
    res = await nearFunctionCall(env,
      { accountId: acct, secretKey: key }, contract,
      {
        methodName: "createMarket",
        args: {
          specHash: args.specHash, spec: args.spec,
          deadline: args.deadline, acceptanceRule: args.acceptanceRule,
          platformBps: args.platformBps, platformTo: args.platformTo,
          payToHat: null, claimTtlNs: null, acceptanceHash: null,
        },
        gas: 50_000_000_000_000n, deposit,
      });
  } catch (e) {
    state.status = "failed";
    state.error = e instanceof Error ? e.message : String(e);
    await putEscrowState(env, state);
    return { escrowed: false, error: state.error, attempts: state.attempts,
             note: "broadcast failed — safe to retry via POST /api/mirrors/escrow" };
  }

  state.txHash = res.txHash || undefined;
  // FINAL wait means the tx executed — confirm by finding the market,
  // not by parsing receipt JSON.
  const marketId = await findMarketBySpecHash(env, contract, specHash);
  if (marketId) {
    state.status = "confirmed";
    state.marketId = marketId;
    await putEscrowState(env, state);
    return { escrowed: true, market_id: marketId, txHash: res.txHash,
             near_amount: state.near_amount, usd, near_price: price };
  }
  state.status = nearTxFailed(res.status) ? "failed" : "pending";
  state.error = state.status === "failed"
    ? `tx ${res.txHash} executed with failure: ${JSON.stringify(res.status).slice(0, 300)}`
    : undefined;
  await putEscrowState(env, state);
  return { escrowed: false, status: state.status, txHash: res.txHash,
           error: state.error, attempts: state.attempts,
           note: state.status === "pending"
             ? "tx broadcast but market not yet visible — will reconcile on next attempt"
             : "contract rejected the call — check ops account balance / args" };
}

/** C4 blind funder — escrow a confidential declared market through the
 *  ops pool. On-chain `payer` is NEAR_OPS_ACCOUNT, not the real funder;
 *  the on-chain `spec` is the redacted stub, never the sealed spec text.
 *  The real funder settles the ops account off-chain or via Intents to a
 *  fresh account. Same idempotent reconcile-by-specHash discipline as
 *  the mirror lane — retries can't double-fund. */
export async function tryDeclEscrow(env: Env, hash: string): Promise<unknown> {
  const { getDeclared } = await import("./declare");
  const bounty = await getDeclared(env, hash);
  if (!bounty) return { error: "declaration not found" };
  if (!bounty.confidential) return { error: "market is not confidential — the funder escrows directly" };

  const acct = env.NEAR_OPS_ACCOUNT, key = env.NEAR_OPS_SECRET_KEY, contract = env.NEAR_CONTRACT;
  if (!acct || !key || !contract) return { skipped: "NEAR_OPS_ACCOUNT/SECRET_KEY or NEAR_CONTRACT not configured" };
  const usd = parseFloat(bounty.amount ?? "");
  if (!Number.isFinite(usd) || usd <= 0) return { skipped: "declaration has no numeric USD amount" };

  const declId = `decl:${hash}`;
  const prior = await getEscrowState(env, declId);
  if (prior?.status === "confirmed" && prior.marketId) {
    return { escrowed: true, already: true, market_id: prior.marketId, txHash: prior.txHash };
  }

  // On-chain: redacted stub spec + sha256 of the REAL spec — binds the
  // hidden text without revealing it.
  const { sha256Hex } = await import("./sealed");
  const spec = `[confidential:${bounty.domain ?? "other"}] decl=${hash}`;
  const specHash = `sha256:${await sha256Hex(new TextEncoder().encode(bounty.spec))}`;

  const existing = await findMarketBySpecHash(env, contract, specHash);
  if (existing) {
    const s: EscrowState = {
      mirror_id: declId, status: "confirmed",
      usd: String(usd), near_price: prior?.near_price ?? 0,
      near_amount: prior?.near_amount ?? "", deposit_yocto: prior?.deposit_yocto ?? "",
      txHash: prior?.txHash, marketId: existing,
      attempts: prior?.attempts ?? 1, updated_at: 0,
    };
    await putEscrowState(env, s);
    return { escrowed: true, reconciled: true, market_id: existing, txHash: prior?.txHash };
  }
  if (prior && prior.attempts > 0 && Date.now() - prior.updated_at < PENDING_RETRY_MS) {
    return { pending: "prior escrow attempt unresolved — retry after confirmation window",
             txHash: prior.txHash, attempts: prior.attempts };
  }

  const price = await nearPriceUsd();
  if (!price || !Number.isFinite(price) || price <= 0) {
    return { skipped: "NEAR price unavailable or invalid (intents /tokens)" };
  }
  const nearAmount = usd / price;
  if (nearAmount <= 0.001) return { skipped: `converted ${nearAmount.toFixed(4)} NEAR below minimum` };
  const deposit = BigInt(Math.round(nearAmount * 1e24));

  const state: EscrowState = {
    mirror_id: declId, status: "pending",
    usd: String(usd), near_price: price, near_amount: nearAmount.toFixed(6),
    deposit_yocto: deposit.toString(),
    attempts: (prior?.attempts ?? 0) + 1, updated_at: 0,
  };
  await putEscrowState(env, state);

  const bps = Number(env.CUT_BPS ?? "200");
  let res: { txHash: string; status: unknown };
  try {
    res = await nearFunctionCall(env,
      { accountId: acct, secretKey: key }, contract,
      {
        methodName: "createMarket",
        args: {
          specHash, spec,
          deadline: String(BigInt(Date.now()) * 1000000n + 30n * 24n * 3600n * 1000000000n),
          acceptanceRule: "best sealed claim wins (attested submissions only)",
          platformBps: bps, platformTo: env.CUT_SINK ?? "widespread-dao.near",
          payToHat: null, claimTtlNs: null, acceptanceHash: null,
        },
        gas: 50_000_000_000_000n, deposit,
      });
  } catch (e) {
    state.status = "failed";
    state.error = e instanceof Error ? e.message : String(e);
    await putEscrowState(env, state);
    return { escrowed: false, error: state.error, attempts: state.attempts };
  }

  state.txHash = res.txHash || undefined;
  const marketId = await findMarketBySpecHash(env, contract, specHash);
  if (marketId) {
    state.status = "confirmed";
    state.marketId = marketId;
    await putEscrowState(env, state);
    return { escrowed: true, market_id: marketId, txHash: res.txHash,
             payer: acct, note: "on-chain payer is the ops pool — funder identity stays off-chain" };
  }
  state.status = nearTxFailed(res.status) ? "failed" : "pending";
  await putEscrowState(env, state);
  return { escrowed: false, status: state.status, txHash: res.txHash, attempts: state.attempts };
}

/* ---------- self-funded confidential escrow (no ops custody) ---------- */

/** The trustless alternative to tryDeclEscrow: returns everything the
 * funder needs to escrow a confidential market from a FRESH NEAR account
 * they generate themselves — the bridge never sees the key and never
 * holds the funds.
 *
 * Flow (all funder-side):
 *   1. generate ed25519 keypair; implicit account = hex(pubkey)
 *   2. request a 1Click quote with recipient=that account (any origin
 *      chain in, NEAR out — funds the implicit account into existence)
 *   3. that fresh account calls createMarket with the returned args
 *      (attaching `deposit_yocto`)
 *
 * On-chain payer = a fresh account with no history — better blindness
 * than the ops pool (a known protocol wallet) AND zero custody: ops
 * never learns the funder exists. Intents solvers see the origin→dest
 * flow (honest residual); timing/amount correlation persists on a
 * public chain.
 */
export async function declEscrowPlan(env: Env, hash: string, opts: {
  origin_asset?: string; refund_to?: string; recipient?: string;
  near_amount?: string; quorum_m?: number; oracle_allowlist?: string[];
}): Promise<unknown> {
  const { getDeclared } = await import("./declare");
  const bounty = await getDeclared(env, hash);
  if (!bounty) return { error: "declaration not found" };
  const contract = env.NEAR_CONTRACT;
  if (!contract) return { error: "NEAR_CONTRACT not configured" };

  const { sha256Hex } = await import("./sealed");
  const specHash = `sha256:${await sha256Hex(new TextEncoder().encode(bounty.spec))}`;
  const spec = bounty.confidential
    ? `[confidential:${bounty.domain ?? "other"}] decl=${hash}`
    : bounty.spec;

  // Amount: caller supplies NEAR directly, or USD → NEAR via Intents price.
  let nearAmount = parseFloat(opts.near_amount ?? "");
  if (!Number.isFinite(nearAmount) || nearAmount <= 0) {
    const usd = parseFloat(bounty.amount ?? "");
    const price = await nearPriceUsd();
    if (!Number.isFinite(usd) || usd <= 0) {
      return { error: "supply near_amount (USD conversion needs a numeric amount)" };
    }
    if (!price) return { error: "NEAR price unavailable" };
    nearAmount = usd / price;
  }
  const deposit = BigInt(Math.round(nearAmount * 1e24));

  const createMarketArgs = {
    receiver: contract, method: "createMarket",
    args: {
      specHash, spec,
      deadline: String(BigInt(Date.now()) * 1000000n + 30n * 24n * 3600n * 1000000000n),
      acceptanceRule: "best sealed claim wins (attested submissions only)",
      platformBps: 0, platformTo: null,
      oracleQuorumM: opts.quorum_m ?? 1,
      oracleAllowlist: opts.oracle_allowlist ?? null,
      payToHat: null, claimTtlNs: null, acceptanceHash: null,
    },
    deposit_yocto: deposit.toString(),
  };

  // Live 1Click quote when the funder supplies their fresh recipient +
  // origin asset — the deposit address funds THEIR key, never ours.
  let quote: unknown = null;
  if (opts.origin_asset && opts.refund_to && opts.recipient) {
    try {
      const { quoteSwap } = await import("./oneclick");
      quote = await quoteSwap({
        originAsset: opts.origin_asset,
        destinationAsset: "nep141:wrap.near",
        amount: nearAmount.toFixed(6),
        refundTo: opts.refund_to,
        recipient: opts.recipient,
      });
    } catch (e) {
      quote = { error: e instanceof Error ? e.message.slice(0, 160) : "quote unavailable" };
    }
  }

  return {
    createMarket: createMarketArgs,
    quote,
    spec_hash: specHash,
    confidential: !!bounty.confidential,
    guide: [
      "1. client-side: keypair → implicit account = hex(ed25519_pubkey)",
      "2. 1Click quote → deposit address (recipient = your implicit account)",
      "3. send origin asset → implicit account activates funded",
      "4. sign + broadcast createMarket with these args + deposit_yocto",
      "payer on-chain = your fresh account — no ops custody, no history",
    ],
    honest_limits: "intents solvers see origin→dest flow; amount+timing correlation persists on a public chain; the fresh account must retain its key for refund",
  };
}
