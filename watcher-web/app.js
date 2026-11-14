// app.js — Widespread Watcher (Tier 0). Zero install: nostr.bundle.js +
// IndexedDB + WebCrypto. Identity = nostr keypair generated in-browser.
import { store } from "./store.js";
import {
  canonicalJson, buildSighting, sightingEventTemplate, stateEventTemplate,
  parseSightingContent, corroborationTier, dedupeKey, textHash,
  encryptState, decryptState, exportEncrypted, importEncrypted,
  bytesToHex, hexToBytes, bytesToB64, DEFAULT_RELAYS,
  capacitySnapshotEventTemplate,
} from "./core.mjs";

const N = window.NostrTools;
if (!N) { document.body.innerHTML = "<p>nostr.bundle.js failed to load</p>"; throw new Error("no nostr"); }

const $ = (id) => document.getElementById(id);
const log = (el, msg) => { const e = $(el); e.textContent = (msg + "\n" + e.textContent).slice(0, 8000); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- identity ----------
let sk = null, pk = null;
async function loadIdentity() {
  const hex = await store.getKV("nsec");
  if (hex) { sk = hexToBytes(hex); pk = N.getPublicKey(sk); showIdentity(); connectRelays(); }
}
function showIdentity() {
  $("id-new").classList.add("hidden"); $("id-have").classList.remove("hidden");
  $("id-pill").textContent = useNip07 ? "watcher (NIP-07)" : "watcher"; $("id-pill").classList.add("on");
  $("npub").textContent = N.nip19.npubEncode(pk);
  if (useNip07) { $("nsec").value = "(external signer — key never leaves the extension)"; return; }
  try { $("nsec").value = N.nip19.nsecEncode(sk); } catch { $("nsec").value = bytesToHex(sk); }
}
$("btn-gen").onclick = async () => {
  useNip07 = false;
  sk = N.generateSecretKey(); pk = N.getPublicKey(sk);
  await store.putKV("nsec", bytesToHex(sk));
  showIdentity(); connectRelays(); loadSurfaces();
};
// NIP-07: adopt the user's existing Nostr signer extension (Alby/nos2x/Amber)
// — no key material touches this page; state sync disabled (can't export).
$("btn-nip07").onclick = async () => {
  if (!window.nostr) return alert("no window.nostr — install a NIP-07 signer extension (Alby, nos2x, Amber) first");
  try {
    useNip07 = true;
    pk = await window.nostr.getPublicKey();
    showIdentity(); connectRelays(); loadSurfaces();
    log("relay-log", "using NIP-07 signer — no local key stored");
  } catch (e) { useNip07 = false; alert("NIP-07 failed: " + e.message); }
};
$("btn-copy-nsec").onclick = () => navigator.clipboard.writeText($("nsec").value);
$("btn-export").onclick = async () => {
  const pass = $("pass").value; if (!pass) return alert("set a passphrase first");
  const state = await collectState();
  $("blob").value = await exportEncrypted(pass, { v: 1, kind: "widespread-watcher-identity", nsec: bytesToHex(sk), ...state });
};
$("btn-import").onclick = () => $("file-import").click();
$("file-import").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const pass = $("pass").value; if (!pass) return alert("set passphrase");
  try {
    const obj = await importEncrypted(pass, await f.text());
    if (obj.nsec) { sk = hexToBytes(obj.nsec); pk = N.getPublicKey(sk); await store.putKV("nsec", obj.nsec); }
    if (obj.watermark) await store.putKV("watermark", obj.watermark);
    if (obj.watch_config) await store.putKV("surfaces", obj.watch_config.surfaces ?? []);
    showIdentity(); connectRelays(); renderSurfaces();
    log("watch-log", "imported identity+state");
  } catch { alert("import failed — wrong passphrase or corrupt blob"); }
};

// ---------- relays ----------
let pool = null;
// signer abstraction: local keypair (default) or NIP-07 window.nostr
let useNip07 = false;
async function currentPubkey() { return useNip07 ? (await window.nostr.getPublicKey()) : pk; }
async function signTemplate(template) {
  if (useNip07) {
    const ev = await window.nostr.signEvent({ ...template, pubkey: await currentPubkey() });
    return ev;
  }
  return N.finalizeEvent(template, sk);
}
function relayList() { return $("relays").value.split(",").map((s) => s.trim()).filter(Boolean); }
function connectRelays() {
  if (!sk && !useNip07) return;
  pool = new N.SimplePool();
  $("relay-pill").textContent = `relays: ${relayList().length}`; $("relay-pill").classList.add("on");
  log("relay-log", "pool ready — " + relayList().join(", "));
  flushOutbox();
}
$("btn-connect").onclick = () => { pool = new N.SimplePool(); log("relay-log", "reconnected"); flushOutbox(); };

