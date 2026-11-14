// sightings.ts — decentralized task-discovery ingestion. Watchers (client
// agents + volunteers on their own sessions) report grammar-matching items
// they observe on surfaces; the bridge never polls those surfaces itself.
// Three transports feed ingestSighting(): direct POST /api/sightings,
// Nostr gossip events (src/gossip.ts), and platform webhooks
// (src/webhooks.ts). Sighting trust follows oracle-network patterns:
// corroboration tiers (lead/corroborated/disputed) + weight scoring —
// paid+verified watchers outweigh anonymous claims.

import type { Env, FeedRecord } from "./types";
import { DECL_RE, CLAIM_RE, RECEIPT_RE, declRecord, noteClaim, noteBind } from "./socialfeed";
import { verifyDidKey, decodeSig } from "./coordinator/didkey";
import { canonicalJson } from "./artifacts";
import { getDeclared } from "./declare";

const now = () => Date.now();
const BIND_TAG = "widespread-bind:v1";
// MORE P7: counter-claim verb — "#widespread dispute <repo:seq|decl:hash>"
// freezes the outcome bonus. Negative evidence flows as freely as
// positive; disputes are sightings, not privileged calls.
const DISPUTE_RE = /widespread\s+dispute\s+([A-Za-z0-9_./:@-]+)/i;

export type SightingTier = "lead" | "corroborated" | "disputed";
export type SightingSource = "direct" | "push" | "nostr";

export interface Sighting {
  platform: string;
  native_id: string;
  url?: string;
  author?: string;
  text: string;
  ts?: number;
  watcher_did?: string;
  /** base64 or hex ed25519 sig over `widespread-sighting:` + canonicalJson(core) */
  sig?: string;
  source?: SightingSource;
  /** Transport-internal: "nostr-event" means the caller already verified a
   *  Nostr event signature (gossip.ts). NEVER accepted from HTTP input —
   *  routes strip this field before ingest. */
  auth?: "nostr-event";
}

export interface StoredSighting extends Sighting {
  watcher_verified: boolean;
  weight: number;
  tier: SightingTier;
  text_hash: string;
  seen_count: number;
  first_seen: number;
  last_seen: number;
}

const MAX_TEXT = 8192;
const MAX_NATIVE_ID = 256;
const MAX_BATCH = 50;
const RL_PER_HOUR = 240;         // sightings per platform per hour
const MIN_CORROBORATORS = 2;     // independent verified watchers to corroborate

async function sha16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Canonical payload a watcher signs: identity fields only — `source`,
 *  `seen_at` and server-assigned fields are excluded so relays/bridges can
 *  re-derive the same message. Exported for watcher clients + tests. */
export function sightingSignMessage(s: Sighting): string {
  return "widespread-sighting:" + canonicalJson({
    platform: s.platform, native_id: s.native_id, url: s.url ?? null,
    author: s.author ?? null, text: s.text, ts: s.ts ?? null,
    watcher_did: s.watcher_did ?? null,
  });
}

export async function verifySightingSig(s: Sighting): Promise<boolean> {
  if (!s.watcher_did || !s.sig) return false;
  const sig = decodeSig(s.sig);
  if (!sig) return false;
  return verifyDidKey(s.watcher_did, sightingSignMessage(s), sig);
}

async function rateOk(env: Env, platform: string): Promise<boolean> {
  const hour = Math.floor(now() / 3_600_000);
  const key = `rl:sight:${platform}:${hour}`;
  const cur = Number(await env.CLAIMS.get(key)) || 0;
  if (cur >= RL_PER_HOUR) return false;
  await env.CLAIMS.put(key, String(cur + 1), { expirationTtl: 7200 });
  return true;
}

/** Weight: oracle-style reporter scoring. Push sources (platform-
 *  authenticated webhooks) outweigh watcher claims; verified+paid
 *  watchers outweigh verified volunteers; anonymous is weakest. */
