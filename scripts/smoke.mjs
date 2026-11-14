// smoke.mjs — one-command live battle test for every automatable surface.
//   npm run smoke        exits non-zero if any row fails
// Hermetic checks marked [local]; live checks hit deployed infra [live].
import { execFileSync, execFile, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WSD = join(root, "widespread-discovery", "src", "cli.mjs");
const RELAY_WSS = "wss://widespread-relay.widespread.workers.dev";
const RELAY_HTTPS = "https://widespread-relay.widespread.workers.dev";
const BRIDGE = "https://widespread-bridge.widespread.workers.dev";

const rows = [];
async function check(lane, name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    rows.push([lane, name, "PASS", detail ?? "", Date.now() - t0]);
  } catch (e) {
    rows.push([lane, name, "FAIL", String(e?.message ?? e), Date.now() - t0]);
  }
  const r = rows.at(-1);
  console.log(`${r[2] === "PASS" ? "✓" : "✗"} [${r[0]}] ${r[1]} ${r[3] ? "— " + r[3] : ""} (${r[4]}ms)`);
}

const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = await import(join(root, "widespread-discovery", "vendor", "nostr-tools.bundle.mjs"));

// ---------- [local] vendor bundles ----------
await check("local", "vendor bundles import", async () => {
  const r = await import(join(root, "widespread-discovery", "vendor", "rss-parser.bundle.mjs"));
  const y = await import(join(root, "widespread-discovery", "vendor", "yaml.bundle.mjs"));
  if (typeof N.finalizeEvent !== "function" || typeof N.SimplePool !== "function") throw new Error("nostr-tools missing exports");
  if (typeof r.default !== "function") throw new Error("rss-parser missing default");
  if (typeof y.parse !== "function") throw new Error("yaml missing parse");
  return `nostr-tools rss-parser yaml`;
});

// ---------- [local] relay subtree build is patched ----------
await check("local", "relay/worker.js carries our patches", async () => {
  const src = readFileSync(join(root, "relay", "worker.js"), "utf8");
  for (const needle of ["ensureDatabase", "GLOBAL_EVENT_LIMIT", "Widespread Relay"]) {
    if (!src.includes(needle)) throw new Error(`missing ${needle} — worker.js is stale, rebuild in relay/`);
  }
  return "ensureDatabase + GLOBAL_EVENT_LIMIT + relay info present";
});

// ---------- [live] relay NIP-11 ----------
await check("live", "relay NIP-11 metadata", async () => {
  const res = await Promise.race([fetch(RELAY_HTTPS, { headers: { accept: "application/nostr+json" } }), timeout(8000, "nip11")]);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.name && !j.supported_nips) throw new Error("no nip-11 fields");
  return j.name ?? `nips:${(j.supported_nips ?? []).length}`;
});

// ---------- [live] relay kind-30078 round-trip ----------
await check("live", "relay kind-30078 publish→query", async () => {
  const sk = N.generateSecretKey();
  const ev = N.finalizeEvent({
    kind: 30078, created_at: Math.floor(Date.now() / 1000),
    tags: [["d", `smoke-${Date.now()}`], ["t", "widespread-sighting"], ["platform", "smoke"], ["native_id", "smoke-rt"], ["w", "smoke"]],
    content: JSON.stringify({ v: 1, platform: "smoke", native_id: `smoke-${Date.now()}`, text: "smoke round-trip", text_hash: "x", url: "", author: "smoke" }),
  }, sk);
  const pool = new N.SimplePool();
  try {
    await Promise.race([Promise.all(pool.publish([RELAY_WSS], ev)), timeout(15000, "publish")]);
    let stored = 0;
    for (let i = 0; i < 4 && !stored; i++) {
      await sleep(2500);
      stored = (await Promise.race([pool.querySync([RELAY_WSS], { ids: [ev.id] }), timeout(8000, "query")])).length;
    }
    if (stored < 1) throw new Error("ACK'd but not retrievable");
    return `id ${ev.id.slice(0, 12)}… stored:${stored}`;
  } finally { pool.close([RELAY_WSS]); }
});

