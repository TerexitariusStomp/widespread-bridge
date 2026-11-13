// siwx.ts — Sign-In-With-X (EIP-4361) requester authentication.
//
// The x402 ecosystem's wallet-auth extension: a requester proves control of
// an EVM address by signing a canonical SIWE-style message. We use it to
// bind `requester` identity on sessions and tick verdicts — replacing the
// current bearer-by-session-id model for the requester side.
//
// Message format (EIP-4361):
//   <domain> wants you to sign in with your Ethereum account:
//   <address>
//
//   <statement>
//
//   URI: <uri>
//   Version: 1
//   Chain ID: <chainId>
//   Nonce: <nonce>
//   Issued At: <iso>
//
// Verification is viem's verifyMessage (EIP-191 personal_sign) — the same
// primitive SIWX wallets already implement.

import { verifyMessage } from "viem";

export interface SiwxAuth {
  /** EVM address that signed (0x…). */
  address: string;
  /** The exact EIP-4361 message that was signed. */
  message: string;
  /** Hex signature. */
  signature: string;
}

/** Structural check that `message` is a well-formed EIP-4361 SIWE message
 *  for our domain — prevents replaying signatures minted for other sites. */
export function siwxMessageOk(message: string, domain: string): boolean {
  if (typeof message !== "string" || message.length > 4096) return false;
  const lines = message.split("\n");
  if (!lines[0]?.startsWith(`${domain} wants you to sign in`)) return false;
  if (!lines.some((l) => l.startsWith("URI: "))) return false;
  if (!lines.some((l) => l.startsWith("Version: 1"))) return false;
  if (!lines.some((l) => l.startsWith("Nonce: "))) return false;
  if (!lines.some((l) => l.startsWith("Issued At: "))) return false;
  return true;
}

/** Verify a SIWX auth object. Returns the checksummed-ish address (as
 *  recovered by viem) on success. */
export async function verifySiwx(auth: unknown, domain: string): Promise<{ ok: boolean; address?: string; reason?: string }> {
  if (!auth || typeof auth !== "object") return { ok: false, reason: "siwx auth required" };
  const a = auth as Partial<SiwxAuth>;
  if (typeof a.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.address)) {
    return { ok: false, reason: "bad address" };
  }
  if (typeof a.message !== "string" || typeof a.signature !== "string") {
    return { ok: false, reason: "message + signature required" };
  }
  if (!siwxMessageOk(a.message, domain)) {
    return { ok: false, reason: "message is not a valid SIWE for this domain" };
  }
  // The address in the message body must match the claimed signer.
  const addrLine = a.message.split("\n").find((l) => /^0x[0-9a-fA-F]{40}$/.test(l.trim()));
  if (addrLine && addrLine.trim().toLowerCase() !== a.address.toLowerCase()) {
    return { ok: false, reason: "message address mismatch" };
  }
  try {
    const ok = await verifyMessage({
      address: a.address as `0x${string}`,
      message: a.message,
      signature: a.signature as `0x${string}`,
    });
    return ok ? { ok: true, address: a.address } : { ok: false, reason: "bad signature" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : "verify failed" };
  }
}
