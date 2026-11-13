#!/usr/bin/env node
// Land a REAL ship claim on the live delta-git forge — no stored credentials:
// an ephemeral Ed25519 agent registers itself, then POSTs /dg/ship with the
// signed x-dg-* envelope the forge verifies. For remote-backed repos the
// forge verifies the patch signature; commits still recorded when provided.
//
//   node scripts/ship-claim.mjs --repo slop/protocol \
//     --commits ec8f99d477e2c7846b8a33c234ca9451ee464866 \
//     [--session demo-1] [--tool devin] [--host https://code.widespread.fyi]

const args = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

const HOST = getOpt("host", "https://code.widespread.fyi").replace(/\/$/, "");
const REPO = getOpt("repo", "slop/protocol");
const COMMITS = getOpt("commits", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SESSION = getOpt("session", `slopcash-demo-${Date.now().toString(36)}`);
const TOOL = getOpt("tool", "devin");

if (COMMITS.some((c) => !/^[0-9a-f]{40}$/i.test(c))) {
  console.error("--commits must be 40-hex sha values");
  process.exit(1);
}

const te = new TextEncoder();
const toHex = (b) =>
  [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const sha256Hex = async (d) => toHex(await crypto.subtle.digest("SHA-256", d));

// 1. Register an ephemeral agent identity.
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pubkeyHex = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
const reg = await fetch(`${HOST}/api/agents`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ pubkey: pubkeyHex, label: `slopcash-${SESSION}` }),
});
if (!reg.ok) throw new Error(`register: ${reg.status} ${await reg.text()}`);
const { did } = await reg.json();
console.log(`agent  ${did}`);

// 2. Signed-envelope POST to /dg/ship.
const path = `/api/${REPO}/dg/patch`;
const PATCH = getOpt("patch") ?? `diff --git a/widespread-claim.txt b/widespread-claim.txt\nnew file mode 100644\n--- /dev/null\n+++ b/widespread-claim.txt\n@@ -0,0 +1,2 @@\n+session: ${SESSION}\n+tool: ${TOOL}\n`;
const body = { session_id: SESSION, tool: TOOL, patch: PATCH, message: `ship claim ${SESSION}`,
  base_ref: getOpt("branch", "master") };
const bodyBytes = te.encode(JSON.stringify(body));
const ts = String(Math.floor(Date.now() / 1000));
const nonce = crypto.randomUUID().replace(/-/g, "");
const payload = await sha256Hex(
  te.encode(`dg1\n${did}\n${ts}\n${nonce}\nPOST\n${path}\n${await sha256Hex(bodyBytes)}`)
);
const sig = toHex(await crypto.subtle.sign("Ed25519", pair.privateKey, te.encode(payload)));
const res = await fetch(`${HOST}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-dg-did": did,
    "x-dg-ts": ts,
    "x-dg-nonce": nonce,
    "x-dg-sig": sig,
  },
  body: bodyBytes,
});
const out = await res.json();
console.log(`ship   HTTP ${res.status}`, JSON.stringify(out));

if (out.op_seq !== null && out.op_seq !== undefined) {
  console.log(`\nop-log  ${HOST}/api/${REPO}/dg/oplog   (seq ${out.op_seq})`);
  console.log(`review  POST <bridge>/review {"repo":"${REPO}","seq":${out.op_seq}}`);
}
