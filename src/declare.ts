// declare.ts — surface-agnostic bounty declarations.
// A declaration is canonical text (specHash + tag) the funder can paste
// on ANY surface — forge issue, tweet, nostr note, blog post. Scanners
// or the manual bind link it to the market. Domain picks the verifier.

import type { Env, Bounty, FeedRecord } from "./types";
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
   * publish (deliverable must appear on the target profile). */
  deliverable_class?: "draft" | "publish";
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
  const target = a.target_platform && a.target_handle
    ? { platform: a.target_platform.toLowerCase(), handle: a.target_handle.replace(/^@/, "") }
    : null;
  const bound = target ? await resolveHandle(env, target.platform, target.handle) : null;
  const canonical = [
    `#${tag} bounty ${hash}`,
    `domain: ${domain}`,
    `amount: ${a.amount} ${a.currency ?? "USD"}`,
    `spec: ${a.spec}`,
    target ? `for: ${target.platform} @${target.handle}` : null,
    target && deliverable === "draft" ? `deliverable: draft text (you publish)` : null,
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
    deliverable_class: target ? deliverable : undefined,
    funder_did: a.funder_did,
    created_at: Date.now(),
  };
  await env.CLAIMS.put(`decl:${hash}`, JSON.stringify(bounty));
  await env.CLAIMS.put(`declhash:${repo}`, hash);

  const record: FeedRecord = {
    id, source: "declared", forge: "generic", kind: "bounty",
    title: a.spec.slice(0, 120), spec: a.spec,
    amount: a.amount, currency: a.currency ?? "USD",
    escrow: { state: "label-only" },
    verification: { required: domain === "code" ? "forge ship op" : deliverable === "draft" ? "text-draft" : "platform-url", spec_hash: hash },
    url: `https://widespread-bridge.widespread.workers.dev/api/declarations/${hash}`,
    claim: { how: `reply "widespread claim ${hash}" or via MCP wide_claim`, grammar: "widespread claim <hash>" },
    domain,
    for: target ? { ...target, bound: !!bound } : undefined,
    deliverable_class: target ? deliverable : undefined,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.CLAIMS.put(`feedrec:${id}`, JSON.stringify(record));
  const warnings: string[] = [];
  if (target && !bound) warnings.push(`target ${target.platform}/@${target.handle} is not bound — funder should POST /api/identity/bind so style/history verification can run`);
  return { hash, repo, canonical, record, warnings: warnings.length ? warnings : undefined, intent_urls: intentUrls(canonical) };
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
