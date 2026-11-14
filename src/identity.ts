// identity.ts — trust-minimized cross-surface identity bindings.
//
// A binding links a Widespread DID to a platform handle through a publicly
// re-verifiable proof — never inferred from name/style similarity. The
// bridge holds no authority: anyone can re-run the verifier against the
// platform's public API or the signature itself.
//
// Canonical bind statement (posted on the platform, or signed):
//   widespread-bind:v1
//   did:<did>
//   <platform>/<handle>
//
// Tiers (see COMPETITORS.md):
//   native — protocol identity carries the proof (atproto DID, nostr sig)
//   sig    — statement signed by the chain/account key (evm, solana, near)
//   proof  — statement published by the account, author-verified via API
//   weak   — gated platform; statement found but author check best-effort
//
// Asymmetry: workers stay pseudonymous; funders must bind the profile a
// cross-platform task targets ("ghostwrite for my handle" needs a target).

import type { Env } from "./types";

export type BindTier = "native" | "sig" | "proof" | "weak";

export interface IdentityBinding {
  did: string;
  platform: string;
  handle: string;
  tier: BindTier;
  proof: string;             // proof URL, note id, or JSON signature blob
  verified_at: number;
  revoked_at?: number;
  evidence?: Record<string, unknown>;
}

export interface BindInput {
  did: string;
  platform: string;
  handle: string;
  proof: string;
}

const BIND_TAG = "widespread-bind:v1";
const BIND_RE = /widespread-bind:v1\s+did:([^\s<"']+)\s+([\w.-]+)\/([^\s<"']+)/i;

/** Canonical statement the account must publish/sign. */
export function bindStatement(did: string, platform: string, handle: string): string {
  return `${BIND_TAG}\ndid:${did}\n${platform}/${handle}`;
}

/** Extract (did, platform, handle) from any text carrying a bind statement. */
export function parseBindStatement(text: string): { did: string; platform: string; handle: string } | null {
  const m = text.match(BIND_RE);
  return m ? { did: m[1], platform: m[2].toLowerCase(), handle: m[3].replace(/[)\]<>,.;:!?"']+$/, "") } : null;
}

const stmtPresent = (text: string, did: string, platform: string, handle: string) => {
  const p = parseBindStatement(text);
  return !!p && p.did === did && p.platform === platform.toLowerCase() &&
    p.handle.toLowerCase() === handle.toLowerCase();
};

const b58chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const c of s) {
    const v = b58chars.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
const hexBytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

type Ctx = { env: Env };
type VerifyResult = { ok: boolean; tier: BindTier; evidence: Record<string, unknown>; error?: string };
const bad = (tier: BindTier, error: string, evidence: Record<string, unknown> = {}): VerifyResult =>
  ({ ok: false, tier, evidence, error });

const fetchJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init).catch(() => null);
  return (r?.ok ? await r.json().catch(() => null) : null) as Record<string, unknown> | null;
};

// ---------------------------------------------------------------- verifiers
// Each verifier answers the domain-pack shape: resolve the proof → check the
// statement was authored/signed by the claimed handle → return tier+evidence.

async function vGithub({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  // gist: gist.github.com/<user>/<id> — authoritative author field
  const g = proof.match(/gist\.github\.com\/[\w-]+\/([0-9a-f]{20,})/i) ?? proof.match(/gist\.githubusercontent\.com.*([0-9a-f]{32})/);
  if (g) {
    const j = await fetchJson(`https://api.github.com/gists/${g[1]}`);
    const login = (j?.owner as { login?: string } | undefined)?.login;
    if (!login) return bad("proof", "gist not found", ev);
    const files = Object.values((j?.files as Record<string, { content?: string }>) ?? {});
    if (login.toLowerCase() !== handle.toLowerCase()) return bad("proof", `gist author @${login} != ${handle}`, ev);
    if (!files.some((f) => stmtPresent(f.content ?? "", did, platform, handle))) return bad("proof", "bind statement not in gist", ev);
    return { ok: true, tier: "proof", evidence: { ...ev, gist_id: g[1], author: login } };
  }
  // issue/PR comment: github.com/o/r/(issues|pull)/N#issuecomment-M
  const c = proof.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)/);
  if (c) {
    const j = await fetchJson(`https://api.github.com/repos/${c[1]}/${c[2]}/issues/comments/${c[4]}`);
    const login = (j?.user as { login?: string } | undefined)?.login;
    const body = String(j?.body ?? "");
    if (!login) return bad("proof", "comment not found", ev);
    if (login.toLowerCase() !== handle.toLowerCase()) return bad("proof", `comment author @${login} != ${handle}`, ev);
    if (!stmtPresent(body, did, platform, handle)) return bad("proof", "bind statement not in comment", ev);
    return { ok: true, tier: "proof", evidence: { ...ev, comment_id: c[4], author: login } };
  }
  return bad("proof", "proof must be a gist or issue/PR comment URL", ev);
}

