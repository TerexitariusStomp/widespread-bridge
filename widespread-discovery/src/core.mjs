// core.mjs — runtime-neutral discovery protocol core.
// Zero imports: runs in browsers (ES module), Node 18+, and any JS runtime.
// Uses WebCrypto (crypto.subtle) for hashing/encryption — available in all
// modern browsers and Node ≥ 19 (and ≥ 20 stable). Nostr event construction
// is delegated to an injected signer so this file needs no secp256k1 code.

export const PROTOCOL = "widespread-discovery/1";
export const SIGHTING_KIND = 30078;
export const T_SIGHTING = "widespread-sighting";
export const T_SNAPSHOT = "widespread-feed-snapshot";
export const T_STATE = "widespread-watcher-state";
export const T_CAPACITY_SNAPSHOT = "widespread-capacity-snapshot";
// Verified 2026-11-14 to actually RETAIN kind-30078 parameterized-
// replaceable sightings: most public relays ACK (OK:true) then silently
// drop non-standard kinds, and nos.lol/damus/nostr.band do not serve
// them at all. Keep this list to relays proven to store + serve them;
// extend via WSD_RELAYS as more are verified.
export const DEFAULT_RELAYS = [
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://nostr.bitcoiner.social",
];
export const STATE_SALT = "widespread-watcher-state";
export const STATE_INFO = "v1";

// ---- canonical JSON (byte-identical to src/artifacts.ts canonicalJson) ----
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
    .join(",") + "}";
}

const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(b);

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", utf8(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** text_hash per spec: first 16 hex chars of sha256(text). */
export async function textHash(text) {
  return (await sha256Hex(text)).slice(0, 16);
}

// ---- sighting sign message (identical to src/sightings.ts) ----
export function sightingSignMessage(s) {
  return "widespread-sighting:" + canonicalJson({
    platform: s.platform,
    native_id: s.native_id,
    url: s.url ?? null,
    author: s.author ?? null,
    text: s.text,
    ts: s.ts ?? null,
    watcher_did: s.watcher_did ?? null,
  });
}

/** Build the sighting content object (canonical-JSON-ready). */
export function buildSighting({ platform, native_id, url, author, text, ts, watcher_did, sig }) {
  return {
    v: 1,
    platform, native_id,
    url: url ?? null, author: author ?? null,
    text, ts: ts ?? null,
    watcher_did: watcher_did ?? null,
    sig: sig ?? null,
  };
}

/** Sign a sighting's core payload with an Ed25519 private key (JWK or raw).
 * `signer` is an async (message:string)=>base64 function; kept injectable so
 * WebCrypto (browser), node:crypto, or a KMS/HSM all work. */
export async function signSightingPayload(sightingCore, signer) {
  return signer(sightingSignMessage(sightingCore));
}

// ---- nostr event construction (injected finalizeEvent) ----
/** Build an unsigned template; caller passes it to nostr-tools
 * finalizeEvent or an equivalent BIP340 signer. */
export function sightingEventTemplate(pubkey, sightingContent, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    tags: [
      ["d", `${sightingContent.platform}:${sightingContent.native_id}`],
      ["platform", sightingContent.platform],
      ["native_id", sightingContent.native_id],
      ["w", pubkey],
      ["t", T_SIGHTING],
    ],
    content: typeof sightingContent === "string" ? sightingContent : canonicalJson(sightingContent),
    pubkey,
  };
}

export function stateEventTemplate(pubkey, ciphertextB64, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    // kind 30078 is parameterized-replaceable (NIP-33): a "d" tag is REQUIRED
    // or relays reject/drop the event. "state" = latest-wins per pubkey.
    tags: [["t", T_STATE], ["d", "state"]],
    content: ciphertextB64,
    pubkey,
  };
}

export function snapshotEventTemplate(pubkey, snapshot, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    tags: [["t", T_SNAPSHOT], ["d", "snapshot"]],
    content: typeof snapshot === "string" ? snapshot : canonicalJson(snapshot),
    pubkey,
  };
}

/** Public C(t) index snapshot (MORE P7): per-dimension/per-platform
 *  sighting counts any observer can recompute. Parameterized-replaceable
 *  d:"capacity" → latest wins per watcher. */
export function capacitySnapshotEventTemplate(pubkey, snapshot, nowSec = Math.floor(Date.now() / 1000)) {
  return {
    kind: SIGHTING_KIND,
    created_at: nowSec,
    tags: [["t", T_CAPACITY_SNAPSHOT], ["d", "capacity"]],
    content: typeof snapshot === "string" ? snapshot : canonicalJson(snapshot),
    pubkey,
  };
}

// ---- verification helpers ----
export function parseSightingContent(event) {
  try {
    const c = JSON.parse(event.content);
    return c && c.v === 1 && c.platform && c.native_id && typeof c.text === "string" ? c : null;
  } catch { return null; }
}

/** Corroboration tier per spec §2 — deterministic, local. */
export function corroborationTier(verifiedSightings) {
  // verifiedSightings: [{watcher_id, text_hash}] — already signature-verified
  const hashes = new Set(verifiedSightings.map((s) => s.text_hash));
  if (hashes.size > 1 && verifiedSightings.length >= 2) return "disputed";
  const counts = new Map();
  for (const s of verifiedSightings) {
    const id = s.watcher_id;
    if (!counts.has(s.text_hash)) counts.set(s.text_hash, new Set());
    counts.get(s.text_hash).add(id);
  }
  for (const set of counts.values()) if (set.size >= 2) return "corroborated";
  return "lead";
}

/** Dedupe key per spec §3. */
export function dedupeKey(platform, native_id, watcher_id) {
  return `${platform}|${native_id}|${watcher_id}`;
}

// ---- AES-256-GCM state encryption (HKDF from private key) ----
async function hkdfAesKey(ikmBytes, saltStr, infoStr) {
  const base = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(saltStr), info: utf8(infoStr) },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptState(payloadObj, privateKeyBytes) {
  const key = await hkdfAesKey(privateKeyBytes, STATE_SALT, STATE_INFO);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, utf8(canonicalJson(payloadObj)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return b64encode(out);
}

export async function decryptState(ciphertextB64, privateKeyBytes) {
  const raw = b64decode(ciphertextB64);
  const key = await hkdfAesKey(privateKeyBytes, STATE_SALT, STATE_INFO);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(fromUtf8(pt));
}

// ---- manual export blob (PBKDF2 passphrase → AES-256-GCM) ----
export async function exportEncrypted(passphrase, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey("raw", utf8(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(canonicalJson(obj)));
  const out = new Uint8Array(salt.length + iv.length + ct.byteLength);
  out.set(salt, 0); out.set(iv, salt.length); out.set(new Uint8Array(ct), salt.length + iv.length);
  return b64encode(out);
}

export async function importEncrypted(passphrase, b64) {
  const raw = b64decode(b64);
  const base = await crypto.subtle.importKey("raw", utf8(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: raw.slice(0, 16), iterations: 600000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.slice(16, 28) }, key, raw.slice(28));
  return JSON.parse(fromUtf8(pt));
}

// ---- base64 helpers (no Buffer dependency) ----
export function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function b64decode(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const bytesToB64 = b64encode;
export const b64ToBytes = b64decode;