// relay health: track accept/fail per relay URL for honest status
const relayHealth = new Map();
function noteRelay(url, ok) { const h = relayHealth.get(url) ?? { ok: 0, fail: 0 }; ok ? h.ok++ : h.fail++; relayHealth.set(url, h); }

async function publishRaw(template) {
  const ev = await signTemplate(template);
  if (!pool) pool = new N.SimplePool();
  const rs = relayList();
  // publish per-relay so one dead relay can't sink the batch; health-tracked
  const results = await Promise.allSettled(rs.map(async (r) => {
    const p = new N.SimplePool();
    try { const o = await p.publish([r], ev); noteRelay(r, true); return o; }
    catch (e) { noteRelay(r, false); throw e; }
    finally { try { p.close([r]); } catch {} }
  }));
  const oks = results.filter((r) => r.status === "fulfilled");
  const healthy = rs.filter((r) => (relayHealth.get(r)?.ok ?? 0) > (relayHealth.get(r)?.fail ?? 0));
  log("relay-log", `published ${ev.id.slice(0, 12)}… accepted:${oks.length}/${rs.length} healthy:[${healthy.join(",")}]`);
  if (!oks.length) throw new Error("no relay accepted");
  return ev;
}

// offline outbox: sightings queue in IndexedDB when relays/online fail,
// flushed on reconnect, 'online' event, and each successful publish.
async function flushOutbox() {
  const q = await store.drainOutbox();
  for (const item of q) {
    try { await publishRaw(item.template); }
    catch { await store.pushOutbox(item); break; } // requeue remainder on failure
  }
  if (q.length) log("relay-log", `outbox flushed (${q.length} queued)`);
}
window.addEventListener("online", flushOutbox);
setInterval(flushOutbox, 60000);

async function publishEvent(template) {
  try {
    if (!navigator.onLine) throw new Error("offline");
    return await publishRaw(template);
  } catch (e) {
    // queue the *content* so a later flush can rebuild the event
    await store.pushOutbox({ template, queued_at: Date.now() });
    log("relay-log", `queued offline (${e.message})`);
    return null;
  }
}
async function queryRelays(filter) {
  if (!pool) pool = new N.SimplePool();
  return pool.querySync(relayList(), filter);
}

// ---------- sightings ----------
async function emitSighting({ platform, native_id, url, author, text, ts }) {
  const content = buildSighting({ platform, native_id, url, author, text, ts: ts ?? Math.floor(Date.now() / 1000) });
  const ev = await publishEvent(sightingEventTemplate(await currentPubkey(), content));
  // store locally
  const th = await textHash(text);
  await store.putSighting({
    dedupe: dedupeKey(platform, native_id, await currentPubkey()),
    platform, native_id, url, author, text, ts: content.ts,
    watcher_id: await currentPubkey(), watcher_did: null, sig: null,
    text_hash: th, tier: "lead", verified: true, seen_count: 1,
    first_seen: Date.now(), last_seen: Date.now(), event_id: ev.id,
  });
  await bumpSeen(platform, native_id, await currentPubkey(), th);
  renderFeed();
  return ev;
}

const seenMap = new Map(); // "platform|native|watcher" -> text_hash (local mirror of dedupe)
async function bumpSeen(platform, native_id, watcher, th) {
  const key = `${platform}|${native_id}|${watcher}`;
  if (seenMap.get(key) === th) return false;
  seenMap.set(key, th);
  await store.putSeen([`${key}|${th}`]);
  return true;
}

