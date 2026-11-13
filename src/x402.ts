// x402.ts — x402 v2 funding rail for resource sessions.
//
// @x402/near ships the `exact` scheme only (no `upto` yet), so the honest
// mapping is: a requester prepays an exact NEP-141 payment covering the
// session's quoted ceiling — offer.price × quota, converted to the
// settlement asset via the operator-configured X402_USDC_PER_NEAR rate —
// to the coordinator payTo through this facilitator. The verified payment
// becomes session funding; metered settlement still flows through the
// receipt/claim path, and underdelivery reconciliation is documented there
// (partial x402 settlement isn't possible on the exact scheme).
//
// Dormant until the operator configures:
//   X402_RELAYER_KEYS  — JSON [{accountId, secretKey}] or "acct:key,acct2:key2"
//   X402_PAYTO         — NEAR account that receives session payments
//   X402_NETWORK       — near testnet/mainnet CAIP-2 (default testnet)
//   X402_USDC_PER_NEAR — atomic USDC per 1 NEAR quote rate (documented
//                        oracle-substitute until a price feed lands)

import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, Network } from "@x402/core/types";
import {
  createFacilitatorNearSigner,
  NEAR_TESTNET_CAIP2,
  NEAR_MAINNET_CAIP2,
  getDefaultAsset,
} from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";
import type { Env } from "./types";

let facilitator: x402Facilitator | null = null;
let facilitatorEnv = "";

/** Parse X402_RELAYER_KEYS: JSON array or comma-separated acct:secretKey. */
function parseRelayers(raw: string | undefined): { accountId: string; secretKey: string }[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) {
      return j.filter((r) => r?.accountId && r?.secretKey)
        .map((r) => ({ accountId: String(r.accountId), secretKey: String(r.secretKey) }));
    }
  } catch { /* fall through to csv */ }
  return raw.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf(":");
    // secretKey itself contains ':' (e.g. "ed25519:...") — split at the
    // accountId/key boundary: first colon ends the account id only when the
    // remainder still looks like a key spec; NEAR account ids can't contain ':'.
    const acct = p.slice(0, i);
    return { accountId: acct, secretKey: p.slice(i + 1) };
  }).filter((r) => r.accountId && r.secretKey);
}

/** Lazily build the facilitator — null when unconfigured (callers must
 *  treat null as "x402 rail dormant", never as "payment accepted"). */
export function getX402Facilitator(env: Env): x402Facilitator | null {
  const keys = parseRelayers(env.X402_RELAYER_KEYS);
  const payTo = env.X402_PAYTO;
  if (!keys.length || !payTo) return null;
  const fingerprint = `${env.X402_NETWORK}|${env.X402_PAYTO}|${env.X402_RELAYER_KEYS}`;
  if (facilitator && facilitatorEnv === fingerprint) return facilitator;
  const network = (env.X402_NETWORK || NEAR_TESTNET_CAIP2) as Network;
  const signer = createFacilitatorNearSigner({
    relayers: keys.map((k) => ({ accountId: k.accountId, secretKey: k.secretKey as never })),
  });
  const scheme = new ExactNearScheme(signer);
  facilitator = new x402Facilitator().register(network as never, scheme);
  facilitatorEnv = fingerprint;
  return facilitator;
}

/** Atomic amount (USDC, 6 decimals) for a quoted ceiling in NEAR. */
export function quoteAtomicUnits(priceNear: number, quota: number, env: Env): string | null {
  const rate = Number(env.X402_USDC_PER_NEAR);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const usdc = priceNear * quota * rate;
  if (!Number.isFinite(usdc) || usdc <= 0) return null;
  return BigInt(Math.ceil(usdc * 1e6)).toString();
}

/** PaymentRequirements a requester must satisfy to fund a session against
 *  `offer` for `quota` units of `unit`. */
export function sessionRequirements(
  env: Env, offer: { price_near_per_unit: string; unit: string }, quota: number,
  resource: string,
): PaymentRequirements | null {
  const facilitatorRef = getX402Facilitator(env);
  if (!facilitatorRef || !env.X402_PAYTO) return null;
  const network = (env.X402_NETWORK || NEAR_TESTNET_CAIP2) as Network;
  const amount = quoteAtomicUnits(Number(offer.price_near_per_unit), quota || 1, env);
  if (!amount) return null;
  let asset: string;
  try {
    asset = getDefaultAsset(network).asset ?? "";
  } catch { asset = ""; }
  if (!asset) return null;
  return {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo: env.X402_PAYTO,
    maxTimeoutSeconds: 300,
    extra: { resource, unit: offer.unit, description: `widespread session ${resource}` },
  };
}

/** x402 v2 PAYMENT-REQUIRED body for unpaid session requests. */
export function paymentRequiredBody(requirements: PaymentRequirements, resource: string) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: resource, description: `widespread ${requirements.extra?.resource ?? "session"}` },
    accepts: [requirements],
  };
}

/** Verify an x402 payment payload against requirements. Returns the payer
 *  on success — the caller records it as session.funding.payer. */
export async function verifySessionPayment(
  env: Env, payload: unknown, requirements: PaymentRequirements,
): Promise<{ ok: boolean; payer?: string; reason?: string }> {
  const f = getX402Facilitator(env);
  if (!f) return { ok: false, reason: "x402 facilitator not configured" };
  try {
    const res = await f.verify(payload as PaymentPayload, requirements);
    if (!res.isValid) return { ok: false, reason: res.invalidReason ?? res.invalidMessage ?? "invalid" };
    return { ok: true, payer: res.payer };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "verify failed" };
  }
}

/** Settle a verified payment. Called when a session closes — the exact
 *  scheme moves the full quoted ceiling; reconciliation of unused quota is
 *  handled by the receipt/claim path (documented limitation: no partial
 *  x402 settlement on NEAR until an `upto` scheme ships). */
export async function settleSessionPayment(
  env: Env, payload: unknown, requirements: PaymentRequirements,
): Promise<{ ok: boolean; tx?: string; reason?: string }> {
  const f = getX402Facilitator(env);
  if (!f) return { ok: false, reason: "x402 facilitator not configured" };
  try {
    const res = await f.settle(payload as PaymentPayload, requirements);
    return res.success
      ? { ok: true, tx: (res as { transaction?: string }).transaction }
      : { ok: false, reason: res.errorReason ?? "settle failed" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "settle failed" };
  }
}

/** Supported-kinds advertisement for discovery surfaces. */
export function supportedKinds(env: Env) {
  const f = getX402Facilitator(env);
  return f ? f.getSupported() : { kinds: [], extensions: [], signers: {}, configured: false };
}

export { NEAR_MAINNET_CAIP2, NEAR_TESTNET_CAIP2 };
