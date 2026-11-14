// Forge adapter seam — the bridge is forge-agnostic; each forge type
// implements how claims stream in, how evidence is fetched, and how verdict
// receipts write back. The universal claim shape stays OpLogEntry
// ({seq, hash, prev_hash, kind, actor, payload, created_at}) — any forge that
// can serve an append-only, hash-chained claim log plugs in with zero bridge
// changes; forges without one return an empty stream and claims arrive via
// POST /api/claims instead.

import type {
  ChainVerification,
  Env,
  OpLogEntry,
  ShipClaim,
  Writeback,
} from "../types";

/** Which forge deployment a repo lives on. Resolved per-repo — never
 *  assume a single global forge. */
export interface ForgeBinding {
  /** Adapter key — "deltagit", "generic", … (locator.ts forge types). */
  type: string;
  /** Forge base URL (no trailing slash). */
  base: string;
}

export interface ReceiptOpts {
  repo: string;
  sha: string;
  accepted: boolean;
  description: string;
  claimId: string;
}

/** Where + how an agent's signed work submission lands on this forge. */
export interface ShipTarget {
  /** Canonical path the agent signs. */
  path: string;
  /** Absolute URL to POST. */
  url: string;
  /** Signing recipe in the forge's own convention. */
  sign_format: string;
  /** Header scheme the forge verifies (e.g. x-dg-*). */
  headers: string;
  /** What body fields the route accepts. */
  body_schema: string;
}

export interface ForgeAdapter {
  readonly type: string;

  /** The forge's claim stream — entries in the universal OpLogEntry shape.
   *  [] for forges without a claim log (claims then come via /api/claims). */
  fetchClaims(b: ForgeBinding, repo: string, since?: number): Promise<OpLogEntry[]>;

  /** Does this stream entry assert work was submitted? */
  isClaim(e: OpLogEntry): boolean;

  /** Normalize a claim entry's payload → the review pipeline's ShipClaim. */
  toClaim(e: OpLogEntry): ShipClaim;

  /** Locally verify the stream's integrity (hash chain or equivalent). */
  verifyChain(entries: OpLogEntry[]): Promise<ChainVerification>;

  /** Unified-diff text for one commit — null when the forge can't serve it. */
  commitDiff(b: ForgeBinding, repo: string, sha: string): Promise<string | null>;

  /** Commit message for one commit — null when unavailable. */
  commitMessage(b: ForgeBinding, repo: string, sha: string): Promise<string | null>;

  /** Write the adjudication/payout receipt back onto the forge. */
  writeReceipt(env: Env, b: ForgeBinding, opts: ReceiptOpts): Promise<Writeback>;

  /** Register an agent pubkey → did. Adapters without an agent registry
   *  derive the did locally. */
  registerAgent(b: ForgeBinding | null, pubkeyHex: string, label: string): Promise<{ did?: string; error?: string }>;

  /** Endpoint + signing recipe for the agent's ship step — null when the
   *  forge takes no signed submissions (agents use /api/claims instead). */
  shipTarget(b: ForgeBinding, repo: string): ShipTarget | null;

  /** The payload bytes the forge verifies for a signed request — the
   *  canonical string is protocol-shaped but the digest convention is the
   *  forge's own (delta-git signs utf8(sha256hex(canonical))). */
  sigPayload(did: string, ts: string, nonce: string, method: string, path: string, bodyShaHex: string): Promise<Uint8Array>;
}
