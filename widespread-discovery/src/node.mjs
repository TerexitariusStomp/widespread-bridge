// node.mjs — Node-side bindings: nostr-tools signer, fs key storage.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as N from "nostr-tools";
import {
  buildSighting, sightingEventTemplate, canonicalJson,
  hexToBytes, bytesToHex, DEFAULT_RELAYS,
} from "./core.mjs";

const DIR = join(homedir(), ".widespread-discovery");
const KEYFILE = join(DIR, "identity.json");
const STATE_FILE = join(DIR, "state.json");

export function relays() {
  return (process.env.WSD_RELAYS || DEFAULT_RELAYS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadIdentity() {
  if (!existsSync(KEYFILE)) return null;
  const o = JSON.parse(readFileSync(KEYFILE, "utf8"));
  const sk = hexToBytes(o.nsec_hex ?? o.nsec);
  return { sk, pk: N.getPublicKey(sk), nsec: o.nsec ?? N.nip19.nsecEncode(sk) };
}

export function keygen() {
  mkdirSync(DIR, { recursive: true });
  const sk = N.generateSecretKey();
  const id = { v: 1, nsec: N.nip19.nsecEncode(sk), nsec_hex: bytesToHex(sk), pubkey: N.getPublicKey(sk), created_at: Date.now() };
  writeFileSync(KEYFILE, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

export function importIdentity(nsecOrHex) {
  mkdirSync(DIR, { recursive: true });
  let sk;
  try { sk = N.nip19.decode(nsecOrHex).data; }
  catch { sk = hexToBytes(nsecOrHex.replace(/^0x/, "")); }
  const id = { v: 1, nsec: typeof nsecOrHex === "string" && nsecOrHex.startsWith("nsec") ? nsecOrHex : N.nip19.nsecEncode(sk), nsec_hex: bytesToHex(sk), pubkey: N.getPublicKey(sk), created_at: Date.now() };
  writeFileSync(KEYFILE, JSON.stringify(id, null, 2), { mode: 0o600 });
  return id;
}

let pool = null;
export function getPool() { if (!pool) pool = new N.SimplePool(); return pool; }
export function closePool() { try { pool?.close(relays()); } catch {} pool = null; }

export async function publish(template) {
  const id = loadIdentity();
  if (!id) throw new Error("no identity — run `wsd keygen` first");
  const ev = N.finalizeEvent(template, id.sk);
  const rs = relays();
  // Public relays are flaky — publish to each independently, tolerate
  // individual failures; success = ≥1 relay accepted.
  const results = await Promise.allSettled(rs.map(async (r) => {
    const p = new N.SimplePool();
    try { return await p.publish([r], ev); } finally { try { p.close([r]); } catch {} }
  }));
  const oks = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const errs = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
  if (!oks.length) throw new Error(`all relays failed: ${errs.join("; ")}`);
  // Relays can ACK (OK:true) then silently drop — verify the event is
  // actually retrievable before reporting success. 0 stored = failure so
  // callers queue to the outbox instead of losing the sighting.
  await new Promise((r) => setTimeout(r, 2000));
  let stored = 0;
  try {
    const found = await Promise.race([
      getPool().querySync(rs, { ids: [ev.id] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("verify timeout")), 15000)),
    ]);
    stored = found.length;
  } catch { /* verification inconclusive — relays flaky, don't fail the publish */ }
  return { event: ev, oks, relay_errors: errs, stored };
}

export async function query(filter, limit = 200) {
  return getPool().querySync(relays(), { ...filter, limit });
}

export async function publishSighting({ platform, native_id, url, author, text, ts }) {
  const id = loadIdentity();
  if (!id) throw new Error("no identity — run `wsd keygen` first");
  const content = buildSighting({ platform, native_id, url, author, text, ts: ts ?? Math.floor(Date.now() / 1000) });
  return publish(sightingEventTemplate(id.pk, content));
}

// surface allowlist — the ONLY URLs a watcher may fetch (trifecta egress
// control, spec §8). Agents can never inject URLs via tool calls.
const SURFACES_FILE = join(DIR, "surfaces.json");
export function loadSurfaces() {
  if (!existsSync(SURFACES_FILE)) return [];
  try { return JSON.parse(readFileSync(SURFACES_FILE, "utf8")); } catch { return []; }
}
export function addSurface(s) {
  mkdirSync(DIR, { recursive: true });
  const list = loadSurfaces();
  if (!list.some((x) => x.url === s.url)) { list.push(s); writeFileSync(SURFACES_FILE, JSON.stringify(list, null, 2)); }
  return list;
}
/** Throws unless every surface is in the allowlist — call before watching. */
export function assertAllowlisted(surfaces) {
  const ok = new Set(loadSurfaces().map((s) => s.url));
  const bad = surfaces.filter((s) => !ok.has(s.url));
  if (bad.length) throw new Error(`surfaces not in allowlist (wsd surface add first): ${bad.map((s) => s.url).join(", ")}`);
}

// offline outbox — sightings that failed to publish queue to disk and
// flush on the next successful run (relays are flaky; never lose work).
const OUTBOX = join(DIR, "outbox.json");
export function loadOutbox() {
  if (!existsSync(OUTBOX)) return [];
  try { return JSON.parse(readFileSync(OUTBOX, "utf8")); } catch { return []; }
}
function saveOutbox(items) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(OUTBOX, JSON.stringify(items.slice(-1000)));
}
export async function queueSighting(s) {
  const items = loadOutbox();
  items.push({ ...s, queued_at: Date.now() });
  saveOutbox(items);
}
export async function flushOutbox() {
  const items = loadOutbox();
  if (!items.length) return 0;
  const remaining = [];
  let flushed = 0;
  for (const s of items) {
    try { await publishSighting(s); flushed++; }
    catch { remaining.push(s); }
  }
  saveOutbox(remaining);
  return flushed;
}

export async function publishState(state) {
  const id = loadIdentity();
  if (!id) throw new Error("no identity");
  const { encryptState } = await import("./core.mjs");
  const ct = await encryptState(state, id.sk);
  const { stateEventTemplate } = await import("./core.mjs");
  return publish(stateEventTemplate(id.pk, ct));
}

export async function fetchState() {
  const id = loadIdentity();
  if (!id) throw new Error("no identity");
  const evs = await query({ kinds: [30078], authors: [id.pk], "#t": ["widespread-watcher-state"], limit: 10 });
  // parameterized-replaceable keeps one event per (pubkey,d), but relays can
  // transiently serve stale copies — try newest-first until one decrypts.
  const { decryptState } = await import("./core.mjs");
  for (const ev of evs.sort((a, b) => b.created_at - a.created_at)) {
    try { return await decryptState(ev.content, id.sk); } catch { /* stale/foreign state event */ }
  }
  return null;
}

// local projection index (JSON file — swarm-of-caches, rebuildable)
export function loadIndex() {
  if (!existsSync(STATE_FILE)) return { sightings: {}, watermark: 0 };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { sightings: {}, watermark: 0 }; }
}
export function saveIndex(idx) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(idx));
}

