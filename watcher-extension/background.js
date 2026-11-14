// background.js — holds the watcher keypair + relay pool. Content scripts
// never see key material; they request signatures/events via messages.
importScripts("nostr.bundle.js");
const N = self.NostrTools;
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.snort.social"];
const GRAMMAR = /widespread\s+(declare|bounty|task|claim|receipt|bind)/i;

let sk = null, pk = null, pool = null;

async function ensureIdentity() {
  if (sk) return { sk, pk };
  const { nsec } = await chrome.storage.local.get("nsec");
  if (nsec) {
    try { sk = N.nip19.decode(nsec).data; } catch { sk = hexToBytes(nsec); }
    pk = N.getPublicKey(sk);
  } else {
    sk = N.generateSecretKey(); pk = N.getPublicKey(sk);
    await chrome.storage.local.set({ nsec: N.nip19.nsecEncode(sk) });
  }
  return { sk, pk };
}
function hexToBytes(hex) { const o = new Uint8Array(hex.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return o; }
function bytesToHex(b) { return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function getPool() { if (!pool) pool = new N.SimplePool(); return pool; }
function relays() { return DEFAULT_RELAYS; }

// canonical JSON — identical to core.mjs / artifacts.ts
function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sightingSignMessage(s) {
  return "widespread-sighting:" + canonicalJson({ platform: s.platform, native_id: s.native_id, url: s.url ?? null, author: s.author ?? null, text: s.text, ts: s.ts ?? null, watcher_did: s.watcher_did ?? null });
}

async function publishSighting(s) {
  const { sk: key, pk: pub } = await ensureIdentity();
  const content = {
    v: 1, platform: s.platform, native_id: s.native_id,
    url: s.url ?? null, author: s.author ?? null, text: s.text,
    ts: s.ts ?? Math.floor(Date.now() / 1000), watcher_did: null, sig: null,
  };
  const ev = N.finalizeEvent({
    kind: 30078, created_at: Math.floor(Date.now() / 1000), pubkey: pub,
    tags: [["d", `${content.platform}:${content.native_id}`], ["platform", content.platform], ["native_id", content.native_id], ["w", pub], ["t", "widespread-sighting"]],
    content: canonicalJson(content),
  }, key);
  const oks = await getPool().publish(relays(), ev);
  return { event_id: ev.id, oks, pubkey: pub };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "wsd:identity") { const id = await ensureIdentity(); sendResponse({ pubkey: id.pk, nsec: N.nip19.nsecEncode(id.sk) }); }
      else if (msg.type === "wsd:sighting") sendResponse(await publishSighting(msg.sighting));
      else if (msg.type === "wsd:grammar-test") sendResponse({ match: GRAMMAR.test(msg.text) });
      else sendResponse({ error: "unknown" });
    } catch (e) { sendResponse({ error: e.message }); }
  })();
  return true;
});
