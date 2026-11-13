// declare.ts — surface-agnostic bounty declarations.
// A declaration is canonical text (specHash + tag) the funder can paste
// on ANY surface — forge issue, tweet, nostr note, blog post. Scanners
// or the manual bind link it to the market. Domain picks the verifier.

import type { Env, Bounty, FeedRecord } from "./types";

const tag = "widespread";

export interface DeclareArgs {
  domain?: string;             // code | social-media | research | writing | design | data | other
  spec: string;                // task spec / acceptance rules
  amount: string;
  currency?: string;
  verification?: { class?: string; params?: Record<string, unknown> };
  payer_email?: string;        // for fiat mirrors (PayPal)
  funder_handle?: string;
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
  const canonical = [
    `#${tag} bounty ${hash}`,
    `domain: ${domain}`,
    `amount: ${a.amount} ${a.currency ?? "USD"}`,
    `spec: ${a.spec}`,
    a.verification?.params?.nonce ? `nonce: ${a.verification.params.nonce}` : null,
    `claim: reply "widespread claim ${hash}" or POST your deliverable URL`,
  ].filter(Boolean).join("\n");

  const bounty: Bounty = {
    repo, amount: a.amount, currency: a.currency ?? "USD",
    receiver_email: a.payer_email ?? "",
    spec: a.spec,
    proof_requirements: domain === "code" ? undefined : [{ type: "platform-url", note: "deliverable = published artifact URL" } as never],
    work_id: hash,
    created_at: Date.now(),
  };
  await env.CLAIMS.put(`decl:${hash}`, JSON.stringify(bounty));
  await env.CLAIMS.put(`declhash:${repo}`, hash);

  const record: FeedRecord = {
    id, source: "declared", forge: "generic", kind: "bounty",
    title: a.spec.slice(0, 120), spec: a.spec,
    amount: a.amount, currency: a.currency ?? "USD",
    escrow: { state: "label-only" },
    verification: { required: domain === "code" ? "forge ship op" : "platform-url", spec_hash: hash },
    url: `https://widespread-bridge.widespread.workers.dev/api/declarations/${hash}`,
    claim: { how: `reply "widespread claim ${hash}" or via MCP wide_claim`, grammar: "widespread claim <hash>" },
    domain,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await env.CLAIMS.put(`feedrec:${id}`, JSON.stringify(record));
  return { hash, repo, canonical, record, intent_urls: intentUrls(canonical) };
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