// ingest sightings discovered on relays (other watchers' + ours echoed back)
async function ingestRelayEvents(events) {
  let n = 0;
  for (const ev of events) {
    if (ev.kind !== 30078) continue;
    const t = (ev.tags.find((x) => x[0] === "t") || [])[1];
    if (t !== "widespread-sighting") continue;
    const c = parseSightingContent(ev);
    if (!c) continue;
    const watcher = ev.pubkey;
    const fresh = await bumpSeen(c.platform, c.native_id, watcher, await textHash(c.text));
    if (!fresh) { /* update last_seen */ }
    const th = await textHash(c.text);
    await store.putSighting({
      dedupe: dedupeKey(c.platform, c.native_id, watcher),
      platform: c.platform, native_id: c.native_id, url: c.url, author: c.author,
      text: c.text, ts: c.ts, watcher_id: watcher, watcher_did: c.watcher_did, sig: c.sig,
      text_hash: th, tier: "lead", verified: true, seen_count: 1,
      first_seen: Date.now(), last_seen: Date.now(), event_id: ev.id,
    });
    n++;
  }
  if (n) { renderFeed(); log("watch-log", `ingested ${n} relay sightings`); }
}

// ---------- surfaces / watchers ----------
const DECL_RE = /widespread\s+(declare|bounty|task)/i;
const CLAIM_RE = /widespread\s+claim\s+(\S+)/i;
const RECEIPT_RE = /widespread\s+receipt\s+(\S+)/i;

async function loadSurfaces() {
  const s = (await store.getKV("surfaces")) ?? [
    { platform: "discourse:meta.discourse.org", url: "https://meta.discourse.org/latest.json", kind: "json" },
    { platform: "hn:algolia", url: "https://hn.algolia.com/api/v1/search?query=widespread&tags=story", kind: "hn" },
  ];
  await store.putKV("surfaces", s);
  renderSurfaces();
}
function renderSurfaces() {
  store.getKV("surfaces").then((list) => {
    $("surfaces").innerHTML = (list || []).map((s, i) =>
      `<div class="item"><b>${esc(s.platform)}</b> <span class="meta">${esc(s.url)}</span>
       <button data-rm="${i}" style="float:right">✕</button></div>`).join("");
    document.querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => {
      const l = await store.getKV("surfaces"); l.splice(+b.dataset.rm, 1); await store.putKV("surfaces", l); renderSurfaces();
    });
  });
}
$("btn-add-surface").onclick = async () => {
  const platform = $("new-platform").value.trim(), url = $("new-url").value.trim(), kind = $("new-kind").value;
  if (!platform || !url) return;
  const l = (await store.getKV("surfaces")) ?? []; l.push({ platform, url, kind });
  await store.putKV("surfaces", l); renderSurfaces();
};

function extractItems(surface, data) {
  if (surface.kind === "hn") {
    return (data.hits || []).map((h) => ({ id: String(h.objectID), author: h.author, text: `${h.title ?? ""} ${h.url ?? ""}`, url: h.url ? `https://news.ycombinator.com/item?id=${h.objectID}` : undefined, ts: h.created_at_i }));
  }
  if (surface.kind === "rss") return parseRSS(data);
  // json: find first array of objects with id + text-ish field
  const grammar = new RegExp($("grammar").value || "widespread", "i");
  const arr = findArray(data);
  return (arr || []).map((o) => {
    const id = String(o.id ?? o.topic_id ?? o.native_id ?? "");
    const text = String(o.title ?? "") + " " + String(o.excerpt ?? o.blurb ?? o.raw ?? o.text ?? "");
    return { id, author: o.username ?? o.user?.username ?? o.author, text: text.trim(), url: o.url ?? (o.slug ? `https://meta.discourse.org/t/${o.slug}/${id}` : undefined), ts: o.created_at ? Math.floor(new Date(o.created_at).getTime() / 1000) : o.bumped_at ? Math.floor(new Date(o.bumped_at).getTime() / 1000) : undefined };
  }).filter((i) => i.id && grammar.test(i.text));
}
function findArray(o, depth = 0) {
  if (depth > 4 || !o || typeof o !== "object") return null;
  if (Array.isArray(o)) return o.length && typeof o[0] === "object" ? o : null;
  for (const k of Object.keys(o)) { const r = findArray(o[k], depth + 1); if (r) return r; }
  return null;
}
function parseRSS(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const grammar = new RegExp($("grammar").value || "widespread", "i");
  return [...doc.querySelectorAll("item")].map((it) => ({
    id: it.querySelector("guid")?.textContent ?? it.querySelector("link")?.textContent ?? "",
    author: it.querySelector("author")?.textContent ?? it.querySelector("dc\\:creator")?.textContent,
    text: (it.querySelector("title")?.textContent ?? "") + " " + (it.querySelector("description")?.textContent ?? ""),
    url: it.querySelector("link")?.textContent,
    ts: it.querySelector("pubDate") ? Math.floor(new Date(it.querySelector("pubDate").textContent).getTime() / 1000) : undefined,
  })).filter((i) => i.id && grammar.test(i.text));
}