async function vGitlab({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(https?:\/\/[\w.-]+)\/.*-\/snippets\/(\d+)/);
  if (!m) return bad("proof", "proof must be a gitlab snippet URL", ev);
  const j = await fetchJson(`${m[1]}/api/v4/snippets/${m[2]}`);
  const user = (j?.author as { username?: string } | undefined)?.username;
  if (!user) return bad("proof", "snippet not found", ev);
  const raw = await fetch(`${m[1]}/api/v4/snippets/${m[2]}/raw`).then((r) => r.text()).catch(() => "");
  if (user.toLowerCase() !== handle.toLowerCase()) return bad("proof", `snippet author @${user} != ${handle}`, ev);
  if (!stmtPresent(raw, did, platform, handle)) return bad("proof", "bind statement not in snippet", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, snippet_id: m[2], author: user } };
}

// forgejo/gitea/codeberg: issue comment on any gitea-compatible host
async function vForgejo({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const c = proof.match(/(https?:\/\/[\w.-]+)\/([\w.-]+)\/([\w.-]+)\/(?:issues|pulls)\/(\d+)/);
  if (!c) return bad("proof", "proof must be a forge issue/pull URL containing a comment", ev);
  const comments = await fetchJson(`${c[1]}/api/v1/repos/${c[2]}/${c[3]}/issues/${c[4]}/comments`) as unknown;
  for (const cm of Array.isArray(comments) ? comments as { body?: string; user?: { login?: string } }[] : []) {
    if (cm.body && stmtPresent(cm.body, did, platform, handle)) {
      const login = cm.user?.login ?? "";
      if (login.toLowerCase() !== handle.toLowerCase()) return bad("proof", `statement author @${login} != ${handle}`, ev);
      return { ok: true, tier: "proof", evidence: { ...ev, author: login } };
    }
  }
  // repo file fallback — proves repo write access only
  const raw = proof.replace(/\/(src|blob)\/branch\//, "/raw/branch/").replace("/src/branch/", "/raw/branch/");
  const text = await fetch(raw).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  if (text && stmtPresent(text, did, platform, handle)) {
    return { ok: true, tier: "weak", evidence: { ...ev, note: "repo-file proof — author not verified" } };
  }
  return bad("proof", "bind statement not found in issue comments or file", ev);
}

async function vBluesky({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/bsky\.app\/profile\/([\w.-]+)\/post\/([\w]+)/) ?? proof.match(/at:\/\/([\w.]+)\/app\.bsky\.feed\.post\/([\w]+)/);
  if (!m) return bad("proof", "proof must be a bsky post URL or at:// uri", ev);
  const uri = `at://${m[1]}/app.bsky.feed.post/${m[2]}`;
  const j = await fetchJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0`);
  const post = (j?.thread as { post?: { author?: { handle?: string; did?: string }; record?: { text?: string } } } | undefined)?.post;
  if (!post) return bad("proof", "post not found", ev);
  const author = post.author?.handle ?? "";
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `post author @${author} != ${handle}`, ev);
  const text = post.record?.text ?? "";
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in post", ev);
  // native upgrade: the bound DID IS the account's atproto DID
  const tier: BindTier = post.author?.did === did ? "native" : "proof";
  return { ok: true, tier, evidence: { ...ev, author, atproto_did: post.author?.did, post_uri: uri } };
}

async function vNostr({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { proof: proof.slice(0, 80) };
  try {
    const { SimplePool, verifyEvent, nip19 } = await import("nostr-tools");
    let id = proof.trim();
    if (/^(note|nevent)1/.test(id)) {
      const d = nip19.decode(id);
      id = d.type === "note" ? (d.data as string) : (d.data as { id: string }).id;
    }
    const relays = ["wss://relay.damus.io", "wss://nos.lol"];
    const pool = new SimplePool();
    const e = await pool.get(relays, { ids: [id] }).catch(() => null);
    pool.close(relays);
    if (!e) return bad("sig", "note not found on relays", ev);
    if (!verifyEvent(e)) return bad("sig", "invalid event signature", ev);
    let want = handle;
    if (/^npub1/.test(handle)) want = nip19.decode(handle).data as string;
    if (e.pubkey !== want) return bad("sig", `note author ${e.pubkey.slice(0, 8)}… != ${want.slice(0, 8)}…`, ev);
    if (!stmtPresent(e.content, did, platform, handle)) return bad("sig", "bind statement not in note", ev);
    const tier: BindTier = did === `did:nostr:${e.pubkey}` || did === e.pubkey ? "native" : "sig";
    return { ok: true, tier, evidence: { ...ev, event_id: e.id, pubkey: e.pubkey } };
  } catch (err) {
    return bad("sig", `nostr verify failed: ${(err as Error).message}`, ev);
  }
}

async function vMastodon({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/https?:\/\/([\w.-]+)\/@[\w@.-]+\/(\d+)/);
  if (!m) return bad("proof", "proof must be a mastodon status URL", ev);
  const j = await fetchJson(`https://${m[1]}/api/v1/statuses/${m[2]}`);
  const acct = (j?.account as { acct?: string } | undefined)?.acct;
  if (!j?.id || !acct) return bad("proof", "status not found", ev);
  const want = handle.replace(/^@/, "").split("@")[0];
  if (acct.split("@")[0].toLowerCase() !== want.toLowerCase()) return bad("proof", `status author @${acct} != ${handle}`, ev);
  const text = String(j?.content ?? "").replace(/<[^>]+>/g, "");
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in status", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, status_id: j.id, author: acct } };
}

async function vX({ did, platform, handle, proof }: BindInput, env: Env): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(?:x|twitter)\.com\/\w+\/status(?:es)?\/(\d+)/);
  if (!m) return bad("proof", "proof must be an x status URL", ev);
  const bearer = env.X_BEARER_TOKEN;
  if (bearer) {
    const j = await fetchJson(`https://api.x.com/2/tweets/${m[1]}?tweet.fields=author_id,text&expansions=author_id&user.fields=username`,
      { headers: { authorization: `Bearer ${bearer}` } });
    const user = ((j?.includes as { users?: { username?: string }[] } | undefined)?.users ?? [])[0]?.username;
    const text = String((j?.data as { text?: string } | undefined)?.text ?? "");
    if (user && text) {
      if (user.toLowerCase() !== handle.toLowerCase()) return bad("proof", `tweet author @${user} != ${handle}`, ev);
      if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in tweet", ev);
      return { ok: true, tier: "proof", evidence: { ...ev, tweet_id: m[1], author: user } };
    }
  }
  const j = await fetchJson(`https://publish.twitter.com/oembed?url=https://x.com/i/status/${m[1]}`);
  const html = String(j?.html ?? "");
  if (!html) return bad("weak", "status not found (oembed)", ev);
  const acct = html.match(/—\s*[^<]*\(@(\w+)\)/)?.[1];
  if (acct && acct.toLowerCase() !== handle.toLowerCase()) return bad("weak", `tweet author @${acct} != ${handle}`, ev);
  if (!stmtPresent(html.replace(/<[^>]+>/g, " "), did, platform, handle)) {
    return bad("weak", "statement not readable via oembed — set X_BEARER_TOKEN for proof tier", { ...ev, author: acct });
  }
  return { ok: true, tier: "weak", evidence: { ...ev, author: acct, note: "oembed — author verified, text truncated" } };
}

