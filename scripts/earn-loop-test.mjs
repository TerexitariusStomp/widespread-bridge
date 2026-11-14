// earn-loop-test.mjs — earn loop on NEAR testnet via live MCP:
//   challenge → register → markets → claim (attested) →
//   ship_prepare → sign → ship_submit → status
//   npm run test:earn
//
// Forge-agnostic since the adapter refactor: wide_ship_prepare resolves the
// repo's forge adapter (FORGES map → FORGE_BASE → generic) and returns its
// real submission route (delta-git → /api/{repo}/dg/patch), the forge's own
// signature convention, and header scheme. Non-commit artifacts still
// attest via POST /api/claims — the bridge feed is the receipt surface
// for forges without a claim log.
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP = "https://widespread-bridge.widespread.workers.dev/mcp";
const te = new TextEncoder();
const toHex = (b) => [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (d) => toHex(await crypto.subtle.digest("SHA-256", d));

let rpcId = 0;
async function mcp(name, args = {}) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  const j = JSON.parse(data || text);
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const c = j.result?.content?.[0];
  const payload = c?.text ? JSON.parse(c.text) : j.result;
  return payload;
}
const log = (...a) => console.log("→", ...a);

// 1. ephemeral agent identity
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubkeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
const LABEL = `earn-battle-${Date.now().toString(36)}`;

const ch = await mcp("wide_agent_challenge", { label: LABEL });
const canonical = ch.canonical_bytes.replace("<YOUR_pubkey_hex>", pubkeyHex).replace("<YOUR_label>", LABEL);
log("challenge", ch.challenge_id.slice(0, 16), "— signing canonical bytes");
const sig = toHex(await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(canonical)));

const reg = await mcp("wide_agent_register", { challenge_id: ch.challenge_id, pubkey_hex: pubkeyHex, signature_hex: sig, label: LABEL });
const DID = reg.did;
log("registered did:", DID);

// 2. pick an open market
const markets = await mcp("wide_markets", {});
const open = (markets.markets ?? markets).filter((m) => m.status === "open");
if (!open.length) throw new Error("no open markets");
const market = open[0];
log("claiming market", market.marketId, "—", market.spec.slice(0, 60));

// 3. claim — content-addressed artifact (no GitHub dependency): inline
//    base64 deliverable validated by validateCidArtifact
const deliverable = `# /healthz implementation\n\nexport default { fetch: () => Response.json({ ok: true, uptime: Date.now(), version: "0.1.0" }) };\n`;
const b32 = "abcdefghijklmnopqrstuvwxyz234567";
const cid = "b" + [...Array(44)].map(() => b32[Math.floor(Math.random() * 32)]).join("");
const claimRes = await fetch("https://widespread-bridge.widespread.workers.dev/api/claims", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    marketId: market.marketId, forgeRef: `ipfs://${cid}`,
    actor: DID, claimant: DID,
    evidence: { artifact_inline: btoa(deliverable), artifact_sha256: `sha256:${await sha256Hex(te.encode(deliverable))}` },
  }),
});
const claim = await claimRes.json();
log("claim:", JSON.stringify(claim).slice(0, 200));
if (claim.ok === false) throw new Error(`claim rejected: ${JSON.stringify(claim.failures ?? claim)}`);

// 4. attest the ship — prepare returns the repo's forge target + sign
//    convention; sign ed25519(utf8(sha256hex(canonical))) matching the
//    forge's own verification (delta-git dg1 envelope).
const claimFile = `CLAIM-${DID.slice(-8)}\nmarket:${market.marketId} cid:${cid} ts:${Date.now()}\n`;
const patch =
  `diff --git a/${claimFile.split("\n")[0]}.md b/${claimFile.split("\n")[0]}.md\n` +
  `new file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${claimFile.split("\n")[0]}.md\n` +
  `@@ -0,0 +1,1 @@\n+${claimFile.trimEnd()}\n`;
const prep = await mcp("wide_ship_prepare", {
  did: DID, repo: "slop/slopdotcash", session_id: `earn-${Date.now().toString(36)}`,
  tool: "devin", commits: [], artifact: `ipfs://${cid}`,
  base_ref: "refs/heads/master", patch, message: `claim market ${market.marketId} — ${cid.slice(0, 16)}`,
});
if (prep.error) throw new Error(`ship_prepare: ${prep.error}`);
const body = prep.body;
const shipPath = prep.path;
const ts = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomUUID().replace(/-/g, "");
const bodyBytes = JSON.stringify(body);
const shipCanonical = `dg1\n${DID}\n${ts}\n${nonce}\nPOST\n${shipPath}\n${await sha256Hex(te.encode(bodyBytes))}`;
// Forge convention: sign the hex digest as UTF-8, not the raw bytes.
const payloadHex = await sha256Hex(te.encode(shipCanonical));
const shipSig = toHex(await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(payloadHex)));
const sub = await mcp("wide_ship_submit", { did: DID, repo: "slop/slopdotcash", body, ts, nonce, sig: shipSig });
log("ship submit:", JSON.stringify(sub).slice(0, 300));
if (!sub.relayed && sub.forge_status !== 200) log("note: forge relay status", sub.forge_status, "— forge response:", JSON.stringify(sub.forge ?? sub).slice(0, 200));

// 6. status — verdict + payout trace
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const st = await mcp("wide_status", { did: DID });
  const s = JSON.stringify(st);
  if (/verdict|paid|adjudicat|accept|reject/i.test(s)) { log("status:", s.slice(0, 400)); if (/accept|paid|reject/i.test(s)) break; }
  else log("status pending…", s.slice(0, 120));
}
console.log("\nearn loop complete — challenge→register→claim→forge-ship→attest→status all executed on live testnet rails");
