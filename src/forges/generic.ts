// Generic forge adapter — the default for every forge without a claim-log
// surface (github/gitlab/forgejo/codeberg/tangled/radicle/near/plain URLs).
// No remote claim stream: claims arrive via POST /api/claims with the
// market's forgeRef. No remote receipt write: the verdict record + bridge
// feed ARE the receipt. Agent dids derive locally (did:key from the
// registered pubkey) — no forge call needed.

import { didKeyFromPublicKey } from "../coordinator/didkey";
import type { Env, OpLogEntry, Writeback } from "../types";
import type { ForgeAdapter, ForgeBinding, ReceiptOpts } from "./types";

const te = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const generic: ForgeAdapter = {
  type: "generic",

  async fetchClaims() {
    return [];
  },

  isClaim() {
    return false;
  },

  toClaim(e) {
    return e.payload as never;
  },

  async verifyChain() {
    return { valid: true, checked: 0, tip_hash: null, tip_seq: -1, broken_at_seq: null };
  },

  async commitDiff() {
    return null;
  },

  async commitMessage() {
    return null;
  },

  async writeReceipt(_env: Env, _b: ForgeBinding, _opts: ReceiptOpts): Promise<Writeback> {
    return { attempted: false, skipped_reason: "no forge receipt surface — verdict lives on the bridge feed" };
  },

  async registerAgent(_b, pubkeyHex) {
    const pub = hexToBytes(pubkeyHex);
    if (!pub || pub.length !== 32) return { error: "invalid ed25519 pubkey" };
    return { did: didKeyFromPublicKey(pub) };
  },

  shipTarget() {
    return null;
  },

  async sigPayload(did, ts, nonce, method, path, bodyShaHex) {
    // Generic convention: sign the raw sha256 digest bytes.
    return new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        te.encode(`widespread1\n${did}\n${ts}\n${nonce}\n${method}\n${path}\n${bodyShaHex}`) as BufferSource
      )
    );
  },
};