async function sightingWeight(env: Env, s: Sighting, verified: boolean): Promise<number> {
  let w = s.source === "push" ? 1.5 : 1.0;
  if (verified) w += 0.3;
  if (s.watcher_did) {
    // Anduin-style economic signal: a watcher previously paid by THIS
    // declaration's funder is expensive to fake.
    const paid = await env.CLAIMS.get(`watchpaid:${s.watcher_did}`).catch(() => null);
    if (paid) w += 0.4;
    const rep = await env.CLAIMS.get(`rep:${s.watcher_did}`, "json").catch(() => null) as { points?: number } | null;
    if ((rep?.points ?? 0) > 10) w += 0.2;
  }
  // Anonymous non-push sightings are weakest — platform-authenticated
  // pushes stay high even without a watcher identity.
  if (!s.watcher_did && !verified && s.source !== "push") w = 0.5;
  return w;
}

interface SightingIndex { keys: string[] }

async function indexKeys(env: Env, platform: string, nativeId: string): Promise<string[]> {
  const idx = await env.CLAIMS.get(`sightidx:${platform}:${nativeId}`, "json").catch(() => null) as SightingIndex | null;
  return idx?.keys ?? [];
}

async function addIndexKey(env: Env, platform: string, nativeId: string, key: string) {
  const keys = await indexKeys(env, platform, nativeId);
  if (!keys.includes(key) && keys.length < 100) {
    keys.push(key);
    await env.CLAIMS.put(`sightidx:${platform}:${nativeId}`, JSON.stringify({ keys } satisfies SightingIndex));
  }
}

/** Recompute the corroboration tier for a native object from all stored
 *  sightings: ≥2 independent verified watchers agreeing on text_hash →
 *  corroborated; conflicting verified reports → disputed; else lead. */
async function recomputeTier(env: Env, platform: string, nativeId: string): Promise<SightingTier> {
  const keys = await indexKeys(env, platform, nativeId);
  const rows: StoredSighting[] = [];
  for (const k of keys) {
    const s = await env.CLAIMS.get<StoredSighting>(k, "json").catch(() => null);
    if (s) rows.push(s);
  }
  const verified = rows.filter((r) => r.watcher_verified);
  const hashes = new Set(verified.map((r) => r.text_hash));
  if (hashes.size > 1 && verified.length >= 2) return "disputed";
  // corroborated: one dominant text_hash claimed by ≥MIN_CORROBORATORS
  // distinct verified watchers.
  const counts = new Map<string, Set<string>>();
  for (const r of verified) {
    const w = r.watcher_did ?? r.author ?? r.native_id;
    const set = counts.get(r.text_hash) ?? new Set<string>();
    set.add(w);
    counts.set(r.text_hash, set);
  }
  for (const set of counts.values()) if (set.size >= MIN_CORROBORATORS) return "corroborated";
  return "lead";
}

async function routeGrammar(env: Env, s: StoredSighting): Promise<void> {
  const text = s.text;
  const url = s.url ?? `https://${s.platform}/${s.native_id}`;
  const actor = s.author ?? s.watcher_did?.slice(0, 12);

  const dm = text.match(DECL_RE);
  if (dm) {
    const hash = dm[1] ?? "unknown";
    // If this declaration was created via /api/bounty/declare, attach the
    // sighting as provenance instead of duplicating the record.
    if (hash !== "unknown" && await getDeclared(env, hash)) {
      const key = `declsight:${hash}`;
      const list = (await env.CLAIMS.get(key, "json").catch(() => null)) as unknown[] ?? [];
      if (list.length < 100 && !list.some((x) => (x as { native_id?: string }).native_id === s.native_id)) {
        list.push({ platform: s.platform, native_id: s.native_id, url, watcher_did: s.watcher_did, tier: s.tier, at: now() });
        await env.CLAIMS.put(key, JSON.stringify(list));
      }
    } else {
      // Organic declaration — create a feed record in the declared lane so
      // pollDeclared's `feedrec:decl:` prefix picks it up with zero merge
      // changes.
      const rec = declRecord(hash, s.platform, url, text, actor);
      rec.id = `decl:sight:${s.platform}:${s.native_id}`;
      rec.verification = { required: rec.verification?.required ?? "declaration-parse", ...(hash !== "unknown" ? { spec_hash: hash } : {}) };
      await env.CLAIMS.put(`feedrec:${rec.id}`, JSON.stringify(rec));
    }
  }
  const cm = text.match(CLAIM_RE);
  if (cm) await noteClaim(env, cm[1], s.platform, actor ?? "?", url, text.includes("http") ? "submission" : "claim");
  const rc = text.match(RECEIPT_RE);
  if (rc) await noteClaim(env, rc[1], s.platform, actor ?? "?", url, "receipt");
  if (text.includes(BIND_TAG)) await noteBind(env, text, url);
  const dp = text.match(DISPUTE_RE);
  if (dp) {
    const ref = dp[1];
    const by = s.watcher_did ?? s.author ?? s.platform;
    await env.CLAIMS.put(`dispute:${ref}`, JSON.stringify({
      ref, by, reason: text.slice(0, 500), url,
      platform: s.platform, native_id: s.native_id, at: now(),
    }));
    // repo:seq refs resolve to scheduled outcomes → freeze the outcome bonus.
    if (/^[\w./-]+:\d+$/.test(ref)) {
      const { disputeOutcome } = await import("./outcome");
      await disputeOutcome(env, ref, by, text).catch(() => null);
    }
  }
}