async function pollSurface(surface) {
  const res = await fetch(surface.url, { headers: { accept: "application/json, application/rss+xml, */*" } });
  const body = surface.kind === "rss" ? await res.text() : await res.json();
  const items = extractItems(surface, body);
  for (const it of items) {
    const fresh = await bumpSeen(surface.platform, it.id, await currentPubkey(), await textHash(it.text));
    if (!fresh) continue;
    await emitSighting({ platform: surface.platform, native_id: it.id, url: it.url, author: it.author, text: it.text.slice(0, 4000), ts: it.ts });
    log("watch-log", `sighting: ${surface.platform}:${it.id}`);
  }
  return items.length;
}
async function pollAll() {
  if (!pk && !useNip07) return alert("generate an identity first");
  const surfaces = (await store.getKV("surfaces")) ?? [];
  for (const s of surfaces) {
    try { const n = await pollSurface(s); log("watch-log", `${s.platform}: ${n} matching items`); }
    catch (e) { log("watch-log", `${s.platform}: poll failed — ${e.message}`); }
  }
  // pull relay sightings too
  try {
    const evs = await queryRelays([{ kinds: [30078], "#t": ["widespread-sighting"], limit: 200 }]);
    await ingestRelayEvents(evs);
  } catch (e) { log("relay-log", "relay query failed: " + e.message); }
  renderFeed();
}
$("btn-poll").onclick = pollAll;
$("auto").onchange = (e) => { if (e.target.checked) setInterval(pollAll, 60000); };

// keep-alive: screen wake lock reduces browser tab throttling while watching
let wakeLock = null;
async function toggleWakeLock() {
  try {
    if (wakeLock) { await wakeLock.release(); wakeLock = null; log("watch-log", "wake lock released"); }
    else { wakeLock = await navigator.wakeLock.request("screen"); log("watch-log", "wake lock held — tab stays active"); }
  } catch (e) { log("watch-log", "wake lock unavailable: " + e.message); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && wakeLock === null && $("auto").checked) toggleWakeLock(); });

// ---------- state sync ----------
async function collectState() {
  const surfaces = (await store.getKV("surfaces")) ?? [];
  const watermark = (await store.getKV("watermark")) ?? Math.floor(Date.now() / 1000) - 86400;
  const seen = (await store.getSeen()).slice(-500);
  return { v: 1, watermark, watch_config: { surfaces, relays: relayList() }, seen_tail: seen };
}
$("btn-sync-out").onclick = async () => {
  if (useNip07) return alert("state sync needs an exportable key — NIP-07 signers can't export; use the local keypair or wsd export");
  if (!sk) return;
  const state = await collectState();
  const ct = await encryptState(state, sk);
  await publishEvent(stateEventTemplate(pk, ct));
  log("relay-log", "state event published");
};
$("btn-sync-in").onclick = async () => {
  if (useNip07) return alert("state sync needs an exportable key — NIP-07 signers can't export");
  if (!sk) return;
  const evs = await queryRelays([{ kinds: [30078], authors: [pk], "#t": ["widespread-watcher-state"], limit: 1 }]);
  if (!evs.length) return log("relay-log", "no state events found");
  try {
    const state = await decryptState(evs[0].content, sk);
    if (state.watch_config?.surfaces) await store.putKV("surfaces", state.watch_config.surfaces);
    if (state.watermark) await store.putKV("watermark", state.watermark);
    if (state.seen_tail) { seenMap.clear(); for (const h of state.seen_tail) seenMap.set(h.split("|").slice(0, 3).join("|"), h.split("|")[3]); await store.putSeen(state.seen_tail); }
    renderSurfaces(); renderFeed();
    log("relay-log", `state restored from ${evs[0].id.slice(0, 12)}… watermark=${state.watermark}`);
  } catch (e) { log("relay-log", "state decrypt failed: " + e.message); }
};

