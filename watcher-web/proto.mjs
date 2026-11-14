// proto.mjs — collective protocol governance, Nostr-native.
//
// The protocol's *parameters* (spec version, steward set, advisory relay
// hints, schema versions) are themselves signed kind-30078 events on the
// same public relays as sightings. No website or server is a root of
// trust: any steward key can publish a meta payload, and a payload is
// "ratified" when ≥ threshold distinct keys from its declared steward
// set have published events with identical content. Clients fetch the
// newest ratified payload and adopt its hints; built-in defaults remain
// the fallback when no valid meta is found.
//
// Bootstrap honesty: the genesis payload (seq 0) is trusted-on-first-use
// — clients may pin a genesis event id/pubkey set for hardening. Once
// pinned, amendments are self-verifying: each payload declares the
// steward set that must have signed it, and that set is carried forward
// (or replaced) by the payload itself.
//
// Adapter manifests ride the same mechanism: a signed, content-addressed
// manifest is published as a 30078 event (t=widespread-adapter,
// d=adapter:<id>), so the registry survives any single host — the bridge
// worker's Durable Object becomes one mirror among many, not the root.

import { canonicalJson, SIGHTING_KIND } from "./core.mjs";

export const T_PROTOCOL_META = "widespread-protocol-meta";
export const T_ADAPTER = "widespread-adapter";
export const META_D = "meta";
export const ADAPTER_SCHEMA = "widespread-adapter/1";

export const PROTOCOL_META_V = 1;

/** Meta payload schema (content of the event, canonical JSON):
 *  {
 *    v: 1,
 *    spec: "widespread-discovery/1",
 *    seq: <int>,                    // amendment sequence, genesis = 0
 *    prev_stewards: [pkHex] | null, // set that must ratify this payload
 *    stewards: [pkHex],             // set authorized for NEXT amendments
 *    threshold: <int>,              // M-of-N required on this payload
 *    relay_hints?: [url],           // advisory default relays
 *    registry_peers?: [url],        // advisory adapter-registry mirrors
 *    schema_versions?: {name: int},
 *    note?: string,
 *  }
 *  Signatures are the nostr event signatures themselves — each steward
 *  publishes an event whose content is the identical canonical payload.
 *  Ratification = ≥ threshold distinct verified pubkeys ∈ prev_stewards
 *  (for seq 0: ∈ stewards, i.e. the declared genesis set self-ratifies).
 */

export function metaEventTemplate(pubkey, metaPayload, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    tags: [["t", T_PROTOCOL_META], ["d", META_D]],
    content: typeof metaPayload === "string" ? metaPayload : canonicalJson(metaPayload),
    pubkey,
  };
}

export function adapterEventTemplate(pubkey, manifest, nowSec = Math.floor(Date.now() / 1000)) {
  const id = manifest?.id ?? "unknown";
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    tags: [["t", T_ADAPTER], ["d", `adapter:${id}`]],
    content: canonicalJson({ schema: ADAPTER_SCHEMA, manifest }),
    pubkey,
  };
}

/** Structural validation of a meta payload (not signature checks). */
export function parseMetaPayload(raw) {
  let m;
  try { m = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!m || typeof m !== "object") return null;
  if (m.v !== PROTOCOL_META_V) return null;
  if (typeof m.seq !== "number" || !Number.isInteger(m.seq) || m.seq < 0) return null;
  if (!Array.isArray(m.stewards) || !m.stewards.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s))) return null;
  if (typeof m.threshold !== "number" || !Number.isInteger(m.threshold) || m.threshold < 1) return null;
  if (m.threshold > m.stewards.length) return null;
  if (m.prev_stewards !== null && m.prev_stewards !== undefined &&
      !(Array.isArray(m.prev_stewards) && m.prev_stewards.every((s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)))) return null;
  if (m.relay_hints !== undefined && !(Array.isArray(m.relay_hints) && m.relay_hints.every((s) => typeof s === "string"))) return null;
  if (m.registry_peers !== undefined && !(Array.isArray(m.registry_peers) && m.registry_peers.every((s) => typeof s === "string"))) return null;
  return m;
}

/**
 * Evaluate a set of kind-30078 meta events (already t=widespread-protocol-meta
 * filtered by the caller or re-filtered here). `verifyEvent` is injected
 * (nostr-tools verifyEvent in node; bundle equivalent in browser).
 *
 * Returns { payload, signers, seq, created_at } for the best ratified
 * group, or null if nothing reaches threshold.
 * Groups events by identical content; a group is ratified when ≥
 * payload.threshold distinct verified pubkeys belong to the set that
 * must sign it (prev_stewards, or stewards for genesis seq 0).
 */
export function ratifyMeta(events, verifyEvent) {
  const groups = new Map(); // content -> events[]
  for (const ev of events) {
    if (ev?.kind !== SIGHTING_KIND) continue;
    const t = (ev.tags ?? []).find((x) => x[0] === "t")?.[1];
    if (t !== T_PROTOCOL_META) continue;
    const list = groups.get(ev.content) ?? [];
    list.push(ev);
    groups.set(ev.content, list);
  }
  let best = null;
  for (const [content, evs] of groups) {
    const payload = parseMetaPayload(content);
    if (!payload) continue;
    const required = payload.seq === 0 ? payload.stewards : (payload.prev_stewards ?? payload.stewards);
    const requiredSet = new Set(required);
    const signers = new Set();
    let newest = 0;
    for (const ev of evs) {
      if (!verifyEvent(ev)) continue;
      if (!requiredSet.has(ev.pubkey)) continue;
      signers.add(ev.pubkey);
      newest = Math.max(newest, ev.created_at ?? 0);
    }
    if (signers.size < payload.threshold) continue;
    if (!best || payload.seq > best.seq || (payload.seq === best.seq && newest > best.created_at)) {
      best = { payload, signers: [...signers], seq: payload.seq, created_at: newest };
    }
  }
  return best;
}

/** Parse adapter events into {id -> {manifest, pubkey, created_at}}; latest
 *  event per adapter id wins (parameterized-replaceable d-tag already
 *  collapses per-pubkey on relays; across pubkeys we take newest). */
export function collectAdapters(events) {
  const out = new Map();
  for (const ev of events) {
    if (ev?.kind !== SIGHTING_KIND) continue;
    const t = (ev.tags ?? []).find((x) => x[0] === "t")?.[1];
    if (t !== T_ADAPTER) continue;
    let body;
    try { body = JSON.parse(ev.content); } catch { continue; }
    const m = body?.manifest;
    if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
    const prev = out.get(m.id);
    if (!prev || (ev.created_at ?? 0) > prev.created_at) {
      out.set(m.id, { manifest: m, pubkey: ev.pubkey, created_at: ev.created_at ?? 0 });
    }
  }
  return out;
}
