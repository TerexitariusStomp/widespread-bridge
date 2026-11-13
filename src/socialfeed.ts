// socialfeed.ts — scanners that ingest bounty DECLARATIONS from social
// surfaces (any domain, not just media). Free/open APIs first; every
// source fails independently. Declaration syntax:
//   #widespread bounty <hash>
//   domain: <domain>   amount: <n> <ccy>   spec: <text>
// Replies carrying "widespread claim <hash>" or a deliverable URL are
// recorded as claim hints for zero-account humans.

import type { Env, FeedRecord, SocialEnv } from "./types";
import { parseBindStatement, registerBinding } from "./identity";

const DECL_RE = /#widespread\s+bounty\s+([0-9a-f]{8,16})|domain:\s*(\w+)[\s\S]*?amount:\s*([\d.]+)\s*([A-Z]{3,5})/i;
const CLAIM_RE = /widespread\s+claim\s+([0-9a-f]{8,16})/i;
const BIND_TAG = "widespread-bind:v1";
const now = () => Date.now();

function declRecord(hash: string, platform: string, url: string, body: string, actor?: string): FeedRecord {
  const m = body.match(DECL_RE);
  return {
    id: `social:${platform}:${hash}`,
    source: `social-${platform}`, forge: "generic", kind: "bounty",
    title: body.split("\n").find((l) => l.trim())?.replace(/^#+\s*\w+\s+bounty\s+\w+/i, "").trim().slice(0, 120) || `${platform} bounty`,
    spec: body.slice(0, 2000),
    amount: m?.[3], currency: m?.[4],
    escrow: { state: "label-only" },
    verification: { required: "declaration-parse", spec_hash: hash },
    url, claim: { how: `reply "widespread claim ${hash}" on this post`, grammar: "widespread claim <hash>" },
    domain: m?.[2]?.toLowerCase(),
    created_at: now(), updated_at: now(),
  };
}

/** A bind statement posted natively on the claimed platform IS its own
 * proof — the post URL goes through the same verifier registry. */
async function noteBind(env: Env, text: string, url: string) {
  if (!text.includes(BIND_TAG)) return;
  const b = parseBindStatement(text);
  if (b) await registerBinding(env, { did: b.did, platform: b.platform, handle: b.handle, proof: url }).catch(() => null);
}

async function noteClaim(env: Env, hash: string, platform: string, actor: string, url: string, kind: "claim" | "submission") {
  const key = `hclaim:${hash}`;
  const list = (await env.CLAIMS.get(key, "json").catch(() => null)) as unknown[] ?? [];
  if (list.length < 100) {
    list.push({ kind, platform, actor, url, at: now() });
    await env.CLAIMS.put(key, JSON.stringify(list));
  }
}

// --- bluesky (free public api) ------------------------------------------------
export async function pollBluesky(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  const q = "%23widespread";
  const r = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${q}&limit=25&sort=latest`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { posts?: { uri: string; author: { handle: string }; record: { text?: string } }[] } | null;
  for (const p of j?.posts ?? []) {
    const text = p.record?.text ?? "";
    const url = `https://bsky.app/profile/${p.author.handle}/post/${p.uri.split("/").pop()}`;
    const dm = text.match(DECL_RE);
    if (dm) out.push(declRecord(dm[1] ?? "unknown", "bluesky", url, text, p.author.handle));
    const cm = text.match(CLAIM_RE);
    if (cm) await noteClaim(env, cm[1], "bluesky", p.author.handle, url, text.includes("http") ? "submission" : "claim");
    await noteBind(env, text, url);
  }
  return out;
}

// --- mastodon (public tag timeline on configured instances) -------------------
export async function pollMastodon(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  const insts = ((env as SocialEnv).MASTODON_INSTANCES ?? "mastodon.social,hachyderm.io").split(",");
  for (const inst of insts.slice(0, 4)) {
    const r = await fetch(`https://${inst.trim()}/api/v1/timelines/tag/widespread?limit=20`).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { id: string; url: string; content: string; account: { acct: string } }[] | null;
    if (!Array.isArray(j)) continue;
    for (const s of j) {
      const text = s.content.replace(/<[^>]+>/g, "");
      const dm = text.match(DECL_RE);
      if (dm) out.push(declRecord(dm[1] ?? "unknown", `mastodon:${inst}`, s.url, text, s.account.acct));
      const cm = text.match(CLAIM_RE);
      if (cm) await noteClaim(env, cm[1], `mastodon:${inst}`, s.account.acct, s.url, text.includes("http") ? "submission" : "claim");
      await noteBind(env, text, s.url);
    }
  }
  return out;
}

// --- nostr (relay query via nostr-tools; signed notes self-verify) ------------
export async function pollNostr(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  try {
    const { SimplePool } = await import("nostr-tools");
    const pool = new SimplePool();
    const relays = ((env as SocialEnv).NOSTR_RELAYS ?? "wss://relay.damus.io,wss://nos.lol").split(",");
    const events = await pool.querySync(relays.map((x: string) => x.trim()), { "#t": ["widespread"], limit: 20 });
    for (const e of events ?? []) {
      const dm = e.content.match(DECL_RE);
      const url = `https://njump.me/${e.id}`;
      if (dm) out.push(declRecord(dm[1] ?? "unknown", "nostr", url, e.content, e.pubkey.slice(0, 8)));
      const cm = e.content.match(CLAIM_RE);
      if (cm) await noteClaim(env, cm[1], "nostr", e.pubkey.slice(0, 8), url, e.content.includes("http") ? "submission" : "claim");
      await noteBind(env, e.content, e.id);
    }
    pool.close(relays.map((x: string) => x.trim()));
  } catch { /* nostr optional — relay unreachable is not fatal */ }
  return out;
}

// --- rss (configured watch feeds — blogs/newsletters carrying declarations) ---
export async function pollRss(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  const feeds = ((env as SocialEnv).RSS_WATCH ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (!feeds.length) return out;
  const { default: Parser } = await import("rss-parser");
  const parser = new Parser();
  for (const u of feeds.slice(0, 8)) {
    const feed = await parser.parseURL(u).catch(() => null);
    for (const item of feed?.items ?? []) {
      const text = `${item.title ?? ""}\n${item.contentSnippet ?? item.content ?? ""}`;
      const dm = text.match(DECL_RE);
      if (dm) out.push(declRecord(dm[1] ?? "unknown", `rss:${new URL(u).hostname}`, item.link ?? u, text));
    }
  }
  return out;
}
