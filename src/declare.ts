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
  /** MORE capacity objective (Stage A, docs/more-alignment.md §2 P1).
   *  Optional — untagged markets behave exactly as before. `dims` without
   *  `evidence_plan` is legal but marks the market unverifiable-
   *  contribution: visible class, not silent greenwash. */
  capacity?: CapacityTag;
  /** Convenience: comma-separated dims ("C_k,C_h") — merged into
   *  capacity.dims when `capacity` isn't given. */
  dims?: string;
}

const CAPACITY_DIMS = new Set(["C_e", "C_h", "C_k", "C_inst", "C_m"]);

/** Normalize declared capacity: validate dims, attach evidence_plan
 *  requirement signal. Returns null when nothing was declared. */
function normalizeCapacity(a: DeclareArgs): CapacityTag | null {
  const dims = new Set<CapacityDim>();
  for (const d of a.capacity?.dims ?? []) if (CAPACITY_DIMS.has(d)) dims.add(d);
  if (a.dims) for (const d of a.dims.split(",")) {
    const t = d.trim() as CapacityDim;
    if (CAPACITY_DIMS.has(t)) dims.add(t);
  }
  if (!dims.size && !a.capacity) return null;
  const cap: CapacityTag = {
    dims: [...dims],
    ...(a.capacity?.subsystem ? { subsystem: a.capacity.subsystem } : {}),
    ...(a.capacity?.floor_attestation ? { floor_attestation: a.capacity.floor_attestation } : {}),
    ...(a.capacity?.evidence_plan ? { evidence_plan: a.capacity.evidence_plan } : {}),
    ...(a.capacity?.trustee_ref ? { trustee_ref: a.capacity.trustee_ref } : {}),
  };
  return cap;
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
  const capacity = normalizeCapacity(a);
  const flags = floorFlags(a.spec);
  const canonical = [
    `#${tag} bounty ${hash}`,
    `domain: ${domain}`,
    `amount: ${a.amount} ${a.currency ?? "USD"}`,
    `spec: ${a.spec}`,
    deliverable === "resource" ? `meter:${a.meter} threshold:${a.threshold}${a.window ? ` window:${a.window}` : ""}` : null,
    target ? `for: ${target.platform} @${target.handle}` : null,
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
    funder_did: a.funder_did,
    ...(a.sighting_bps ? { sighting_bps: Math.min(1000, Math.max(0, Math.round(a.sighting_bps))) } : {}),
    ...(capacity ? { capacity } : {}),
    ...(flags.length ? { floor_flags: flags } : {}),
    created_at: Date.now(),
  };
  await env.CLAIMS.put(`decl:${hash}`, JSON.stringify(bounty));
  await env.CLAIMS.put(`declhash:${repo}`, hash);

  const record: FeedRecord = {
    id, source: "declared", forge: "generic", kind: "bounty",
    title: a.spec.slice(0, 120), spec: a.spec,
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
    for: target ? { ...target, bound: !!bound } : undefined,
    deliverable_class: deliverable === "resource" ? "resource" : (target ? deliverable : undefined),
    ...(capacity ? { capacity } : {}),
    ...(flags.length ? { floor_flags: flags } : {}),
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.CLAIMS.put(`feedrec:${id}`, JSON.stringify(record));
  const warnings: string[] = [];
  if (target && !bound) warnings.push(`target ${target.platform}/@${target.handle} is not bound — funder should POST /api/identity/bind so style/history verification can run`);
  return {
    hash, repo, canonical, record, warnings: warnings.length ? warnings : undefined, intent_urls: intentUrls(canonical),
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
export async function getDeclaredRecord(env: Env, hash: string): Promise<FeedRecord | null> {
  return env.CLAIMS.get(`feedrec:decl:${hash}`, "json");
}
