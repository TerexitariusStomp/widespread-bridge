// mcpearn.ts — non-custodial earn-side tools for the MCP surface.
// Agents generate and hold their own Ed25519 seeds; the bridge only ever
// verifies signatures against registered pubkeys and relays to the forge.
// Nothing sensitive is stored: challenge → pubkey → DID mapping is public
// material by design (the forge op-log records it anyway).

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Env } from "./types";
import { handleClaimPost } from "./claims";
import { forgeFor } from "./forges";
import { getDeclared } from "./declare";
import { listBounties, listRecords } from "./store";
import { listOnchainMarkets } from "./near";
import { checkLimit, callerKey, rateLimited } from "./ratelimit";

const CHALLENGE_TTL_S = 600;
const AGENT_KEY = (pubkey: string) => `agent:${pubkey}`;
const AGENT_BY_DID = (did: string) => `agentdid:${did}`;

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toHex(new Uint8Array(d));
}

interface AgentReg { pubkey: string; did: string; label?: string; registered_at: number }

// ---------------------------------------------------------------- tools

/** wide_agent_challenge — issue a single-use registration challenge. The
 * agent signs canonical_bytes with its own Ed25519 seed and calls
 * wide_agent_register. Never send seeds — the bridge only wants the sig. */
export async function agentChallenge(env: Env, label?: string) {
  const id = crypto.randomUUID();
  await env.CLAIMS.put(`challenge:${id}`, JSON.stringify({ label: label ?? null, t: Date.now() }), { expirationTtl: CHALLENGE_TTL_S });
  return {
    challenge_id: id,
    expires_in_s: CHALLENGE_TTL_S,
    canonical_bytes: `widespread-register-v1\n${id}\n<YOUR_pubkey_hex>\n${label ?? "agent"}`,
    instructions:
      "Generate an Ed25519 keypair locally (pynacl, @noble/ed25519, openssl). " +
      "Sign canonical_bytes (UTF-8) with your seed. Call wide_agent_register with " +
      "challenge_id, your pubkey_hex (64 hex chars), signature_hex, and your label. " +
      "Keep your seed — the bridge never stores or sees it.",
  };
}

/** wide_agent_register — verify the agent's signature over the challenge
 * canonical bytes, then register its pubkey with the forge → DID. */
export async function agentRegister(
  env: Env,
  req: Request,
  a: { challenge_id?: string; pubkey_hex?: string; signature_hex?: string; label?: string; repo?: string },
) {
  const rl = await checkLimit(env, "register", callerKey(req), 10);
  if (!rl.ok) return { error: rateLimited(rl.retryAfter) };

  if (!a.challenge_id || !a.pubkey_hex || !a.signature_hex) {
    return { error: "challenge_id, pubkey_hex, signature_hex required" };
  }
  const pub = hexToBytes(a.pubkey_hex);
  const sig = hexToBytes(a.signature_hex);
  if (!pub || pub.length !== 32) return { error: "pubkey_hex must be 64 hex chars (32 bytes)" };
  if (!sig || sig.length !== 64) return { error: "signature_hex must be 128 hex chars (64 bytes)" };

  const chKey = `challenge:${a.challenge_id}`;
  const ch = await env.CLAIMS.get(chKey, "json").catch(() => null) as { label?: string | null } | null;
  if (!ch) return { error: "challenge expired or unknown — call wide_agent_challenge again" };

  const label = a.label ?? ch.label ?? "agent";
  const canonical = `widespread-register-v1\n${a.challenge_id}\n${a.pubkey_hex}\n${label}`;
  const ok = ed25519.verify(sig, new TextEncoder().encode(canonical), pub);
  if (!ok) return { error: "signature invalid — sign canonical_bytes exactly as returned by the challenge" };

  // Single-use: burn the challenge before relaying.
  await env.CLAIMS.delete(chKey).catch(() => {});

  // The repo's forge owns agent registration when it has a registry
  // (delta-git POST /api/agents); otherwise the did derives locally.
  const repo = typeof a.repo === "string" ? a.repo : "";
  const { adapter, binding } = forgeFor(env, repo);
  const reg = await adapter.registerAgent(binding, a.pubkey_hex, label);
  if (reg.error || !reg.did) return { error: reg.error ?? "forge registration failed" };

  const rec: AgentReg = { pubkey: a.pubkey_hex, did: reg.did, label, registered_at: Date.now() };
  await env.CLAIMS.put(AGENT_KEY(a.pubkey_hex), JSON.stringify(rec)).catch(() => {});
  await env.CLAIMS.put(AGENT_BY_DID(reg.did), a.pubkey_hex).catch(() => {});
  return { ok: true, did: reg.did, pubkey: a.pubkey_hex, forge: reg };
}

/** wide_claim — proxy a validated market claim (same checks as
 * POST /api/claims: market open, forge submission verified). */
