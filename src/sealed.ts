// sealed.ts — confidential-market crypto: libsodium-wire-compatible
// sealed boxes (@serenity-kit/noble-sodium, pure JS over noble primitives).
//
// Roles:
//   funder   — declares a fresh x25519 pubkey per market; receives
//              deliverables sealed to it (nobody else can open that copy)
//   bridge   — receives the SAME artifact sealed to BRIDGE_X25519 pubkey;
//              opens it inside the request only, feeds plaintext to the
//              judge, never stores it (C3: plaintext lives in-request)
//   claimant — seals; proves the artifact via artifact_sha256 without
//              exposing content
//
// crypto_box_seal ciphertexts are sender-anonymous — the ephemeral pubkey
// inside reveals nothing about the claimant.

import { cryptoBoxSeal, cryptoBoxSealOpen, cryptoBoxKeyPair } from "@serenity-kit/noble-sodium";
import { x25519 } from "@noble/curves/ed25519";
import type { Env } from "./types";

export interface SealedArtifact {
  /** crypto_box_seal(deliverable) to the funder's x25519 pubkey. */
  ciphertext_funder_b64: string;
  /** crypto_box_seal(deliverable) to the bridge's x25519 pubkey — the
   *  adjudication copy. Required so the judge can read it in-request. */
  ciphertext_bridge_b64: string;
  /** sha256:<hex> of the PLAINTEXT deliverable — the binding the record
   *  keeps; verified after decryption, never replaced by ciphertext hash. */
  artifact_sha256: string;
}

const SEAL_OVERHEAD = 48;            // 32B ephemeral pubkey + 16B poly1305 tag
const MAX_SEALED_BYTES = 256 * 1024; // same cap as artifact_inline

export function isHex(s: unknown, bytes: number): s is string {
  return typeof s === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64ToBytes(b64: string): Uint8Array | null {
  try { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
  catch { return null; }
}

/** Bridge's x25519 pubkey (hex) derived from the configured secret —
 *  published so claimants can seal the adjudication copy. Null when no
 *  bridge key is configured (confidential adjudication unavailable). */
export function bridgeX25519PublicKey(env: Env): string | null {
  const secret = (env as { BRIDGE_X25519_SECRET?: string }).BRIDGE_X25519_SECRET;
  if (!isHex(secret, 32)) return null;
  return [...x25519.getPublicKey(hexToBytes(secret))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fresh x25519 keypair — for funders (declare) and tests. */
export function newSealedKeyPair(): { publicKey: string; secretKey: string } {
  const kp = cryptoBoxKeyPair();
  const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.privateKey) };
}

/** crypto_box_seal bytes → recipient pubkey hex. */
export function sealTo(message: Uint8Array, recipientPubkeyHex: string): string {
  const ct = cryptoBoxSeal({ message, publicKey: hexToBytes(recipientPubkeyHex) });
  let bin = "";
  for (const b of ct) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** crypto_box_seal_open — returns plaintext or null (not for us/corrupt). */
export function sealOpen(ciphertextB64: string, secretKeyHex: string): Uint8Array | null {
  const ct = b64ToBytes(ciphertextB64);
  if (!ct || !isHex(secretKeyHex, 32)) return null;
  try {
    const secret = hexToBytes(secretKeyHex);
    const publicKey = x25519.getPublicKey(secret);
    return cryptoBoxSealOpen({ ciphertext: ct, publicKey, privateKey: secret });
  } catch { return null; }
}

/** Shape-check the evidence.artifact_sealed payload — no decryption.
 *  Ref hash must match the declared artifact_sha256 (ref↔payload bind). */
export function parseSealedArtifact(
  evidence: Record<string, unknown>, refSha256?: string,
  opts?: { requireBridgeCopy?: boolean },
): { sealed?: SealedArtifact; failures: string[] } {
  const s = evidence.artifact_sealed as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") {
    return { failures: ["confidential claims require evidence.artifact_sealed — crypto_box_seal ciphertext, never plaintext"] };
  }
  const sealed = s as unknown as SealedArtifact;
  const failures: string[] = [];
  // Full-blind spec_sealed markets can't include a bridge copy (bridge
  // judges nothing it can't read) — funder copy is the only required one.
  const required = opts?.requireBridgeCopy === false
    ? ["ciphertext_funder_b64"] as const
    : ["ciphertext_funder_b64", "ciphertext_bridge_b64"] as const;
  for (const k of required) {
    const v = sealed[k];
    if (typeof v !== "string" || !v) { failures.push(`artifact_sealed.${k} required`); continue; }
    const bytes = b64ToBytes(v);
    if (!bytes) failures.push(`artifact_sealed.${k} is not valid base64`);
    else if (bytes.length <= SEAL_OVERHEAD) failures.push(`artifact_sealed.${k} too short to be a sealed box`);
    else if (bytes.length > MAX_SEALED_BYTES + SEAL_OVERHEAD) failures.push(`artifact_sealed.${k} exceeds 256KB sealed budget`);
  }
  if (typeof sealed.artifact_sha256 !== "string"
      || !/^sha256:[0-9a-f]{64}$/i.test(sealed.artifact_sha256)) {
    failures.push("artifact_sealed.artifact_sha256 must be sha256:<64-hex> of the plaintext deliverable");
  } else if (refSha256 && sealed.artifact_sha256.toLowerCase() !== `sha256:${refSha256.toLowerCase()}`) {
    failures.push("sealed:// ref hash does not match artifact_sealed.artifact_sha256");
  }
  return failures.length ? { failures } : { sealed, failures };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** C3: open the bridge's adjudication copy inside this request. Returns
 *  the plaintext bytes only when the hash binds — the judge sees content,
 *  the record never does. */
export async function decryptSealedForBridge(
  env: Env, sealed: SealedArtifact,
): Promise<{ plaintext?: Uint8Array; error?: string }> {
  const secret = (env as { BRIDGE_X25519_SECRET?: string }).BRIDGE_X25519_SECRET;
  if (!isHex(secret ?? "", 32)) {
    return { error: "BRIDGE_X25519_SECRET not configured — cannot open sealed deliverables" };
  }
  const pt = sealOpen(sealed.ciphertext_bridge_b64, secret!);
  if (!pt) return { error: "bridge sealed copy did not decrypt — wrong recipient key or corrupt ciphertext" };
  const hash = await sha256Hex(pt);
  if (`sha256:${hash}` !== sealed.artifact_sha256.toLowerCase()) {
    return { error: "decrypted artifact hash does not match declared artifact_sha256" };
  }
  return { plaintext: pt };
}