async function vHn({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/item\?id=(\d+)/);
  if (!m) return bad("proof", "proof must be a news.ycombinator.com/item?id= URL", ev);
  const j = await fetchJson(`https://hn.algolia.com/api/v1/items/${m[1]}`);
  const author = j?.author as string | undefined;
  const text = String(j?.text ?? "");
  if (!j?.id) return bad("proof", "item not found", ev);
  if (author?.toLowerCase() !== handle.toLowerCase()) return bad("proof", `item author ${author} != ${handle}`, ev);
  if (!stmtPresent(text.replace(/<[^>]+>/g, ""), did, platform, handle)) return bad("proof", "bind statement not in comment", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, item_id: m[1], author } };
}

async function vEvm({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { scheme: "eip-191" };
  try {
    const { verifyMessage } = await import("viem");
    const sig = (proof.match(/0x[0-9a-fA-F]{130}/) ?? [])[0];
    if (!sig) return bad("sig", "proof must contain a 65-byte hex signature (EIP-191)", ev);
    const ok = await verifyMessage({ address: handle as `0x${string}`, message: bindStatement(did, platform, handle), signature: sig as `0x${string}` });
    if (!ok) return bad("sig", "signature does not recover to handle", ev);
    return { ok: true, tier: "sig", evidence: { ...ev, address: handle } };
  } catch (err) {
    return bad("sig", `evm verify failed: ${(err as Error).message}`, ev);
  }
}

async function vEd25519Chain(chain: string, { did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  // solana / near: ed25519 signature over the bind statement. proof JSON:
  //   {"pubkey":"<base58|hex>","sig":"<base64|hex>"}
  const ev: Record<string, unknown> = { scheme: `${chain}-ed25519` };
  try {
    const p = JSON.parse(proof) as { pubkey?: string; sig?: string };
    const msg = new TextEncoder().encode(bindStatement(did, platform, handle));
    const pkBytes = /^[0-9a-f]{64}$/i.test(p.pubkey ?? "") ? hexBytes(p.pubkey!) : b58decode((p.pubkey ?? handle).replace(/^ed25519:/, ""));
    const sigBytes = /^[0-9a-f]{128}$/i.test(p.sig ?? "") ? hexBytes(p.sig!) : new Uint8Array(atob(p.sig ?? "").split("").map((c) => c.charCodeAt(0)));
    if (pkBytes.length !== 32 || sigBytes.length !== 64) return bad("sig", "bad key/sig length", ev);
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    if (!ed25519.verify(sigBytes, msg, pkBytes)) return bad("sig", "invalid signature", ev);
    if (p.pubkey && p.pubkey !== handle && chain === "solana") return bad("sig", "pubkey != handle", ev);
    return { ok: true, tier: "sig", evidence: { ...ev, pubkey: p.pubkey ?? handle } };
  } catch (err) {
    return bad("sig", `${chain} verify failed: ${(err as Error).message}`, ev);
  }
}

// lemmy: statement in a post/comment on any instance → author.name
async function vLemmy({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(https?:\/\/[\w.-]+)\/(post|comment)\/(\d+)/);
  if (!m) return bad("proof", "proof must be a lemmy post/comment URL", ev);
  const j = await fetchJson(`${m[1]}/api/v3/${m[2]}?id=${m[3]}`) as Record<string, any> | null;
  const view = j?.[`${m[2]}_view`];
  if (!view) return bad("proof", "object not found", ev);
  const author = view.creator?.name ?? "";
  const text = view[m[2]]?.body ?? view[m[2]]?.content ?? view[m[2]]?.name ?? "";
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `author @${author} != ${handle}`, ev);
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in object", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// misskey: statement in a note → note.user.username
async function vMisskey({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(https?:\/\/[\w.-]+)\/notes\/(\w+)/);
  if (!m) return bad("proof", "proof must be a misskey note URL", ev);
  const r = await fetch(`${m[1]}/api/notes/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noteId: m[2] }) }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { user?: { username?: string }; text?: string } | null;
  if (!j?.user) return bad("proof", "note not found", ev);
  if ((j.user.username ?? "").toLowerCase() !== handle.toLowerCase()) return bad("proof", `note author @${j.user.username} != ${handle}`, ev);
  if (!stmtPresent(j.text ?? "", did, platform, handle)) return bad("proof", "bind statement not in note", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author: j.user.username } };
}

// peertube: statement in a video description → channel name
async function vPeertube({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(https?:\/\/[\w.-]+)\/(?:w|videos\/watch)\/([\w-]+)/);
  if (!m) return bad("proof", "proof must be a peertube video URL", ev);
  const j = await fetchJson(`${m[1]}/api/v1/videos/${m[2]}`) as any;
  const author = j?.channel?.name ?? j?.account?.name ?? "";
  if (!author) return bad("proof", "video not found", ev);
  const text = `${j?.name ?? ""}\n${j?.description ?? ""}`;
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `channel @${author} != ${handle}`, ev);
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in video", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// wordpress: statement in a post → _embedded author slug
async function vWordpress({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const u = new URL(proof);
  const pid = u.searchParams.get("p");
  const slug = u.pathname.split("/").filter(Boolean).pop();
  const base = `${u.protocol}//${u.host}`;
  const api = pid ? `${base}/wp-json/wp/v2/posts/${pid}?_embed=1` : `${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug ?? "")}&_embed=1`;
  const j = await fetchJson(api) as any;
  const post = Array.isArray(j) ? j[0] : j;
  if (!post?.id) return bad("proof", "post not found via wp-json", ev);
  const author = post._embedded?.author?.[0]?.slug ?? post._embedded?.author?.[0]?.name ?? "";
  const text = (post.content?.rendered ?? "").replace(/<[^>]+>/g, "");
  if (author && author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `author @${author} != ${handle}`, ev);
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in post", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// dev.to: statement in an article → user.username
async function vDevto({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/dev\.to\/([\w-]+)\/([\w-]+)/);
  if (!m) return bad("proof", "proof must be a dev.to article URL", ev);
  const list = await fetchJson(`https://dev.to/api/articles?username=${m[1]}&per_page=30`) as { slug?: string; id?: number }[] | null;
  const id = (Array.isArray(list) ? list : []).find((a) => a.slug === m[2])?.id;
  const j = await fetchJson(`https://dev.to/api/articles/${id ?? m[2]}`) as any;
  const author = j?.user?.username;
  if (!author) return bad("proof", "article not found", ev);
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `author @${author} != ${handle}`, ev);
  if (!stmtPresent(`${j.title ?? ""}\n${j.body_markdown ?? ""}`, did, platform, handle)) return bad("proof", "bind statement not in article", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// hashnode: statement in a post → author.username
async function vHashnode({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const m = proof.match(/(https?:\/\/[\w.-]+)\/([\w-]+)/);
  if (!m) return bad("proof", "proof must be a hashnode post URL", ev);
  const host = m[1].includes("hashnode") ? new URL(m[1]).host : `${new URL(m[1]).host}`;
  const r = await fetch("https://gql.hashnode.com", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ publication(host: "${host}") { post(slug: "${m[2]}") { title author { username } content { markdown } } } }` }) }).catch(() => null);
  const post = ((await r?.json().catch(() => null)) as any)?.data?.publication?.post;
  if (!post) return bad("proof", "post not found", ev);
  const author = post.author?.username ?? "";
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `author @${author} != ${handle}`, ev);
  if (!stmtPresent(`${post.title ?? ""}\n${post.content?.markdown ?? ""}`, did, platform, handle)) return bad("proof", "bind statement not in post", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// hive/steem: statement ON-CHAIN → author is the account itself (proof-strong)
async function vHiveChain(chain: string, api: string, { did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof, chain };
  const m = proof.match(/@([\w.-]+)\/([\w-]+)/);
  if (!m) return bad("proof", `proof must be a ${chain} @author/permlink URL`, ev);
  const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_content", params: [m[1], m[2]] }) }).catch(() => null);
  const post = ((await r?.json().catch(() => null)) as any)?.result;
  if (!post?.author) return bad("proof", "on-chain content not found", ev);
  if (post.author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `author @${post.author} != ${handle}`, ev);
  const text = `${post.title ?? ""}\n${post.body ?? ""}`;
  if (!stmtPresent(text, did, platform, handle)) return bad("proof", "bind statement not in post", ev);
  // the account key signed this post on-chain — native when did==account
  const tier: BindTier = did === `${chain}:${post.author}` || did === `did:${chain}:${post.author}` ? "native" : "proof";
  return { ok: true, tier, evidence: { ...ev, author: post.author } };
}

// audius: statement in a track description → user.handle
async function vAudius({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const j = await fetchJson(`https://api.audius.co/v1/resolve?url=${encodeURIComponent(proof)}&app_name=widespread`) as any;
  const t = j?.data;
  if (!t?.id) return bad("proof", "track not found", ev);
  const author = t.user?.handle ?? "";
  if (author.toLowerCase() !== handle.toLowerCase()) return bad("proof", `artist @${author} != ${handle}`, ev);
  if (!stmtPresent(`${t.title ?? ""}\n${t.description ?? ""}`, did, platform, handle)) return bad("proof", "bind statement not in track", ev);
  return { ok: true, tier: "proof", evidence: { ...ev, author } };
}

// blogger/substack: statement in the publication's feed → author name (weak —
// feed authorship is per-publication, not per-handle verified)
async function vFeedAuthored({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const u = new URL(proof);
  let text = "", author = "";
  if (/blogspot\.|blogger\.com/.test(u.host)) {
    const j = await fetchJson(`${u.protocol}//${u.host}/feeds/posts/default?alt=json&max-results=50`) as any;
    const entry = (j?.feed?.entry ?? []).find((e: any) => (e.link ?? []).some((l: any) => l.rel === "alternate" && proof.startsWith(l.href)));
    if (!entry) return bad("weak", "post not found in blog feed", ev);
    text = `${entry.title?.$t ?? ""}\n${entry.content?.$t ?? ""}`;
    author = entry.author?.[0]?.name?.$t ?? "";
  } else {
    const { default: Parser } = await import("rss-parser");
    const xml = await fetch(`${u.protocol}//${u.host}/feed`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const feed = xml ? await new Parser().parseString(xml).catch(() => null) : null;
    const item = (feed?.items ?? []).find((i) => i.link && proof.startsWith(i.link.split("?")[0]));
    if (!item) return bad("weak", "post not found in feed", ev);
    text = `${item.title ?? ""}\n${item.contentSnippet ?? item.content ?? ""}`;
    author = item.creator ?? "";
  }
  if (!stmtPresent(text, did, platform, handle)) return bad("weak", "bind statement not in post", ev);
  return { ok: true, tier: "weak", evidence: { ...ev, author, note: "feed-level author — publication verified" } };
}

// generic URL — fetch the page and look for the statement (gated platforms,
// blogs, pastebins). Author can't be verified → weak tier.
async function vGeneric({ did, platform, handle, proof }: BindInput): Promise<VerifyResult> {
  const ev: Record<string, unknown> = { url: proof };
  const html = await fetch(proof, { headers: { "user-agent": "Mozilla/5.0 (compatible; widespread-bind)" } })
    .then((r) => (r.ok ? r.text() : "")).catch(() => "");
  if (!html) return bad("weak", "proof URL unreachable", ev);
  if (!stmtPresent(html, did, platform, handle)) return bad("weak", "bind statement not found at URL", ev);
  return { ok: true, tier: "weak", evidence: { ...ev, note: "statement found; author not verifiable on this platform" } };
}

/** Per-platform verifier registry — the platform×proof matrix. */
export async function verifyBindProof(env: Env, input: BindInput): Promise<VerifyResult> {
  const p = input.platform.toLowerCase();
  if (p === "github") return vGithub(input);
  if (p === "gitlab") return vGitlab(input);
  if (["forgejo", "gitea", "codeberg", "tangled", "radicle"].includes(p)) return vForgejo(input);
  if (p === "bluesky" || p === "atproto") return vBluesky(input);
  if (p === "nostr") return vNostr(input);
  if (p === "mastodon" || p === "activitypub") return vMastodon(input);
  if (p === "x" || p === "twitter") return vX(input, env);
  if (p === "hackernews" || p === "hn") return vHn(input);
  if (["evm", "ethereum", "base", "poidh"].includes(p)) return vEvm(input);
  if (p === "solana") return vEd25519Chain("solana", input);
  if (p === "near") return vEd25519Chain("near", input);
  // fyi-gateway platforms
  if (p === "lemmy") return vLemmy(input);
  if (p === "misskey") return vMisskey(input);
  if (p === "peertube") return vPeertube(input);
  if (p === "wordpress") return vWordpress(input);
  if (p === "devto" || p === "dev.to") return vDevto(input);
  if (p === "hashnode") return vHashnode(input);
  if (p === "hive") return vHiveChain("hive", "https://api.hive.blog", input);
  if (p === "steem") return vHiveChain("steem", "https://api.steemit.com", input);
  if (p === "audius") return vAudius(input);
  if (p === "blogger" || p === "substack") return vFeedAuthored(input);
  if (p === "pixelfed" || p === "funkwhale") return vMastodon(input); // mastodon-shape status urls
  return vGeneric(input); // linkedin/gmb/tiktok/kick/minds/dtube/paragraph/paste — weak tier
}

/** Instructions per platform for POST /api/identity/challenge. */
export function bindInstructions(platform: string): string {
  const p = platform.toLowerCase();
  if (p === "github") return "Post the statement in a public gist, or a comment on any issue/PR you can comment on. Send the gist/comment URL as proof.";
  if (p === "gitlab") return "Post the statement in a public snippet. Send the snippet URL.";
  if (["forgejo", "gitea", "codeberg", "tangled", "radicle"].includes(p)) return "Comment the statement on any issue/PR, or commit it to a repo file. Send the URL.";
  if (p === "bluesky" || p === "atproto") return "Post the statement on Bluesky. Send the post URL.";
  if (p === "nostr") return "Publish the statement as a kind-1 note from your key. Send the note id (hex or note1…/nevent1…).";
  if (p === "mastodon" || p === "activitypub") return "Post the statement on your instance. Send the status URL.";
  if (p === "x" || p === "twitter") return "Tweet the statement. Send the status URL.";
  if (p === "hackernews" || p === "hn") return "Comment the statement on any HN thread. Send the item URL.";
  if (["evm", "ethereum", "base", "poidh"].includes(p)) return "Sign the statement with EIP-191 personal_sign from the handle address. Send the hex signature as proof.";
  if (["solana", "near"].includes(p)) return `Sign the statement with your ${p} ed25519 key. Send proof JSON: {"pubkey":"<base58>","sig":"<base64>"}`;
  if (p === "lemmy") return "Post or comment the statement on any Lemmy instance. Send the post/comment URL.";
  if (p === "misskey") return "Post the statement as a note. Send the note URL.";
  if (p === "peertube") return "Put the statement in a video description on your channel. Send the video URL.";
  if (p === "wordpress") return "Publish the statement in a post on your WordPress site. Send the post URL.";
  if (p === "devto" || p === "dev.to") return "Publish the statement in a dev.to article. Send the article URL.";
  if (p === "hashnode") return "Publish the statement in a Hashnode post. Send the post URL.";
  if (p === "hive" || p === "steem") return `Publish the statement as a ${p} post — it lands on-chain. Send the @author/permlink URL.`;
  if (p === "audius") return "Put the statement in a track description. Send the audius.co track URL.";
  if (p === "blogger" || p === "substack") return `Publish the statement in a ${p} post. Send the post URL (verified via your publication feed — weak tier).`;
  if (p === "pixelfed" || p === "funkwhale") return "Post the statement natively. Send the status URL (verified via the Mastodon-compatible API).";
  return "Publish the statement somewhere publicly reachable on the platform (profile, post, bio page). Send the URL — note: gated platforms verify weakly.";
}

// ---------------------------------------------------------------- storage

const bindKey = (did: string, platform: string, handle: string) =>
  `idbind:${did}:${platform.toLowerCase()}:${handle.toLowerCase()}`;
const handleKey = (platform: string, handle: string) =>
  `idhandle:${platform.toLowerCase()}:${handle.toLowerCase()}`;

/** Register a binding after proof verification. Rejects proof/handle replay:
 * a handle already bound to a different DID can't be double-claimed. */
export async function registerBinding(env: Env, input: BindInput): Promise<{ ok: boolean; binding?: IdentityBinding; error?: string; tier?: BindTier }> {
  const existing = await env.CLAIMS.get(handleKey(input.platform, input.handle), "json") as { did?: string } | null;
  if (existing?.did && existing.did !== input.did) {
    return { ok: false, error: `${input.platform}/${input.handle} already bound to a different DID` };
  }
  const v = await verifyBindProof(env, input);
  if (!v.ok) return { ok: false, error: v.error, tier: v.tier };
  const binding: IdentityBinding = {
    did: input.did, platform: input.platform.toLowerCase(), handle: input.handle,
    tier: v.tier, proof: input.proof, verified_at: Date.now(), evidence: v.evidence,
  };
  await env.CLAIMS.put(bindKey(input.did, input.platform, input.handle), JSON.stringify(binding));
  await env.CLAIMS.put(handleKey(input.platform, input.handle), JSON.stringify({ did: input.did, tier: v.tier }));
  return { ok: true, binding };
}

export async function listBindings(env: Env, did: string): Promise<IdentityBinding[]> {
  const keys = await env.CLAIMS.list({ prefix: `idbind:${did}:` });
  const out: IdentityBinding[] = [];
  for (const k of keys.keys) {
    const b = await env.CLAIMS.get(k.name, "json") as IdentityBinding | null;
    if (b && !b.revoked_at) out.push(b);
  }
  return out;
}

/** Resolve platform/handle → DID. Returns the binding or null. */
export async function resolveHandle(env: Env, platform: string, handle: string): Promise<{ did: string; tier: BindTier } | null> {
  const h = await env.CLAIMS.get(handleKey(platform, handle), "json") as { did?: string; tier?: BindTier } | null;
  if (!h?.did) return null;
  const b = await env.CLAIMS.get(bindKey(h.did, platform, handle), "json") as IdentityBinding | null;
  if (b?.revoked_at) return null;
  return { did: h.did, tier: h.tier ?? "proof" };
}

/** Revoke — signed by the bound DID's registered Ed25519 key over
 * `widespread-revoke:v1\ndid\nplatform\nhandle`. Unregistered DIDs (pure
 * platform identities) revoke by removing the statement and re-verifying. */
export async function revokeBinding(env: Env, input: { did: string; platform: string; handle: string; sig_hex?: string }): Promise<{ ok: boolean; error?: string }> {
  const b = await env.CLAIMS.get(bindKey(input.did, input.platform, input.handle), "json") as IdentityBinding | null;
  if (!b || b.revoked_at) return { ok: false, error: "binding not found" };
  const reg = await env.CLAIMS.get(`agentdid:${input.did}`, "json") as { pubkey?: string } | null;
  if (!reg?.pubkey) return { ok: false, error: "DID has no registered key — delete the bind statement and call reverify instead" };
  if (!input.sig_hex) return { ok: false, error: "sig_hex required (sign `widespread-revoke:v1\\n<did>\\n<platform>\\n<handle>`)" };
  const msg = new TextEncoder().encode(`widespread-revoke:v1\n${input.did}\n${input.platform}\n${input.handle}`);
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  if (!ed25519.verify(hexBytes(input.sig_hex), msg, hexBytes(reg.pubkey))) return { ok: false, error: "invalid signature" };
  b.revoked_at = Date.now();
  await env.CLAIMS.put(bindKey(input.did, input.platform, input.handle), JSON.stringify(b));
  await env.CLAIMS.delete(handleKey(input.platform, input.handle));
  return { ok: true };
}

/** Re-run the verifier against a stored binding — catches deleted statements
 * and statement edits. Marks revoked_at on failure so stale binds expire. */
export async function reverifyBinding(env: Env, did: string, platform: string, handle: string): Promise<{ ok: boolean; error?: string }> {
  const b = await env.CLAIMS.get(bindKey(did, platform, handle), "json") as IdentityBinding | null;
  if (!b) return { ok: false, error: "binding not found" };
  const v = await verifyBindProof(env, { did, platform, handle, proof: b.proof });
  if (!v.ok) {
    b.revoked_at = Date.now();
    b.evidence = { ...b.evidence, reverify_error: v.error };
    await env.CLAIMS.put(bindKey(did, platform, handle), JSON.stringify(b));
    await env.CLAIMS.delete(handleKey(platform, handle));
    return { ok: false, error: v.error };
  }
  b.verified_at = Date.now();
  b.revoked_at = undefined;
  await env.CLAIMS.put(bindKey(did, platform, handle), JSON.stringify(b));
  return { ok: true };
}
