// gossip.ts — Nostr transport for sightings. Watchers publish sightings as
// signed Nostr events (NIP-78 app-data, kind 30078) to public relays; the
// bridge subscribes and ingests them through the same oracle pipeline as
// direct POSTs. This makes discovery genuinely peer-to-peer: sightings
// propagate watcher→relay→bridge→watchers even when the bridge is down —
// relays hold them and the bridge backfills on restart.
//
// Auth: the Nostr event signature IS the watcher credential (secp256k1
// schnorr over the event). gossip.ts only sets auth:"nostr-event" AFTER
// verifyEvent passes — HTTP routes strip that field, so it can't be
// claimed directly. watcher_did maps to did:nostr:<pubkey>, already a
// first-class DID in identity.ts.

import type { Env } from "./types";
import type { SocialEnv } from "./types";
import type { Sighting } from "./sightings";
import { ingestSighting } from "./sightings";

/** NIP-78 parameterized-replaceable app-data kind for sighting events. */
export const SIGHTING_KIND = 30078;
export const SIGHTING_TAG = "widespread-sighting";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];

function relays(env: Env): string[] {
  return (((env as SocialEnv).NOSTR_RELAYS ?? "") || DEFAULT_RELAYS.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
}

/** Canonical sighting JSON carried in event.content. */
export function sightingToEventContent(s: Sighting): string {
  return JSON.stringify({
    v: 1,
    platform: s.platform,
    native_id: s.native_id,
    url: s.url ?? null,
    author: s.author ?? null,
    text: s.text,
    ts: s.ts ?? null,
    watcher_did: s.watcher_did ?? null,
  });
}

export function eventToSighting(e: { pubkey: string; content: string; created_at: number; tags: string[][] }): Sighting | null {
  try {
    const j = JSON.parse(e.content) as Record<string, unknown>;
    if (j.v !== 1 || typeof j.platform !== "string" || typeof j.native_id !== "string" || typeof j.text !== "string") return null;
    const tags = e.tags ?? [];
    const dTag = tags.find((t) => t[0] === "d")?.[1];
    // d-tag is the dedupe coordinate; require it to match the payload so a
    // relay can't re-file an event under a different object id.
    if (dTag && dTag !== `${j.platform}:${j.native_id}`) return null;
    return {
      platform: j.platform,
      native_id: j.native_id,
      url: typeof j.url === "string" ? j.url : undefined,
      author: typeof j.author === "string" ? j.author : undefined,
      text: j.text,
      ts: typeof j.ts === "number" ? j.ts : e.created_at,
      watcher_did: `did:nostr:${e.pubkey}`,
      auth: "nostr-event",
      source: "nostr",
    } as Sighting & { auth: string };
  } catch {
    return null;
  }
}

export interface GossipHandle { close(): void }

/** Subscribe to sighting events on public relays and ingest them.
 *  Returns a handle the caller keeps for the isolate's lifetime — workerd
 *  doesn't allow long-lived background work, so callers wire this into the
 *  feed-refresh path (each refresh reconnects; relay `since` backfill makes
 *  reconnects cheap). */
export async function subscribeSightings(env: Env, since?: number): Promise<GossipHandle> {
  const rs = relays(env);
  const { SimplePool, verifyEvent } = await import("nostr-tools");
  const pool = new SimplePool();
  const seen = new Set<string>();
  const sub = pool.subscribeMany(rs, {
    kinds: [SIGHTING_KIND],
    ...(since ? { since } : {}),
  }, {
    onevent: (e) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      if (seen.size > 5000) seen.clear();
      if (!verifyEvent(e)) return;
      const s = eventToSighting(e);
      if (!s) return;
      void ingestSighting(env, s).catch(() => null);
    },
    onclose: () => { /* relay closed — next refresh reconnects */ },
  });
  return { close: () => { try { sub.close(); } catch { /* best effort */ } try { pool.close(rs); } catch { /* best effort */ } } };
}

/** Publish a sighting to relays — used by bridge-originated announcements
 *  and tests. Requires a nostr secret key (hex). */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function publishSighting(env: Env, s: Sighting, secretKeyHex: string): Promise<string[]> {
  const { finalizeEvent, getPublicKey, SimplePool } = await import("nostr-tools");
  const keyBytes = hexToBytes(secretKeyHex);
  const pubkey = getPublicKey(keyBytes);
  const unsigned = {
    kind: SIGHTING_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `${s.platform}:${s.native_id}`],
      ["t", SIGHTING_TAG],
      ["platform", s.platform],
      ["native_id", s.native_id],
      ...(s.watcher_did ? [["w", s.watcher_did]] : []),
    ],
    content: sightingToEventContent(s),
    pubkey,
  };
  const event = finalizeEvent(unsigned, keyBytes);
  const rs = relays(env);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(rs.map((r) => pool.publish([r], event)));
    return rs.filter((_, i) => results[i].status === "fulfilled");
  } finally {
    pool.close(rs);
  }
}

/** One-shot backfill: query relays for sighting events since `since`
 * (unix seconds) and ingest them. Used on feed refresh so reconnects
 * don't lose events published while the isolate was cold. */
export async function backfillSightings(env: Env, sinceUnix: number): Promise<number> {
  const rs = relays(env);
  const { SimplePool, verifyEvent } = await import("nostr-tools");
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(rs, { kinds: [SIGHTING_KIND], since: sinceUnix, limit: 200 });
    let n = 0;
    for (const e of events ?? []) {
      if (!verifyEvent(e)) continue;
      const s = eventToSighting(e);
      if (!s) continue;
      const r = await ingestSighting(env, s as Parameters<typeof ingestSighting>[1]).catch(() => null);
      if (r?.ok) n++;
    }
    return n;
  } finally {
    pool.close(rs);
  }
}
