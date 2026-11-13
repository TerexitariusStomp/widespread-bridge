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

// --- mastodon-shape (mastodon + pixelfed + funkwhale compat) ----------------
const mastoShape = async (
  inst: string, id: string, platform: string,
  { market, claim }: Parameters<ValidateFn>[0], ctx: Parameters<ValidateFn>[1],
) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const r = await ctx.fetch(`https://${inst}/api/v1/statuses/${id}`).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { account?: { acct?: string }; content?: string; created_at?: string; id?: string } | null;
  if (!j?.id) return { failures: ["resolve: status not found"], evidence: ev };
  const text = (j.content ?? "").replace(/<[^>]+>/g, "");
  ev.platform = platform; ev.post_id = j.id; ev.instance = inst; ev.author = j.account?.acct;
  if (claim.actor && (j.account?.acct ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").split("@")[0].toLowerCase()) f.push(`bind-identity: author @${j.account?.acct} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(j.created_at, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

const validateMastodon: ValidateFn = async (input, ctx) => {
  const m = input.claim.ref.match(/https?:\/\/([\w.-]+)\/@([\w@.-]+)\/(\d+)/) || input.claim.ref.match(/https?:\/\/([\w.-]+)\/(?:users|@[\w.-]+\/statuses)\/(\d+)/);
  if (!m) return { failures: ["resolve: not a mastodon status url"], evidence: {} };
  return mastoShape(m[1], m[3] ?? m[2], "mastodon", input, ctx);
};

// --- pixelfed (mastodon-compatible, /p/<user>/<id> or /i/web/post/<id>) ------
const validatePixelfed: ValidateFn = async (input, ctx) => {
  const m = input.claim.ref.match(/https?:\/\/([\w.-]*pixelfed[\w.-]*)\/(?:p\/[\w.-]+|i\/web\/post|web\/post)\/(\d+)/)
    ?? input.claim.ref.match(/https?:\/\/([\w.-]+)\/(?:p\/[\w.-]+)\/(\d+)/);
  if (!m) return { failures: ["resolve: not a pixelfed post url"], evidence: {} };
  return mastoShape(m[1], m[2], "pixelfed", input, ctx);
};

// --- lemmy (public /api/v3) --------------------------------------------------
const validateLemmy: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/https?:\/\/([\w.-]+)\/(post|comment)\/(\d+)/);
  if (!m) return { failures: ["resolve: not a lemmy post/comment url"], evidence: ev };
  const kind = m[2];
  const j = (await (await ctx.fetch(`https://${m[1]}/api/v3/${kind}?id=${m[3]}`).catch(() => null))?.json().catch(() => null)) as Record<string, any> | null;
  const view = j?.[`${kind}_view`];
  if (!view) return { failures: ["resolve: lemmy object not found"], evidence: ev };
  const text = view[kind]?.body ?? view[kind]?.content ?? view[kind]?.name ?? "";
  const author = view.creator?.name ?? "";
  ev.platform = "lemmy"; ev.instance = m[1]; ev.author = author; ev.post_id = m[3];
  if (claim.actor && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${author} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(view[kind]?.published, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- misskey (POST /api/notes/show) ------------------------------------------
const validateMisskey: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/https?:\/\/([\w.-]+)\/notes\/([\w]+)/);
  if (!m) return { failures: ["resolve: not a misskey note url"], evidence: ev };
  const r = await ctx.fetch(`https://${m[1]}/api/notes/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noteId: m[2] }) }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { user?: { username?: string }; text?: string; createdAt?: string } | null;
  if (!j?.user) return { failures: ["resolve: note not found"], evidence: ev };
  const text = j.text ?? "";
  ev.platform = "misskey"; ev.instance = m[1]; ev.author = j.user.username; ev.note_id = m[2];
  if (claim.actor && (j.user.username ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${j.user.username} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(j.createdAt, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- wordpress (WP REST, per-site) -------------------------------------------
const validateWordpress: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const u = new URL(claim.ref);
  const pid = u.searchParams.get("p");
  const slug = u.pathname.split("/").filter(Boolean).pop();
  const base = `${u.protocol}//${u.host}`;
  const api = pid ? `${base}/wp-json/wp/v2/posts/${pid}?_embed=1` : `${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug ?? "")}&_embed=1`;
  const j = (await (await ctx.fetch(api).catch(() => null))?.json().catch(() => null)) as any;
  const post = Array.isArray(j) ? j[0] : j;
  if (!post?.id) return { failures: ["resolve: post not found via wp-json"], evidence: ev };
  const text = (post.content?.rendered ?? "").replace(/<[^>]+>/g, "");
  const author = post._embedded?.author?.[0]?.slug ?? post._embedded?.author?.[0]?.name ?? "";
  ev.platform = "wordpress"; ev.site = u.host; ev.post_id = post.id; ev.author = author;
  if (claim.actor && author && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${author} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(post.date, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- hive/steem (content ON-CHAIN via condenser_api — strongest public tier) -
const hiveApi = (platform: string, api: string): ValidateFn => async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/@([\w.-]+)\/([\w-]+)/);
  if (!m) return { failures: [`resolve: not a ${platform} @author/permlink url`], evidence: ev };
  const r = await ctx.fetch(api, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "condenser_api.get_content", params: [m[1], m[2]] }) }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as { result?: { author?: string; body?: string; created?: string; title?: string } } | null;
  const post = j?.result;
  if (!post?.author) return { failures: ["resolve: on-chain content not found"], evidence: ev };
  const text = `${post.title ?? ""}\n${post.body ?? ""}`;
  ev.platform = platform; ev.author = post.author; ev.permlink = m[2]; ev.chain = "on-chain content";
  if (claim.actor && post.author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${post.author} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(post.created, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- dev.to (Forem public API) ------------------------------------------------
const validateDevto: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/dev\.to\/([\w-]+)\/([\w-]+)/);
  if (!m) return { failures: ["resolve: not a dev.to article url"], evidence: ev };
  const list = (await (await ctx.fetch(`https://dev.to/api/articles?username=${m[1]}&per_page=30`).catch(() => null))?.json().catch(() => null)) as { slug?: string; id?: number }[] | null;
  const id = (Array.isArray(list) ? list : []).find((a) => a.slug === m[2])?.id;
  const j = (await (await ctx.fetch(id ? `https://dev.to/api/articles/${id}` : `https://dev.to/api/articles/${m[2]}`).catch(() => null))?.json().catch(() => null)) as any;
  if (!j?.id) return { failures: ["resolve: article not found"], evidence: ev };
  const text = `${j.title ?? ""}\n${(j.body_markdown ?? "").slice(0, 8000)}`;
  ev.platform = "devto"; ev.article_id = j.id; ev.author = j.user?.username;
  if (claim.actor && (j.user?.username ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${j.user?.username} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(j.published_at, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- hashnode (public GraphQL) ------------------------------------------------
const validateHashnode: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/https?:\/\/([\w.-]+)\/([\w-]+)/);
  if (!m) return { failures: ["resolve: not a hashnode post url"], evidence: ev };
  const host = m[1].includes("hashnode") ? m[1] : `${m[1]}.hashnode.dev`;
  const r = await ctx.fetch("https://gql.hashnode.com", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `{ publication(host: "${host}") { post(slug: "${m[2]}") { title publishedAt author { username } content { markdown } } } }` }) }).catch(() => null);
  const j = (await r?.json().catch(() => null)) as any;
  const post = j?.data?.publication?.post;
  if (!post) return { failures: ["resolve: post not found"], evidence: ev };
  const text = `${post.title ?? ""}\n${post.content?.markdown ?? ""}`;
  ev.platform = "hashnode"; ev.host = host; ev.author = post.author?.username;
  if (claim.actor && (post.author?.username ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${post.author?.username} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(post.publishedAt, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- peertube (/api/v1/videos/{uuid}) -----------------------------------------
const validatePeertube: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/https?:\/\/([\w.-]+)\/(?:w|videos\/watch)\/([\w-]+)/);
  if (!m) return { failures: ["resolve: not a peertube video url"], evidence: ev };
  const j = (await (await ctx.fetch(`https://${m[1]}/api/v1/videos/${m[2]}`).catch(() => null))?.json().catch(() => null)) as any;
  if (!j?.uuid) return { failures: ["resolve: video not found"], evidence: ev };
  const text = `${j.name ?? ""}\n${j.description ?? ""}`;
  const author = j.channel?.name ?? j.account?.name ?? "";
  ev.platform = "peertube"; ev.instance = m[1]; ev.video_uuid = j.uuid; ev.author = author; ev.title = j.name;
  if (claim.actor && author && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: channel @${author} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(j.publishedAt, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- audius (public discovery API) --------------------------------------------
const validateAudius: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  if (!/audius\.co\//.test(claim.ref)) return { failures: ["resolve: not an audius url"], evidence: ev };
  const res = (await (await ctx.fetch(`https://api.audius.co/v1/resolve?url=${encodeURIComponent(claim.ref)}&app_name=widespread`).catch(() => null))?.json().catch(() => null)) as { data?: { id?: string; title?: string; description?: string; user?: { handle?: string }; release_date?: string } } | null;
  if (!res?.data?.id) return { failures: ["resolve: track not found"], evidence: ev };
  const t = res.data;
  const text = `${t.title ?? ""}\n${t.description ?? ""}`;
  ev.platform = "audius"; ev.track_id = t.id; ev.author = t.user?.handle; ev.title = t.title;
  if (claim.actor && (t.user?.handle ?? "").toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: artist @${t.user?.handle} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- blogger (public JSON feeds) ----------------------------------------------
const validateBlogger: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const u = new URL(claim.ref);
  const j = (await (await ctx.fetch(`${u.protocol}//${u.host}/feeds/posts/default?alt=json&max-results=50`).catch(() => null))?.json().catch(() => null)) as any;
  const entries = j?.feed?.entry ?? [];
  const entry = entries.find((e: any) => (e.link ?? []).some((l: any) => l.rel === "alternate" && claim.ref.startsWith(l.href)));
  if (!entry) return { failures: ["resolve: post not found in blog feed"], evidence: ev };
  const text = `${entry.title?.$t ?? ""}\n${(entry.content?.$t ?? "").replace(/<[^>]+>/g, "")}`;
  const author = entry.author?.[0]?.name?.$t ?? "";
  ev.platform = "blogger"; ev.blog = u.host; ev.author = author; ev.post_id = entry.id?.$t;
  if (claim.actor && author && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author "${author}" != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(entry.published?.$t, market.created_at), ...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- substack (public RSS) -----------------------------------------------------
const validateSubstack: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const u = new URL(claim.ref);
  const { default: Parser } = await import("rss-parser");
  const xml = await ctx.fetch(`${u.protocol}//${u.host}/feed`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const feed = xml ? await new Parser().parseString(xml).catch(() => null) : null;
  const item = (feed?.items ?? []).find((i) => i.link && claim.ref.startsWith(i.link.split("?")[0]));
  if (!item) return { failures: ["resolve: post not found in substack feed"], evidence: ev };
  const text = `${item.title ?? ""}\n${(item.contentSnippet ?? item.content ?? "").replace(/<[^>]+>/g, "")}`;
  const author = item.creator ?? feed?.title ?? "";
  ev.platform = "substack"; ev.pub = u.host; ev.author = author; ev.title = item.title;
  if (claim.actor && item.creator && item.creator.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author "${item.creator}" != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...specCheck(text, market.verification?.params));
  return { failures: f, evidence: ev };
};

// --- tiktok (oembed — text truncated → weak) -----------------------------------
const validateTiktok: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  if (!/tiktok\.com/.test(claim.ref)) return { failures: ["resolve: not a tiktok url"], evidence: ev };
  const j = (await (await ctx.fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(claim.ref)}`).catch(() => null))?.json().catch(() => null)) as { author_name?: string; title?: string } | null;
  if (!j?.author_name) return { failures: ["resolve: video not found (oembed)"], evidence: ev };
  ev.platform = "tiktok"; ev.author = j.author_name; ev.title = j.title; ev.note = "oembed — author verified, description only";
  if (claim.actor && j.author_name.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: author @${j.author_name} != claimed ${claim.actor}`);
  ev.content_hash = await sha(j.title ?? "");
  f.push(...specCheck(j.title ?? "", market.verification?.params));
  f.push("weak-tier: oembed only — content terms checkable on title/description only");
  return { failures: f, evidence: ev };
};

// --- kick (channel api, best-effort) --------------------------------------------
const validateKick: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const m = claim.ref.match(/kick\.com\/([\w-]+)/);
  if (!m) return { failures: ["resolve: not a kick url"], evidence: ev };
  const j = (await (await ctx.fetch(`https://kick.com/api/v2/channels/${m[1]}`).catch(() => null))?.json().catch(() => null)) as any;
  const author = j?.user?.username;
  if (!author) return { failures: ["resolve: channel not found"], evidence: ev };
  ev.platform = "kick"; ev.channel = m[1]; ev.author = author;
  if (claim.actor && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: channel @${author} != claimed ${claim.actor}`);
  f.push("weak-tier: kick api — author verified, clip content not checkable");
  ev.content_hash = await sha(`${m[1]}|${author}`);
  return { failures: f, evidence: ev };
};

// --- activitypub-object (universal fediverse fallback) -------------------------
// Any AP object URL — lemmy/misskey/peertube/funkwhale/writefreely/pixelfed/
// mastodon all serve JSON-LD at the object URL when asked. attributedTo →
// actor → preferredUsername gives the author. One validator, all of fedi.
const validateActivityPub: ValidateFn = async ({ market, claim }, ctx) => {
  const ev: Record<string, unknown> = {}; const f: string[] = [];
  const accept = { headers: { accept: "application/activity+json, application/ld+json" } };
  const obj = (await (await ctx.fetch(claim.ref, accept).catch(() => null))?.json().catch(() => null)) as any;
  if (!obj || (!obj.content && !obj.name)) return { failures: ["resolve: no ActivityPub object at url"], evidence: ev };
  const text = `${obj.name ?? ""}\n${(obj.summary ?? obj.content ?? "").replace(/<[^>]+>/g, "")}`;
  let author = "";
  if (typeof obj.attributedTo === "string") {
    const actor = (await (await ctx.fetch(obj.attributedTo, accept).catch(() => null))?.json().catch(() => null)) as any;
    author = actor?.preferredUsername ?? obj.attributedTo.split("/").filter(Boolean).pop() ?? "";
  } else if (obj.attributedTo?.preferredUsername) author = obj.attributedTo.preferredUsername;
  ev.platform = "activitypub"; ev.author = author; ev.type = obj.type;
  if (claim.actor && author && author.toLowerCase() !== claim.actor.replace(/^@/, "").toLowerCase()) f.push(`bind-identity: actor @${author} != claimed ${claim.actor}`);
  ev.content_hash = await sha(text);
  f.push(...afterCheck(obj.published, market.created_at), ...specCheck(text, market.verification?.params));
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

// --- text-draft (deliverable is text itself — ghostwriting, copy, scripts) --
// The draft ships as claim.evidence.text (or a ref to a public paste). No
// platform publication required — funder acceptance + style similarity do
// the judging. This is the default class for gated-platform ghostwriting.
const validateTextDraft: ValidateFn = async ({ market, claim }) => {
  const ev: Record<string, unknown> = { platform: "text-draft" };
  const text = String(claim.evidence?.text ?? (claim.ref.startsWith("draft:") ? claim.ref.slice(6) : ""));
  if (!text.trim()) return { failures: ["prove-work: no draft text on claim (submit evidence.text)"], evidence: ev };
  ev.draft_chars = text.length;
  ev.content_hash = await sha(text);
  const f = specCheck(text, market.verification?.params);
  return { failures: f, evidence: ev };
};

export const packs: DomainPack[] = [
  { name: "bluesky-post", evidence_class: "platform-url", display: "Bluesky post", validate: validateBluesky },
  { name: "mastodon-post", evidence_class: "platform-url", display: "Mastodon post", validate: validateMastodon },
  { name: "x-post", evidence_class: "platform-url", display: "X/Twitter post", validate: validateX },
  { name: "youtube", evidence_class: "platform-url", display: "YouTube video", validate: validateYoutube },
  { name: "platform-url", evidence_class: "platform-url", display: "Any public URL (og)", validate: validatePlatformUrl },
  { name: "payer-accept", evidence_class: "funder-accept", display: "Funder-approved artifact", validate: validatePayerAccept },
  { name: "text-draft", evidence_class: "text", display: "Draft text (ghostwrite/copy)", validate: validateTextDraft },
  // — fyi gateway parity: proof tier (public read API) —
  { name: "pixelfed-post", evidence_class: "platform-url", display: "Pixelfed post", validate: validatePixelfed },
  { name: "lemmy-post", evidence_class: "platform-url", display: "Lemmy post/comment", validate: validateLemmy },
  { name: "misskey-note", evidence_class: "platform-url", display: "Misskey note", validate: validateMisskey },
  { name: "wordpress-post", evidence_class: "platform-url", display: "WordPress post", validate: validateWordpress },
  { name: "hive-post", evidence_class: "platform-url", display: "Hive post (on-chain)", validate: hiveApi("hive", "https://api.hive.blog") },
  { name: "steem-post", evidence_class: "platform-url", display: "Steem post (on-chain)", validate: hiveApi("steem", "https://api.steemit.com") },
  { name: "devto-article", evidence_class: "platform-url", display: "dev.to article", validate: validateDevto },
  { name: "hashnode-post", evidence_class: "platform-url", display: "Hashnode post", validate: validateHashnode },
  { name: "peertube-video", evidence_class: "platform-url", display: "PeerTube video", validate: validatePeertube },
  { name: "audius-track", evidence_class: "platform-url", display: "Audius track", validate: validateAudius },
  { name: "blogger-post", evidence_class: "platform-url", display: "Blogger post", validate: validateBlogger },
  { name: "substack-post", evidence_class: "platform-url", display: "Substack post", validate: validateSubstack },
  { name: "activitypub-object", evidence_class: "platform-url", display: "Any fediverse object", validate: validateActivityPub },
  // — weak tier (gated/oembed-only) —
  { name: "tiktok-video", evidence_class: "platform-url", display: "TikTok video (oembed)", validate: validateTiktok },
  { name: "kick-clip", evidence_class: "platform-url", display: "Kick channel/clip", validate: validateKick },
];