export async function marketClaim(
  env: Env,
  req: Request,
  a: { marketId?: string; forgeRef?: string; forgeUserId?: string; commits?: string[]; specHash?: string; actor?: string; claimant?: string },
) {
  const rl = await checkLimit(env, "claims", callerKey(req), 30, 500);
  if (!rl.ok) return { error: rateLimited(rl.retryAfter) };
  if (!a.marketId || !a.forgeRef) return { error: "marketId and forgeRef required" };
  const r = await handleClaimPost(
    new Request("https://bridge.local/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    }),
    env,
  );
  return r.json();
}

/** wide_ship_prepare — the repo's forge adapter describes where the signed
 * submission lands and which envelope convention the forge verifies. */
export async function shipPrepare(
  env: Env,
  a: { did?: string; repo?: string; session_id?: string; tool?: string; commits?: string[]; files?: Record<string, string>; proof_items?: unknown[]; artifact?: string; receipt?: Record<string, unknown>; base_ref?: string; patch?: string; message?: string; author?: string },
) {
  if (!a.did || !a.repo) return { error: "did and repo required" };
  const pub = await env.CLAIMS.get(AGENT_BY_DID(a.did)).catch(() => null);
  if (!pub) return { error: "did not registered via this bridge — call wide_agent_register first" };
  const { adapter, binding } = forgeFor(env, a.repo);
  if (!binding) return { error: `no forge binding for ${a.repo} — submit via POST /api/claims instead` };
  const target = adapter.shipTarget(binding, a.repo);
  if (!target) return { error: `${binding.type} forge takes no signed submissions — submit via POST /api/claims` };
  const body = {
    // delta-git /dg/patch fields — pass through when supplied
    ...(a.base_ref ? { base_ref: a.base_ref } : {}),
    ...(a.patch ? { patch: a.patch } : {}),
    ...(a.message ? { message: a.message } : {}),
    ...(a.author ? { author: a.author } : {}),
    session_id: a.session_id ?? `mcp-${Date.now()}`,
    tool: a.tool ?? "mcp-agent",
    commits: (a.commits ?? []).map((c) => c.toLowerCase()),
    ...(a.files ? { files: a.files } : {}),
    ...(a.proof_items ? { proof_items: a.proof_items } : {}),
    ...(a.artifact ? { artifact: a.artifact } : {}),
    ...(a.receipt ? { receipt: a.receipt } : {}),
  };
  const bodyBytes = JSON.stringify(body);
  return {
    method: "POST",
    path: target.path,
    forge: target.url,
    body,
    body_schema: target.body_schema,
    sign_format: target.sign_format,
    fields: { did: a.did, ts: "<unix seconds>", nonce: "<16 random bytes as hex>", body_sha256: await sha256Hex(bodyBytes) },
    then:
      "Sign with your Ed25519 seed using the forge's convention (sign_format above). Either call " +
      "wide_ship_submit(did, repo, body, ts, nonce, sig) to have the bridge verify+relay, or POST to " +
      `the forge url yourself with headers ${target.headers}.`,
  };
}

/** wide_ship_submit — verify the agent's signature in the forge's own
 * convention, then relay to the adapter-resolved endpoint. */
export async function shipSubmit(
  env: Env,
  req: Request,
  a: { did?: string; repo?: string; body?: Record<string, unknown>; ts?: string; nonce?: string; sig?: string },
) {
  const rl = await checkLimit(env, "ship", callerKey(req), 30, 300);
  if (!rl.ok) return { error: rateLimited(rl.retryAfter) };
  if (!a.did || !a.repo || !a.body || !a.ts || !a.nonce || !a.sig) {
    return { error: "did, repo, body, ts, nonce, sig required" };
  }
  const pubkey = await env.CLAIMS.get(AGENT_BY_DID(a.did)).catch(() => null);
  if (!pubkey) return { error: "did not registered via this bridge" };
  const pub = hexToBytes(pubkey)!;
  const sig = hexToBytes(a.sig);
  if (!sig || sig.length !== 64) return { error: "sig must be 128 hex chars" };

  const { adapter, binding } = forgeFor(env, a.repo);
  if (!binding) return { error: `no forge binding for ${a.repo}` };
  const target = adapter.shipTarget(binding, a.repo);
  if (!target) return { error: `${binding.type} forge takes no signed submissions` };

  const bodyBytes = JSON.stringify(a.body);
  const payload = await adapter.sigPayload(a.did, a.ts, a.nonce, "POST", target.path, await sha256Hex(bodyBytes));
  if (!ed25519.verify(sig, payload, pub)) {
    return { error: `signature invalid — check the ${binding.type} sign_format from wide_ship_prepare` };
  }

  const res = await fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "widespread-bridge/mcp-relay",
      "x-dg-did": a.did, "x-dg-ts": a.ts, "x-dg-nonce": a.nonce, "x-dg-sig": a.sig,
    },
    body: bodyBytes,
  }).catch((e) => ({ status: 0, text: () => Promise.resolve(String(e)) }) as unknown as Response);
  const text = await res.text().catch(() => "");
  return { relayed: res.status >= 200 && res.status < 300, forge_status: res.status, forge: tryJson(text) };
}

function tryJson(s: string): unknown { try { return JSON.parse(s); } catch { return s.slice(0, 500); } }

// ---------------------------------------------------------------- reads

export async function marketsList(env: Env, a: { chain?: string; min_usd?: number }) {
  const markets = await listOnchainMarkets(env).catch(() => []);
  const list = (markets as Record<string, unknown>[]).filter((m) => {
    if (a.chain && m.chain !== a.chain) return false;
    if (a.min_usd !== undefined) {
      const usd = Number(m.amount_usd ?? m.usd ?? 0);
      if (!(usd >= a.min_usd)) return false;
    }
    return true;
  });
  return { markets: list, total: list.length };
}

export async function bountiesList(env: Env) {
  return { bounties: await listBounties(env) };
}

export async function agentStatus(env: Env, a: { did?: string }) {
  if (!a.did) return { error: "did required" };
  const pubkey = await env.CLAIMS.get(AGENT_BY_DID(a.did)).catch(() => null);
  const records = await listRecords(env).catch(() => []);
  const mine = (records as Record<string, unknown>[]).filter((r) =>
    JSON.stringify(r).includes(a.did!),
  ).slice(0, 50);
  return {
    did: a.did,
    registered: Boolean(pubkey),
    records: mine,
    hint: "verdicts + payout_trace also appear under GET /api/state",
  };
}