// ---------- discovery UI ----------
function tierOf(platform, native_id, rows) {
  const rel = rows.filter((r) => r.platform === platform && r.native_id === native_id);
  const verified = rel.filter((r) => r.verified !== false).map((r) => ({ watcher_id: r.watcher_id, text_hash: r.text_hash }));
  return corroborationTier(verified);
}
async function renderFeed() {
  const all = await store.allSightings();
  $("stat-pill").textContent = `sightings: ${all.length}`;
  const byTask = new Map();
  for (const s of all) {
    const k = `${s.platform}|${s.native_id}`;
    if (!byTask.has(k)) byTask.set(k, []);
    byTask.get(k).push(s);
  }
  renderCapacity(all);
  $("feed").innerHTML = [...byTask.entries()].slice(-50).reverse().map(([k, rows]) => {
    const s = rows[0];
    const tier = tierOf(s.platform, s.native_id, all);
    const cls = s.text.match(DECL_RE) ? "decl" : s.text.match(CLAIM_RE) ? "" : "";
    return `<div class="item"><span class="tier-${tier}">[${tier}]</span>
      <b>${esc(s.platform)}:${esc(s.native_id)}</b>
      <span class="meta">watchers:${rows.length} ${s.author ? "by " + esc(s.author) : ""}</span><br>
      <span class="${cls}" style="font-size:12px">${esc(s.text.slice(0, 200))}</span></div>`;
  }).join("") || "<div class='meta'>no sightings yet</div>";
}

// Capacity view: parse `dims: C_e,C_h` declarations out of sighting text
// and aggregate — a local C(t) index any observer can recompute.
const DIMS = ["C_e", "C_h", "C_k", "C_inst", "C_m"];
function capacityView(all) {
  const byDim = Object.fromEntries(DIMS.map((d) => [d, 0]));
  let tagged = 0;
  for (const s of all) {
    const m = s.text.match(/dims:\s*([A-Za-z_,\s]+)/i);
    if (!m) continue;
    tagged++;
    for (const d of m[1].split(",")) {
      const t = d.trim();
      if (byDim[t] != null) byDim[t]++;
    }
  }
  return { byDim, tagged };
}
function renderCapacity(all) {
  const { byDim, tagged } = capacityView(all);
  $("capacity").innerHTML = `<div class="meta">${tagged} capacity-tagged sightings</div>` +
    DIMS.map((d) => `<div class="item"><b>${d}</b> <span class="meta">${byDim[d]} declarations</span></div>`).join("");
}

$("btn-query-local").onclick = async () => {
  const all = await store.allSightings();
  const p = $("q-platform").value, n = $("q-native").value, t = $("q-text").value.toLowerCase();
  const rows = all.filter((s) => (!p || s.platform.includes(p)) && (!n || s.native_id.includes(n)) && (!t || s.text.toLowerCase().includes(t)));
  $("results").innerHTML = rows.slice(0, 50).map((s) =>
    `<div class="item"><b>${esc(s.platform)}:${esc(s.native_id)}</b> <span class="meta">${esc(s.watcher_id?.slice(0, 12) ?? "")}…</span><br>${esc(s.text.slice(0, 160))}</div>`).join("") || "none";
};
$("btn-query-relay").onclick = async () => {
  const filter = { kinds: [30078], "#t": ["widespread-sighting"], limit: 100 };
  if ($("q-platform").value) filter["#d"] = [`${$("q-platform").value}:${$("q-native").value || ""}`];
  try {
    const evs = await queryRelays([filter]);
    await ingestRelayEvents(evs);
    $("btn-query-local").onclick();
    log("relay-log", `relay query → ${evs.length} events`);
  } catch (e) { log("relay-log", "query failed: " + e.message); }
};

$("btn-snapshot").onclick = async () => {
  try {
    const all = await store.allSightings();
    const { byDim } = capacityView(all);
    const byPlatform = {}, byTier = {};
    for (const s of all) {
      byPlatform[s.platform] = (byPlatform[s.platform] ?? 0) + 1;
      const t = tierOf(s.platform, s.native_id, all); byTier[t] = (byTier[t] ?? 0) + 1;
    }
    const pk = await currentPubkey();
    const ev = capacitySnapshotEventTemplate(pk, {
      v: 1, sightings: all.length, by_platform: byPlatform, by_tier: byTier,
      capacity_dims: byDim, at: Math.floor(Date.now() / 1000),
    });
    await publishEvent(ev);
    $("snapshot-log").textContent = "snapshot published";
  } catch (e) { $("snapshot-log").textContent = "failed: " + e.message; }
};

$("btn-wake").onclick = toggleWakeLock;

// boot
loadIdentity().then(() => loadSurfaces().then(renderSurfaces).then(renderFeed));
