// social.ts — platform-url domain packs. Thin adapters over free public
// APIs; each pack runs resolve → bind-identity → prove-work → bind-spec.
// Strong: bluesky/mastodon/nostr/x. Medium: youtube. Weak: generic og.
import type { DomainPack, ValidateFn } from "./types";

const sha = async (s: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const specCheck = (text: string, params: Record<string, unknown> | undefined): string[] => {
  const f: string[] = [];
  if (!params) return f;
  const terms = (params.required_terms as string[] | undefined) ?? [];
  for (const t of terms) if (!text.toLowerCase().includes(String(t).toLowerCase())) f.push(`spec: missing term "${t}"`);
  if (params.min_length && text.length < Number(params.min_length)) f.push(`spec: ${text.length} < min_length ${params.min_length}`);
  if (params.nonce && !text.includes(String(params.nonce))) f.push(`spec: nonce missing`);
  return f;
};

const afterCheck = (postedIso: string | undefined, createdMs: number | undefined): string[] =>
  postedIso && createdMs && Date.parse(postedIso) < createdMs ? ["work predates market"] : [];

// --- bluesky (public.api.bsky.app — no auth) --------------------------------
const bskyRef = (ref: string) => {
  const m = ref.match(/bsky\.app\/profile\/([\w.-]+)\/post\/([\w]+)/) || ref.match(/at:\/\/([\w.]+)\/app\.bsky\.feed\.post\/([\w]+)/);
  return m ? { repo: m[1], rkey: m[2] } : null;
};
const validateBluesky: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const ref = bskyRef(claim.ref);
  if (!ref) return { failures: ["resolve: not a bluesky post ref"], evidence: ev };
  const u = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${ref.repo}/app.bsky.feed.post/${ref.rkey}`)}&depth=0`;
  const r = await ctx.fetch(u).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { thread?: { post?: { author?: { handle?: string; did?: string }; record?: { text?: string; createdAt?: string }; uri?: string } } } | null;
  const post = j?.thread?.post;
  if (!post) return { failures: ["resolve: post not found"], evidence: ev };
  const handle = post.author?.handle ?? "";
  ev.platform = "bluesky"; ev.post_uri = post.uri; ev.author = handle; ev.did = post.author?.did;
  if (claim.actor && handle.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${handle} != claimed ${claim.actor}`);
  const text = post.record?.text ?? "";
  ev.content_hash = await sha(text);
  f.push(...afterCheck(post.record?.createdAt, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- mastodon (per-instance public API) -------------------------------------
const validateMastodon: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/https?:\/\/([\w.-]+)\/@([\w@.-]+)\/(\d+)/) || claim.ref.match(/https?:\/\/([\w.-]+)\/(?:users|@[\w.-]+\/statuses)\/(\d+)/);
  if (!m) return { failures: ["resolve: not a mastodon status url"], evidence: ev };
  const inst = m[1]; const id = m[3] ?? m[2];
  const r = await ctx.fetch(`https://${inst}/api/v1/statuses/${id}`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { account?: { acct?: string }; content?: string; created_at?: string; id?: string } | null;
  if (!j?.id) return { failures: ["resolve: status not found"], evidence: ev };
  const text = (j.content ?? "").replace(/<[^>]+>/g, "");
  ev.platform = "mastodon"; ev.post_id = j.id; ev.instance = inst; ev.author = j.account?.acct;
  if (claim.actor && (j.account?.acct ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${j.account?.acct} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(j.created_at, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- x (oembed keyless; bearer optional upgrades resolve) --------------------
const validateX: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/(?:x|twitter)\.com\/([\w]+)\/status(?:es)?\/(\d+)/);
  const statusId = m?.[2];
  if (!statusId) return { failures: ["resolve: not an x status ref"], evidence: ev };
  const bearer = ctx.env.X_BEARER_TOKEN;
  if (bearer) {
    const r = await ctx.fetch(`https://api.x.com/2/tweets/${statusId}?tweet.fields=author_id,created_at,text&expansions=author_id&user.fields=username`, { headers: { authorization: `Bearer ${bearer}` } }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { data?: { text?: string; created_at?: string }; includes?: { users?: { username?: string }[] } } | null;
    if (j?.data) {
      const user = j.includes?.users?.[0]?.username;
      ev.platform = "x"; ev.post_id = statusId; ev.author = user;
      if (claim.actor && (user ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: @${user} != claimed ${claim.actor}`);
      ev.content_hash = await sha(j.data.text ?? "");
      f.push(...afterCheck(j.data.created_at, market.created_at), ...specCheck(j.data.text ?? "", market.verification?.params));
      return { failures: f, evidence: ev };
    }
  }
  const r = await ctx.fetch(`https://publish.twitter.com/oembed?url=https://x.com/i/status/${statusId}`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { html?: string; author_name?: string } | null;
  if (!j?.html) return { failures: ["resolve: status not found (oembed)"], evidence: ev };
  const text = j.html.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ");
  const acct = j.html.match(/—\s*[^<]*\(@(\w+)\)/)?.[1] ?? j.author_name;
  ev.platform = "x"; ev.post_id = statusId; ev.author = acct; ev.note = "oembed: no created_at available";
  if (claim.actor && acct && acct.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: @${acct} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- youtube (oembed) --------------------------------------------------------
const validateYoutube: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  if (!m) return { failures: ["resolve: not a youtube ref"], evidence: ev };
  const r = await ctx.fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(claim.ref)}&format=json`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { title?: string; author_name?: string } | null;
  if (!j?.title) return { failures: ["resolve: video not found"], evidence: ev };
  ev.platform = "youtube"; ev.video_id = m[1]; ev.title = j.title; ev.channel = j.author_name;
  if (claim.actor && j.author_name && j.author_name.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: channel "${j.author_name}" != claimed ${claim.actor}`);
  ev.content_hash = await sha(j.title);
  f.push(...specCheck(j.title, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- generic platform-url (og meta — weakest tier) ----------------------------
const validatePlatformUrl: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const r = await ctx.fetch(claim.ref, { headers: { "user-agent": "Mozilla/5.0 (compatible; widespread-verify)" } }).catch(() => null);
  const html = (await r?.text().catch(() => "")) ?? "";
  if (!html) return { failures: ["resolve: url unreachable"], evidence: ev };
  const og = (p: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:og:)?${p}["'][^>]+content=["']([^"']+)`, "i"))?.[1];
  const text = [og("title"), og("description")].filter(Boolean).join(" ");
  const linkedin = /linkedin\.com/.test(claim.ref);
  ev.platform = "generic"; ev.url = claim.ref; ev.content_hash = await sha(text || html.slice(0, 2000));
  if (!text) f.push("prove-work: no og metadata readable");
  if (linkedin) f.push("bind-identity: linkedin gated — payer-accept required");
  f.push(...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- payer-accept (funder verdict for unverifiable refs) ---------------------
const validatePayerAccept: ValidateFn = async ({ claim }) => ({
  failures: [],
  evidence: { platform: "payer-accept", url: claim.ref, note: "verdict deferred to funder approval" },
});

export const packs: DomainPack[] = [
  { name: "bluesky-post", evidence_class: "platform-url", display: "Bluesky post", validate: validateBluesky },
  { name: "mastodon-post", evidence_class: "platform-url", display: "Mastodon post", validate: validateMastodon },
  { name: "x-post", evidence_class: "platform-url", display: "X/Twitter post", validate: validateX },
  { name: "youtube", evidence_class: "platform-url", display: "YouTube video", validate: validateYoutube },
  { name: "platform-url", evidence_class: "platform-url", display: "Any public URL (og)", validate: validatePlatformUrl },
  { name: "payer-accept", evidence_class: "funder-accept", display: "Funder-approved artifact", validate: validatePayerAccept },
];
