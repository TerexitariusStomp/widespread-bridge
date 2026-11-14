// declare.ts — surface-agnostic bounty declarations.
// A declaration is canonical text (specHash + tag) the funder can paste
// on ANY surface — forge issue, tweet, nostr note, blog post. Scanners
// or the manual bind link it to the market. Domain picks the verifier.

import type { Env, Bounty, FeedRecord, CapacityTag, CapacityDim } from "./types";
import { resolveHandle } from "./identity";

const tag = "widespread";

export interface DeclareArgs {
  domain?: string;             // code | social-media | research | writing | design | data | other
  spec: string;                // task spec / acceptance rules
  /** Confidential market — canonical declaration + feed carry only
   *  domain+amount+specHash; real spec stays in private KV and is
   *  revealed to claimants via /api/spec/reveal. Deliverables must
   *  arrive as artifact_sealed ciphertext to funder_x25519_pubkey. */
  confidential?: boolean;
  /** Funder's x25519 pubkey (hex, 32-byte) — receives sealed
   *  deliverables + wrapped adjudication key. Fresh per market. */
  funder_x25519_pubkey?: string;
  amount: string;
  currency?: string;
  verification?: { class?: string; params?: Record<string, unknown> };
  payer_account?: string;      // funder's NEAR account (funds escrow directly)
  funder_handle?: string;
  funder_did?: string;         // funder's DID — enables cross-surface context
  /** Cross-surface target: the profile the work is FOR (bound via
   * /api/identity/bind). A forge-declared task can target a social handle
   * and vice versa. Workers see for:{platform,handle} — no more identity
   * than necessary is exposed. */
  target_platform?: string;
  target_handle?: string;
  /** draft (default for ghostwriting — text reviewed, target publishes) |
   * publish (deliverable must appear on the target profile) |
   * resource (metered machine service — compute/bandwidth/storage; requires
   * meter + threshold so claims verify deterministically). */
  deliverable_class?: "draft" | "publish" | "resource";
  /** resource markets: the measured unit (bandwidth_gb, storage_gb_mo,
   *  compute_hrs, tokens, …), the acceptance threshold, and the service
   *  window (e.g. "7d", "720h"). Emitted into the canonical spec so the
   *  receipt verifier can read the objective acceptance rule. */
  meter?: string;
  threshold?: number;
  window?: string;
  /** Optional watcher fee (bps of amount, 0–1000) — watchers who sighted
   *  this declaration on-platform earn a recorded entitlement when the
   *  declaration funds. Default 0. */
  sighting_bps?: number;
  /** MORE capacity objective — REQUIRED (the only declare path; nobody
   *  was using untagged markets, so the legible-objective path is the
   *  only path). dims non-empty; evidence_plan.measure + horizon_days
   *  required. attester defaults to "watcher" paid by "protocol" — the
   *  unbiased defaults from the auditor-payor science. */
  capacity?: CapacityTag;
  /** Convenience: comma-separated dims ("C_k,C_h") — merged into
   *  capacity.dims. */
  dims?: string;
}

const CAPACITY_DIMS = new Set(["C_e", "C_h", "C_k", "C_inst", "C_m"]);

/** Normalize declared capacity — REQUIRED. Every market declares which
 *  life-capacity dimension it serves and how the outcome is verified.
 *  Returns {cap} or {error}. */
function normalizeCapacity(a: DeclareArgs): { cap?: CapacityTag; error?: string } {
  const dims = new Set<CapacityDim>();
  for (const d of a.capacity?.dims ?? []) if (CAPACITY_DIMS.has(d)) dims.add(d);
  if (a.dims) for (const d of a.dims.split(",")) {
    const t = d.trim() as CapacityDim;
    if (CAPACITY_DIMS.has(t)) dims.add(t);
  }
  if (!dims.size) {
    return { error: "capacity required — declare dims (C_e|C_h|C_k|C_inst|C_m) via capacity.dims or dims:\"C_k,C_h\"" };
  }
  const plan = a.capacity?.evidence_plan;
  if (!plan?.measure?.trim() || plan.horizon_days == null) {
    return { error: "capacity.evidence_plan required — {measure, horizon_days} minimum; attester defaults to watcher/protocol" };
  }
  const cap: CapacityTag = {
    dims: [...dims],
    ...(a.capacity?.subsystem ? { subsystem: a.capacity.subsystem } : {}),
    ...(a.capacity?.floor_attestation ? { floor_attestation: a.capacity.floor_attestation } : {}),
    evidence_plan: {
      measure: plan.measure.trim(),
      ...(plan.baseline ? { baseline: plan.baseline } : {}),
      attester: plan.attester ?? "watcher",
      attester_paid_by: plan.attester_paid_by ?? "protocol",
      horizon_days: plan.horizon_days,
    },
    ...(a.capacity?.trustee_ref ? { trustee_ref: a.capacity.trustee_ref } : {}),
  };
  return { cap };
}