/** Ingest relay events into local index; returns count of new sightings. */
export async function ingestEvents(events) {
  const { parseSightingContent, textHash, dedupeKey, corroborationTier } = await import("./core.mjs");
  const idx = loadIndex();
  let n = 0;
  for (const ev of events) {
    if (ev.kind !== 30078) continue;
    const t = (ev.tags.find((x) => x[0] === "t") || [])[1];
    if (t !== "widespread-sighting") continue;
    const c = parseSightingContent(ev);
    if (!c) continue;
    const key = dedupeKey(c.platform, c.native_id, ev.pubkey);
    const th = await textHash(c.text);
    const prev = idx.sightings[key];
    if (prev && prev.text_hash === th) { prev.last_seen = Date.now(); continue; }
    idx.sightings[key] = {
      platform: c.platform, native_id: c.native_id, url: c.url, author: c.author,
      text: c.text, ts: c.ts, watcher_id: ev.pubkey, watcher_did: c.watcher_did,
      text_hash: th, first_seen: prev?.first_seen ?? Date.now(), last_seen: Date.now(),
      event_id: ev.id,
    };
    n++;
  }
  // recompute tiers per (platform,native_id)
  const groups = {};
  for (const s of Object.values(idx.sightings)) {
    const g = `${s.platform}${s.native_id}`;
    (groups[g] ??= []).push(s);
  }
  for (const rows of Object.values(groups)) {
    const tier = corroborationTier(rows.map((r) => ({ watcher_id: r.watcher_id, text_hash: r.text_hash })));
    for (const r of rows) r.tier = tier;
  }
  saveIndex(idx);
  return n;
}

export { canonicalJson, N };
