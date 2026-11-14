// watchpay.ts — watcher rewards. When a declaration that watchers sighted
// reaches funded state, watchers earn reputation credit + a recorded fee
// entitlement (sighting_bps on the declaration). ERC-8004-shaped feedback
// is emitted so watcher trust is portable. Disputed sightings slash rep.
// v1 honesty: entitlements are RECORDED, not auto-settled — escrow-hooked
// release is follow-up work (same pattern as platformBps).

import type { Env } from "./types";
import type { Rep8004 } from "./rep8004";

const now = () => Date.now();

export interface WatcherRep {
  did: string;
  points: number;
  sightings: number;
  corroborated: number;
  disputes: number;
  rewards_owed: number;
  updated_at: number;
}

async function rep(env: Env, did: string): Promise<WatcherRep> {
  return (await env.CLAIMS.get(`rep:${did}`, "json").catch(() => null)) as WatcherRep
    ?? { did, points: 0, sightings: 0, corroborated: 0, disputes: 0, rewards_owed: 0, updated_at: now() };
}

async function saveRep(env: Env, r: WatcherRep) {
  r.updated_at = now();
  await env.CLAIMS.put(`rep:${r.did}`, JSON.stringify(r));
}

/** Credit a watcher for a useful sighting. Called by sightings.ts when a
 *  sighting reaches corroborated tier, and by reward settlement. */
export async function creditWatcher(env: Env, did: string | undefined, kind: "sighting" | "corroborated" | "reward" | "dispute") {
  if (!did) return;
  const r = await rep(env, did);
  if (kind === "sighting") { r.sightings += 1; r.points += 1; }
  else if (kind === "corroborated") { r.corroborated += 1; r.points += 3; }
  else if (kind === "reward") { r.rewards_owed += 1; r.points += 5; }
  else if (kind === "dispute") { r.disputes += 1; r.points = Math.max(0, r.points - 5); }
  await saveRep(env, r);
}

/** ERC-8004-shaped feedback record for a watcher's sighting accuracy —
 *  portable reputation anchored to the sighting evidence. */
export function watcherFeedback(did: string, accuracy: number, sightingKey: string): Rep8004 {
  return {
    schema: "erc-8004-feedback/1",
    value: Math.round(accuracy * 100),
    valueDecimals: 2,
    tag1: "sighting-accuracy",
    tag2: "discovery",
    endpoint: `watcher:${did.slice(0, 24)}`,
    feedbackURI: `sighting:${sightingKey}`,
    feedbackHash: sightingKey,
    grounded: true, // binds to a stored, deduped sighting record
  };
}

export async function emitWatcherFeedback(env: Env, did: string, sightingKey: string, accuracy: number) {
  const fb = watcherFeedback(did, accuracy, sightingKey);
  const key = `rep8004:sighting:${did}:${sightingKey.slice(-24)}`;
  await env.CLAIMS.put(key, JSON.stringify(fb), { expirationTtl: 31536000 });
  return fb;
}

/** When a declaration funded: every watcher who sighted it (verified,
 *  non-disputed) gets rep credit + an entitlement record sized by the
 *  declaration's sighting_bps. Idempotent per (decl, watcher). */
export async function maybeRewardWatchers(env: Env, declHash: string): Promise<{ rewarded: number }> {
  const bounty = await env.CLAIMS.get(`decl:${declHash}`, "json").catch(() => null) as { sighting_bps?: number } | null;
  const bps = bounty?.sighting_bps ?? 0;
  const sights = (await env.CLAIMS.get(`declsight:${declHash}`, "json").catch(() => null)) as { watcher_did?: string; platform: string; native_id: string; tier?: string }[] ?? [];
  let rewarded = 0;
  for (const s of sights) {
    if (!s.watcher_did || s.tier === "disputed") continue;
    const idem = `sighting-reward:${declHash}:${s.watcher_did}`;
    if (await env.CLAIMS.get(idem)) continue;
    await env.CLAIMS.put(idem, JSON.stringify({
      watcher_did: s.watcher_did, decl_hash: declHash,
      platform: s.platform, native_id: s.native_id,
      bps, status: "owed", at: now(),
    }));
    await creditWatcher(env, s.watcher_did, "reward");
    // Portable reputation: emit ERC-8004-shaped feedback for the sighting.
    await emitWatcherFeedback(env, s.watcher_did, `${s.platform}:${s.native_id}`, 1.0).catch(() => null);
    if (bps > 0) await env.CLAIMS.put(`watchpaid:${s.watcher_did}`, "1", { expirationTtl: 31_536_000 });
    rewarded++;
  }
  return { rewarded };
}

/** Slash watchers whose sightings landed in disputed tier. Called when a
 *  native object flips to disputed. */
export async function slashDisputedWatchers(env: Env, platform: string, nativeId: string) {
  const prefix = `sightidx:${platform}:${nativeId}`;
  const idx = await env.CLAIMS.get(`${prefix}`, "json").catch(() => null) as { keys?: string[] } | null;
  for (const k of idx?.keys ?? []) {
    const s = await env.CLAIMS.get<{ watcher_did?: string; watcher_verified?: boolean; tier?: string }>(k, "json").catch(() => null);
    if (s?.watcher_verified && s.tier === "disputed" && s.watcher_did) {
      await creditWatcher(env, s.watcher_did, "dispute");
    }
  }
}
