#!/usr/bin/env node
// Mint the bridge's own forge identity for the receipt write-back lane.
// Prints the values to feed `wrangler secret put DG_AGENT_DID` and
// `wrangler secret put DG_AGENT_KEY_PKCS8_B64`.
//
//   node scripts/gen-agent-key.mjs [https://code.widespread.fyi]

const HOST = (process.argv[2] ?? "https://code.widespread.fyi").replace(/\/$/, "");
const toHex = (b) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const b64 = (buf) => Buffer.from(buf).toString("base64");

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubkeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

const res = await fetch(`${HOST}/api/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: pubkeyHex, label: "widespread-bridge" }),
});
if (!res.ok) throw new Error(`register: ${res.status} ${await res.text()}`);
const { did } = await res.json();

console.log(`registered ${did} on ${HOST}\n`);
console.log(`wrangler secret put DG_AGENT_DID            # ${did}`);
console.log(`wrangler secret put DG_AGENT_KEY_PKCS8_B64  # ${b64(pkcs8)}`);