// ---------- [live] pipelined burst ----------
await check("live", "relay pipelined burst ×10", async () => {
  const sk = N.generateSecretKey();
  const ws = new WebSocket(RELAY_WSS);
  let oks = 0, closed = false;
  try {
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error("open timeout")), 8000); });
    const done = new Promise((res) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg[0] === "OK" && msg[2] === true) { if (++oks === 10) res(); }
      };
      setTimeout(res, 15000);
    });
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      const ev = N.finalizeEvent({
        kind: 30078, created_at: Math.floor(Date.now() / 1000),
        tags: [["d", `burst-${Date.now()}-${i}`], ["t", "widespread-sighting"], ["platform", "smoke"], ["native_id", `burst-${i}`], ["w", "smoke"]],
        content: JSON.stringify({ v: 1, platform: "smoke", native_id: `burst-${i}`, text: `burst ${i}`, text_hash: "x", url: "", author: "smoke" }),
      }, sk);
      ws.send(JSON.stringify(["EVENT", ev]));
    }
    await done; closed = true;
    if (oks < 10) throw new Error(`${oks}/10 OK`);
    return `10/10 OK in ${Date.now() - t0}ms`;
  } finally { if (!closed) ws.close(); else ws.close(); }
});

// ---------- [live] bridge endpoints ----------
for (const [path, want] of [["/openapi.json", '"openapi"'], ["/api/feed", "["], ["/api/feed.rss", "<feed"], ["/install", "widespread"]]) {
  await check("live", `bridge GET ${path}`, async () => {
    const res = await Promise.race([fetch(BRIDGE + path), timeout(10000, path)]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.toLowerCase().includes(want)) throw new Error(`missing ${want}`);
    return `${res.status} ${body.length}B`;
  });
}

// ---------- [live] wsd full cycle in temp HOME ----------
const tmpHome = mkdtempSync(join(tmpdir(), "wsd-smoke-"));
const wsd = (...args) => execFileSync("node", [WSD, ...args], { env: { ...process.env, HOME: tmpHome }, encoding: "utf8", timeout: 60000 });

await check("live", "wsd keygen", async () => {
  const out = wsd("keygen");
  const m = out.match(/pubkey: ([0-9a-f]{64})/);
  if (!m) throw new Error("no pubkey in output");
  return `pk ${m[1].slice(0, 12)}…`;
});

let sightingId;
await check("live", "wsd publish→verdict retained", async () => {
  const out = wsd("publish", "--platform", "smoke", "--id", `smoke-${Date.now()}`, "--text", "smoke test sighting");
  if (!/retained|stored:\s*[1-9]|verified on [1-9]/i.test(out)) throw new Error(`no retained verdict: ${out.slice(-200)}`);
  const m = out.match(/[0-9a-f]{64}/);
  sightingId = m?.[0];
  return out.trim().split("\n").pop().slice(0, 80);
});

await check("live", "wsd query returns sighting", async () => {
  const out = wsd("query", "--platform", "smoke", "--limit", "50");
  if (!/smoke|sighting/i.test(out)) throw new Error(`no sighting in query output: ${out.slice(-200)}`);
  return out.trim().split("\n").pop().slice(0, 80);
});

await check("live", "wsd gen-openapi (vendored yaml)", async () => {
  const spec = join(tmpHome, "spec.yaml");
  writeFileSync(spec, "openapi: '3.0.0'\ninfo:\n  title: Smoke API\n  version: '1'\npaths:\n  /things:\n    get:\n      operationId: listThings\n      summary: list\n");
  const out = wsd("gen-openapi", "--file", spec, "--surface", "smoke.example");
  const j = JSON.parse(out);
  if (!Array.isArray(j.ops) || j.ops.length < 1) throw new Error("no ops emitted");
  return `${j.ops.length} op(s)`;
});

// ---------- [local] wsd serve ----------
await check("local", "wsd serve /health + /api/stats", async () => {
  const port = 38000 + Math.floor(Math.random() * 2000);
  const proc = execFile("node", [WSD, "serve", "--port", String(port)], { env: { ...process.env, HOME: tmpHome } });
  try {
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      await sleep(300);
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); ok = r.ok; } catch { /* not up yet */ }
    }
    if (!ok) throw new Error("serve never came up");
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    const s = await (await fetch(`http://127.0.0.1:${port}/api/stats`)).json();
    if (!h.ok) throw new Error("bad /health");
    return `health ok, stats keys:${Object.keys(s).join(",")}`;
  } finally { proc.kill("SIGTERM"); }
});

// ---------- summary ----------
const fails = rows.filter((r) => r[2] === "FAIL");
console.log(`\n${rows.length - fails.length}/${rows.length} smoke checks passed${fails.length ? " — FAILURES:" : ""}`);
for (const r of fails) console.log(`  ✗ ${r[1]}: ${r[3]}`);
rmSync(tmpHome, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
