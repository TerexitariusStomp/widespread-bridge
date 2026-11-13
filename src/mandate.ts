// mandate.ts — AP2 (Agent Payments Protocol) mandate handling for sessions.
//
// A mandate is a signed *authorization artifact* — it constrains what an
// agent may spend, it does not move funds. Sessions still require real
// funding (market escrow or x402 payment); the mandate is recorded on the
// session as funding.mandate_ref and, when issuer keys are configured,
// cryptographically verified.
//
// Verification tiers:
//   structural — decodeJwsUnverified confirms AP2-shaped compact SD-JWT
//   verified   — AP2_TRUSTED_ISSUERS env (JSON {kid: jwk}) lets us run the
//                real verifyOpenPaymentMandate/verifyClosedPaymentMandate
//
// @ar-agents/ap2 is pure crypto (no network calls) — Worker-safe.

import { decodeJwsUnverified } from "@ar-agents/ap2";
import type { Env } from "./types";

export interface MandateCheck {
  ok: boolean;
  /** sha256 of the raw mandate string — recorded as funding.mandate_ref. */
  ref?: string;
  /** true only when signature verification ran against trusted issuers. */
  verified?: boolean;
  reason?: string;
}

/** Cheap structural check: is this an AP2-shaped compact SD-JWT
 *  presentation (mandate.* vct claim)? */
export function mandateStructure(jwt: string): { ok: boolean; vct?: string; iss?: string } {
  try {
    const decoded = decodeJwsUnverified(jwt) as unknown as Record<string, unknown>;
    const payload = (decoded?.payload ?? decoded) as Record<string, unknown>;
    const vct = payload?.vct;
    const iss = payload?.iss;
    const vc = typeof vct === "string" ? vct : Array.isArray(vct) ? String(vct[0]) : "";
    if (!vc.startsWith("mandate.")) return { ok: false };
    return { ok: true, vct: vc, iss: typeof iss === "string" ? iss : undefined };
  } catch {
    return { ok: false };
  }
}

/** Full check: structure always; signature when AP2_TRUSTED_ISSUERS
 *  (JSON map kid→public JWK) is configured and the mandate's kid matches. */
export async function checkMandate(
  env: Env, mandate: unknown, sha256Hex: (s: string) => Promise<string>,
): Promise<MandateCheck> {
  if (typeof mandate !== "string" || mandate.length > 64 * 1024) {
    return { ok: false, reason: "mandate must be a compact JWT string" };
  }
  const structure = mandateStructure(mandate);
  if (!structure.ok) return { ok: false, reason: "not an AP2 mandate presentation" };
  const ref = await sha256Hex(mandate);

  const trusted = env.AP2_TRUSTED_ISSUERS;
  if (!trusted) {
    // Structural pass only — recorded as advisory, never as verified spend.
    return { ok: true, ref, verified: false };
  }
  try {
    const issuers = JSON.parse(trusted) as Record<string, JsonWebKey>;
    const decoded = decodeJwsUnverified(mandate) as { header?: { kid?: string }; payload?: Record<string, unknown> };
    const kid = decoded?.header?.kid;
    const jwk = kid ? issuers[kid] : undefined;
    if (!jwk) return { ok: true, ref, verified: false, reason: "issuer not trusted" };
    const { verifyOpenPaymentMandate, verifyClosedPaymentMandate } = await import("@ar-agents/ap2");
    const vct = String((decoded.payload as Record<string, unknown> | undefined)?.vct ?? "");
    const isClosed = vct === "mandate.payment.1";
    // issuerKey is the mandate signer's public JWK (per @ar-agents/ap2).
    const outcome = isClosed
      ? await verifyClosedPaymentMandate(mandate, { issuerKey: jwk } as never)
      : await verifyOpenPaymentMandate(mandate, { issuerKey: jwk } as never);
    const ok = (outcome as { ok?: boolean }).ok === true;
    return ok
      ? { ok: true, ref, verified: true }
      : { ok: true, ref, verified: false, reason: (outcome as { reason?: string }).reason ?? "mandate verify failed" };
  } catch (e) {
    return { ok: true, ref, verified: false, reason: e instanceof Error ? e.message.slice(0, 120) : "verify error" };
  }
}