export interface IngestResult {
  ok: boolean;
  error?: string;
  stored?: StoredSighting;
  tier?: SightingTier;
  duplicate?: boolean;
}

/** Ingest one sighting — shared by all transports. Idempotent per
 *  (platform, native_id, watcher): the same watcher re-sighting the same
 *  object bumps seen_count instead of duplicating. */
export async function ingestSighting(env: Env, s: Sighting): Promise<IngestResult> {
  const platform = (s.platform ?? "").toLowerCase().replace(/[^a-z0-9_.:-]/g, "").slice(0, 64);
  const nativeId = (s.native_id ?? "").slice(0, MAX_NATIVE_ID);
  const text = (s.text ?? "").slice(0, MAX_TEXT);
  if (!platform || !nativeId || !text.trim()) return { ok: false, error: "platform, native_id, text required" };
  if (!(await rateOk(env, platform))) return { ok: false, error: "rate limited" };

  const verified = s.auth === "nostr-event"
    ? true // gossip.ts verified the Nostr event signature before calling
    : await verifySightingSig({ ...s, platform, native_id: nativeId, text });
  if (s.watcher_did && s.sig && !verified && s.auth !== "nostr-event") return { ok: false, error: "invalid watcher signature" };

  const textHash = await sha16(text);
  const watcherKey = s.watcher_did ?? `anon:${await sha16(`${s.author ?? ""}|${nativeId}|${s.ts ?? 0}`)}`;
  const key = `sighting:${platform}:${nativeId}:${watcherKey.replace(/[^A-Za-z0-9:._-]/g, "_").slice(0, 80)}`;
  const existing = await env.CLAIMS.get<StoredSighting>(key, "json").catch(() => null);

  let stored: StoredSighting;
  if (existing) {
    existing.seen_count += 1;
    existing.last_seen = now();
    existing.tier = await recomputeTier(env, platform, nativeId);
    await env.CLAIMS.put(key, JSON.stringify(existing));
    stored = existing;
  } else {
    const weight = await sightingWeight(env, { ...s, platform, native_id: nativeId, text }, verified);
    const { auth: _auth, ...clean } = s;
    stored = {
      ...clean, platform, native_id: nativeId, text,
      watcher_did: s.watcher_did, sig: s.sig,
      source: s.source ?? "direct",
      watcher_verified: verified,
      weight: Math.round(weight * 100) / 100,
      tier: "lead",
      text_hash: textHash,
      seen_count: 1,
      first_seen: now(), last_seen: now(),
    };
    await env.CLAIMS.put(key, JSON.stringify(stored));
    await addIndexKey(env, platform, nativeId, key);
    stored.tier = await recomputeTier(env, platform, nativeId);
    await env.CLAIMS.put(key, JSON.stringify(stored));
  }

  await routeGrammar(env, stored);
  await bumpStats(env, platform, stored.tier, stored.source ?? "direct");
  return { ok: true, stored, tier: stored.tier, duplicate: !!existing };
}