/** Stage-A floor screen (display-only, spec §2 P2): heuristic flags on
 *  the spec text. Flags, never blocks — enforcement stays polycentric. */
const FLOOR_PATTERNS: Array<[RegExp, string]> = [
  [/\b(astroturf|coordinated inauthentic|fake (reviews?|accounts?|followers?))\b/i, "astroturf"],
  [/\b(buy|purchase|sell|farm)\b[^.]{0,50}\b(fake\s+|bot\s+|purchased\s+)?(followers?|likes?|upvotes?|reviews?|accounts?|comments?)\b/i, "engagement-farming"],
  [/\b(scrape|scraping|scraper|crawl)\b[^.]*\b(personal data|pii|without consent|private)\b/i, "scraping-pii"],
  [/\b(undisclosed|stealth|covert)\s+(paid\s+)?(promo|advertis|post|campaign)/i, "undisclosed-paid-promo"],
  [/\b(click ?farm|botnet|sybil|vote manipulation|bribe)/i, "infrastructure-abuse"],
  [/\b(harass|doxx?|threaten|intimidate)/i, "harassment"],
];

export function floorFlags(spec: string): string[] {
  return FLOOR_PATTERNS.filter(([re]) => re.test(spec)).map(([, flag]) => flag);
}

async function specHash(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function bountyDeclare(env: Env, a: DeclareArgs) {
  if (!a.spec?.trim() || !a.amount) return { error: "spec + amount required" };
  const domain = (a.domain ?? "other").toLowerCase();
  const hash = await specHash(`${domain}|${a.spec}|${a.amount}`);
  const repo = `widespread/${domain}`;   // forge repo that logs this vertical's attestations
  const id = `decl:${hash}`;
  const deliverable = a.deliverable_class ?? (domain === "social-media" || domain === "writing" ? "draft" : "publish");
  if (deliverable === "resource" && (!a.meter || a.threshold == null)) {
    return { error: "resource markets require meter + threshold — objective acceptance is the point" };
  }
  const target = a.target_platform && a.target_handle
    ? { platform: a.target_platform.toLowerCase(), handle: a.target_handle.replace(/^@/, "") }
    : null;
  const bound = target ? await resolveHandle(env, target.platform, target.handle) : null;
  if (a.confidential && !/^[0-9a-f]{64}$/i.test(a.funder_x25519_pubkey ?? "")) {
    return { error: "confidential markets require funder_x25519_pubkey (hex, 32 bytes) — generate a fresh x25519 pair; deliverables + adjudication key wrap to it" };
  }
  const capRes = normalizeCapacity(a);
  if (capRes.error) return { error: capRes.error };
  const capacity = capRes.cap!;
  const flags = floorFlags(a.spec);
  const canonical = [
    `#${tag} bounty ${hash}`,
    `domain: ${domain}`,
    `amount: ${a.amount} ${a.currency ?? "USD"}`,
    a.confidential ? `confidential: spec-sealed — claimants reveal via /api/spec/reveal` : `spec: ${a.spec}`,
    deliverable === "resource" ? `meter:${a.meter} threshold:${a.threshold}${a.window ? ` window:${a.window}` : ""}` : null,
    target && !a.confidential ? `for: ${target.platform} @${target.handle}` : null,
    target && deliverable === "draft" ? `deliverable: draft text (you publish)` : null,
    capacity?.dims.length ? `dims: ${capacity.dims.join(",")}` : null,
    capacity?.subsystem ? `subsys: ${capacity.subsystem}` : null,
    capacity?.evidence_plan ? `plan: ${capacity.evidence_plan.measure}` : null,
    a.verification?.params?.nonce ? `nonce: ${a.verification.params.nonce}` : null,
    `claim: reply "widespread claim ${hash}" or POST your deliverable URL`,
  ].filter(Boolean).join("\n");

  const bounty: Bounty = {
    repo, amount: a.amount, currency: a.currency ?? "USD",
    receiver_account: "",
    spec: a.spec,
    proof_requirements: domain === "code" ? undefined : [{ type: "platform-url", note: "deliverable = published artifact URL" } as never],
    domain: domain === "code" ? undefined : domain,
    work_id: hash,
    target: target ?? undefined,
    deliverable_class: deliverable === "resource" ? "resource" : (target ? deliverable : undefined),
    // Confidential: never persist a durable funder identity — the ops
    // pool is the on-chain payer and the reveal key is per-market.
    funder_did: a.confidential ? undefined : a.funder_did,
    ...(a.confidential ? { confidential: true, funder_x25519_pubkey: a.funder_x25519_pubkey } : {}),
    ...(a.sighting_bps ? { sighting_bps: Math.min(1000, Math.max(0, Math.round(a.sighting_bps))) } : {}),
    capacity,
    ...(flags.length ? { floor_flags: flags } : {}),
    created_at: Date.now(),
  };
  await env.CLAIMS.put(`decl:${hash}`, JSON.stringify(bounty));
  await env.CLAIMS.put(`declhash:${repo}`, hash);
  // Maximin pool ledger: every tagged market feeds the scarcity signal.
  const { recordFunding, matchFor } = await import("./maximin");
  await recordFunding(env, capacity.dims, a.amount).catch(() => {});
  const poolMatch = await matchFor(env, capacity.dims).catch(() => null);

  const record: FeedRecord = {
    id, source: "declared", forge: "generic", kind: "bounty",
    title: a.confidential ? `confidential ${domain} market` : a.spec.slice(0, 120),
    ...(a.confidential ? { confidential: true } : { spec: a.spec }),
    amount: a.amount, currency: a.currency ?? "USD",
    escrow: { state: "label-only" },
    verification: {
      required: domain === "code" ? "forge ship op"
        : deliverable === "resource" ? "metered-receipt"
        : deliverable === "draft" ? "text-draft" : "platform-url",
      spec_hash: hash,
      ...(deliverable === "resource" ? {
        params: { meter: a.meter, threshold: a.threshold, ...(a.window ? { window: a.window } : {}) },
      } : {}),
    },
    url: `https://widespread-bridge.widespread.workers.dev/api/declarations/${hash}`,
    claim: { how: `reply "widespread claim ${hash}" or via MCP wide_claim`, grammar: "widespread claim <hash>" },
    domain,
    for: target && !a.confidential ? { ...target, bound: !!bound } : undefined,
    deliverable_class: deliverable === "resource" ? "resource" : (target ? deliverable : undefined),
    capacity,
    // floor_flags are spec-derived — for confidential markets they leak
    // hints about the hidden spec, so they stay off the public record.
    ...(!a.confidential && flags.length ? { floor_flags: flags } : {}),
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.CLAIMS.put(`feedrec:${id}`, JSON.stringify(record));
  const warnings: string[] = [];
  if (target && !bound) warnings.push(`target ${target.platform}/@${target.handle} is not bound — funder should POST /api/identity/bind so style/history verification can run`);
  // Trustee standing (Stage C): capacity.trustee_ref must resolve to a
  // real hat — orgs whose stance.vetoes map floor conditions and whose
  // prefs weight capacity dims. Unresolvable → warn, never block.
  if (capacity.trustee_ref) {
    const { hatsHat } = await import("./hats");
    const hat = await hatsHat(env as never, capacity.trustee_ref).catch(() => null);
    if (!hat || "error" in hat) {
      warnings.push(`trustee_ref ${capacity.trustee_ref} did not resolve to a hat — check HATS_CONTRACT/org`);
    }
  }
  return {
    hash, repo, canonical, record, warnings: warnings.length ? warnings : undefined, intent_urls: intentUrls(canonical),
    ...(a.confidential ? {
      // Trustless blind funding: the funder escrows from a FRESH
      // implicit account via Intents — ops custody never involved.
      escrow_plan: `/api/declarations/${hash}/escrow-plan`,
      escrow_note: "self-funded path preferred — fresh implicit account + 1Click deposit; on-chain payer has no history and ops never sees the funder",
    } : {}),
    ...(poolMatch ? { pool_match: poolMatch } : {}),
    watch_hint: "After posting, run surf_watch on the thread (or POST sightings) so claims/receipts on this declaration are ingested — watchers earn sighting_bps when it funds.",
  };
}

/** Zero-auth broadcast: platform intent URLs the funder opens to post. */
function intentUrls(text: string) {
  const t = encodeURIComponent(text.slice(0, 280));
  return {
    x: `https://x.com/intent/tweet?text=${t}`,
    bluesky: `https://bsky.app/intent/compose?text=${t}`,
    mastodon: `https://mastodonshare.com/?text=${t}`,
    nostr: `nostr:${t}`,
    hackernews: `https://news.ycombinator.com/submitlink?t=${t}`,
    // the fyi composer cross-posts to all 27 OAuth-connected platforms
    gateway: `https://widespread.fyi/?text=${t}`,
  };
}

export async function bountyBroadcast(env: Env, a: DeclareArgs) {
  const d = await bountyDeclare(env, a);
  if ("error" in d) return d;
  return { ...d, instructions: "Open each intent URL (or post the canonical text manually) — every surface the declaration lands on is ingested by the feed scanners; one escrow, one payout." };
}

/** Load a declared bounty (feed scanners + claim path). */
export async function getDeclared(env: Env, hash: string): Promise<Bounty | null> {
  return env.CLAIMS.get(`decl:${hash}`, "json");
}

/** Claim-gated spec reveal for confidential markets. A registered agent
 *  signs `widespread-spec-reveal\n{hash}\n{x25519_pubkey}` — the bridge
 *  returns the spec crypto_box_seal'd to that x25519 pubkey and logs the
 *  reveal so the funder can see who peeked. Plaintext crosses only this
 *  boundary; the public record never carries it. */
export async function specReveal(
  env: Env,
  a: { hash?: string; agent_pubkey?: string; x25519_pubkey?: string; signature_hex?: string },
): Promise<Record<string, unknown>> {
  if (!a.hash || !a.agent_pubkey || !a.x25519_pubkey || !a.signature_hex) {
    return { error: "hash, agent_pubkey, x25519_pubkey, signature_hex required" };
  }
  const bounty = await getDeclared(env, a.hash);
  if (!bounty) return { error: "declaration not found" };
  if (!bounty.confidential) return { error: "market is not confidential — the spec is already public" };

  const { isHex, sealTo, bridgeX25519PublicKey } = await import("./sealed");
  if (!isHex(a.x25519_pubkey, 32)) return { error: "x25519_pubkey must be 64 hex chars" };
  if (!isHex(a.agent_pubkey, 32) || !isHex(a.signature_hex, 64)) {
    return { error: "agent_pubkey 64-hex + signature_hex 128-hex required" };
  }
  // Gate: the claimant must be a registered agent — a real identity in
  // the protocol, not a throwaway key.
  const reg = await env.CLAIMS.get(`agent:${a.agent_pubkey}`, "json").catch(() => null);
  if (!reg) return { error: "agent not registered — run wide_agent_challenge + wide_agent_register first" };

  const { ed25519 } = await import("@noble/curves/ed25519");
  const hexToBytes = (h: string) => {
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return b;
  };
  const canonical = `widespread-spec-reveal\n${a.hash}\n${a.x25519_pubkey.toLowerCase()}`;
  const ok = ed25519.verify(hexToBytes(a.signature_hex), new TextEncoder().encode(canonical), hexToBytes(a.agent_pubkey));
  if (!ok) return { error: "signature invalid — sign `widespread-spec-reveal\\n<hash>\\n<x25519_pubkey>` with your agent key" };

  // Access log — the funder's audit of who peeked at the sealed spec.
  const logKey = `specreveal:${a.hash}:${a.agent_pubkey.slice(0, 16)}`;
  await env.CLAIMS.put(logKey, JSON.stringify({
    hash: a.hash, agent_pubkey: a.agent_pubkey, did: (reg as { did?: string }).did ?? null,
    x25519_pubkey: a.x25519_pubkey, revealed_at: Date.now(),
  })).catch(() => {});

  return {
    ok: true, hash: a.hash,
    spec_sealed_b64: sealTo(new TextEncoder().encode(bounty.spec), a.x25519_pubkey),
    bridge_x25519_pubkey: bridgeX25519PublicKey(env),
    note: "Open with your x25519 secret (crypto_box_seal_open). Seal deliverables to the market's funder_x25519_pubkey + bridge_x25519_pubkey.",
  };
}
export async function getDeclaredRecord(env: Env, hash: string): Promise<FeedRecord | null> {
  return env.CLAIMS.get(`feedrec:decl:${hash}`, "json");
}
