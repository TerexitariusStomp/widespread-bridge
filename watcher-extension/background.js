// background.js — holds the watcher keypair + relay pool. Content scripts
// never see key material; they request signatures/events via messages.
importScripts("nostr.bundle.js");
const N = self.NostrTools;
const FALLBACK_RELAYS = ["wss://relay.snort.social", "wss://relay.primal.net", "wss://nostr.bitcoiner.social"];
const DEFAULT_GRAMMAR = /widespread\s+(declare|bounty|task|claim|receipt|bind)/i;
let cfg = { relays: FALLBACK_RELAYS, grammar: "widespread\\s+(declare|bounty|task|claim|receipt|bind)" };

async function loadConfig() {
  const c = await chrome.storage.local.get(["relays", "grammar"]);
  if (Array.isArray(c.relays) && c.relays.length) cfg.relays = c.relays.filter((r) => /^wss:\/\//.test(r));
  if (c.grammar) cfg.grammar = c.grammar;
}
loadConfig();
const GRAMMAR = () => { try { return new RegExp(cfg.grammar, "i"); } catch { return DEFAULT_GRAMMAR; } };

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
function relays() { return cfg.relays; }

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

// ---- credential broker (§9): scoped grants, declared ops only, audit ----
const CRED_RE = /("(?:cookie|set-cookie|authorization|x-api-key|token|session|password|secret)"\s*:\s*)"[^"]*"/gi;

async function getGrants() { return (await chrome.storage.local.get("grants")).grants ?? []; }
async function putGrant(g) {
  const grants = await getGrants();
  grants.push(g);
  await chrome.storage.local.set({ grants: grants.slice(-100) });
  return g;
}
async function audit(rec) {
  const a = (await chrome.storage.local.get("audit")).audit ?? [];
  a.push({ ...rec, ts: Date.now() });
  await chrome.storage.local.set({ audit: a.slice(-200) });
}
function checkGrant(g, surface, op, mode = "read") {
  const now = Math.floor(Date.now() / 1000);
  return g && g.v === "widespread-grant/1" && g.surface === surface && g.expires > now
    && g.ops.includes(op) && (mode !== "write" || g.mode === "write");
}
// resolve declared op → URL. surfaceCfg.api = {op: "/path/{param}"} relative
// to surfaceCfg.base_url, or absolute https URL. Agent never picks a URL.
function resolveOp(cfg, op, params = {}) {
  const tmpl = cfg?.api?.[op];
  if (typeof tmpl !== "string") return null;
  let url = tmpl;
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(String(v))) return null;
    url = url.split(`{"${k}"}`).join(encodeURIComponent(String(v))).split(`{${k}}`).join(encodeURIComponent(String(v)));
  }
  if (url.includes("{")) return null;
  if (url.startsWith("/")) {
    if (!cfg.base_url) return null;
    url = cfg.base_url.replace(/\/$/, "") + url;
  }
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return null; return u.toString(); }
  catch { return null; }
}
async function execOp(msg) {
  // msg: {grant_id or inline grant, surface, op, params, mode}
  const grants = await getGrants();
  const grant = msg.grant ?? grants.find((g) => g.id === msg.grant_id);
  const cfgs = (await chrome.storage.local.get("surfaces")).surfaces ?? [];
  const cfg = cfgs.find((c) => c.platform === msg.surface || `discourse:${new URL(c.base_url ?? "https://x").hostname}` === msg.surface);
  if (!checkGrant(grant, msg.surface, msg.op, msg.mode)) {
    await audit({ op: msg.op, surface: msg.surface, denied: "grant" });
    return { error: "grant denied", surface: msg.surface, op: msg.op };
  }
  grant.calls = (grant.calls ?? 0) + 1;
  if (grant.calls > grant.max_calls) { await audit({ op: msg.op, surface: msg.surface, denied: "max_calls" }); return { error: "grant exhausted" }; }
  const url = resolveOp(cfg, msg.op, msg.params ?? {});
  if (!url) { await audit({ op: msg.op, surface: msg.surface, denied: "undeclared op" }); return { error: "op not declared for surface" }; }
  // credentials:"include" — browser attaches session; we never see cookies
  const res = await fetch(url, { credentials: "include", headers: { accept: "application/json, */*" } });
  const body = await res.text();
  const clean = body.replace(CRED_RE, '$1"[REDACTED]"').slice(0, 64000);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  await audit({ op: msg.op, surface: msg.surface, result_hash: hash, status: res.status });
  await chrome.storage.local.set({ grants });
  return { url, status: res.status, body: clean };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "wsd:identity") { const id = await ensureIdentity(); sendResponse({ pubkey: id.pk, nsec: N.nip19.nsecEncode(id.sk) }); }
      else if (msg.type === "wsd:sighting") sendResponse(await publishSighting(msg.sighting));
      else if (msg.type === "wsd:grammar-test") sendResponse({ match: GRAMMAR().test(msg.text) });
      else if (msg.type === "wsd:grant-put") { const g = await putGrant({ ...msg.grant, id: crypto.randomUUID() }); sendResponse({ ok: true, grant: g }); }
      else if (msg.type === "wsd:op") sendResponse(await execOp(msg));
      else if (msg.type === "wsd:audit") sendResponse({ audit: (await chrome.storage.local.get("audit")).audit ?? [] });
      else if (msg.type === "wsd:config-get") sendResponse({ relays: cfg.relays, grammar: cfg.grammar, surfaces: (await chrome.storage.local.get("surfaces")).surfaces ?? [] });
      else if (msg.type === "wsd:config") {
        if (msg.relays) cfg.relays = msg.relays.filter((r) => /^wss:\/\//.test(r));
        if (msg.grammar) cfg.grammar = msg.grammar;
        if (msg.surfaces) await chrome.storage.local.set({ surfaces: msg.surfaces });
        await chrome.storage.local.set({ relays: cfg.relays, grammar: cfg.grammar });
        sendResponse({ ok: true, relays: cfg.relays });
      }
      else sendResponse({ error: "unknown" });
    } catch (e) { sendResponse({ error: e.message }); }
  })();
  return true;
});