async function bumpStats(env: Env, platform: string, tier: SightingTier, source: SightingSource) {
  const key = "disc:stats";
  const st = (await env.CLAIMS.get(key, "json").catch(() => null)) as Record<string, unknown> | null ?? {};
  const day = new Date().toISOString().slice(0, 10);
  const d = (st.days as Record<string, { sightings?: number; corroborated?: number; disputed?: number }> | undefined)?.[day] ?? {};
  d.sightings = (d.sightings ?? 0) + 1;
  if (tier === "corroborated") d.corroborated = (d.corroborated ?? 0) + 1;
  if (tier === "disputed") d.disputed = (d.disputed ?? 0) + 1;
  st.days = { ...(st.days as object ?? {}), [day]: d };
  const byPlatform = (st.by_platform as Record<string, number> | undefined) ?? {};
  byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
  st.by_platform = byPlatform;
  const byTier = (st.by_tier as Record<string, number> | undefined) ?? {};
  byTier[tier] = (byTier[tier] ?? 0) + 1;
  st.by_tier = byTier;
  const bySource = (st.by_source as Record<string, number> | undefined) ?? {};
  bySource[source] = (bySource[source] ?? 0) + 1;
  st.by_source = bySource;
  st.watchers_active = ((st.watchers_active as number) ?? 0); // recomputed in stats endpoint
  await env.CLAIMS.put(key, JSON.stringify(st));
}

export async function listSightings(env: Env, opts: { platform?: string; since?: number; min_tier?: SightingTier; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const prefix = opts.platform ? `sightidx:${opts.platform}:` : "sightidx:";
  // sightidx keys are per-native-id indexes; to list sightings we scan the
  // sightidx namespace and collect member keys — bounded by limit.
  const idxKeys = await env.CLAIMS.list({ prefix, limit: 500 });
  const out: StoredSighting[] = [];
  const seen = new Set<string>();
  for (const k of idxKeys.keys) {
    const idx = await env.CLAIMS.get<SightingIndex>(k.name, "json").catch(() => null);
    for (const sk of idx?.keys ?? []) {
      if (seen.has(sk)) continue;
      seen.add(sk);
      const s = await env.CLAIMS.get<StoredSighting>(sk, "json").catch(() => null);
      if (!s) continue;
      if (opts.since && s.last_seen < opts.since) continue;
      if (opts.min_tier === "corroborated" && s.tier !== "corroborated") continue;
      if (opts.min_tier === "lead" && s.tier === "disputed") continue;
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.last_seen - a.last_seen).slice(0, limit);
}

export async function discoveryStats(env: Env) {
  const st = (await env.CLAIMS.get("disc:stats", "json").catch(() => null)) as Record<string, unknown> | null ?? {};
  const platforms = Object.keys((st.by_platform as Record<string, number>) ?? {});
  // Active watchers = distinct watcher_dids seen in the last 24h — bounded
  // scan of recent sightidx members.
  const watchers = new Set<string>();
  const idxKeys = await env.CLAIMS.list({ prefix: "sightidx:", limit: 300 });
  const cutoff = now() - 86_400_000;
  for (const k of idxKeys.keys.slice(0, 100)) {
    const idx = await env.CLAIMS.get<SightingIndex>(k.name, "json").catch(() => null);
    for (const sk of (idx?.keys ?? []).slice(0, 10)) {
      const s = await env.CLAIMS.get<StoredSighting>(sk, "json").catch(() => null);
      if (s?.watcher_did && s.last_seen > cutoff) watchers.add(s.watcher_did);
    }
  }
  return {
    surfaces_watched: platforms.length,
    by_platform: st.by_platform ?? {},
    by_tier: st.by_tier ?? {},
    by_source: st.by_source ?? {},
    days: st.days ?? {},
    watchers_active: watchers.size,
    generated_at: now(),
  };
}
