// rebuild.mjs — independent state rebuild + integrity audit.
//
// Replays the signed event log against a bridge's PUBLIC endpoints:
//   1. verify the chain — recompute hashes, links, ed25519 sigs
//   2. rebuild the state index — resolve each event's ref to the public
//      record it commits to
//   3. reconcile — a record the log commits to but the bridge won't
//      serve is censorship; a hash that changed is rewrite evidence
//
// Run against ANY deployment — this is the self-hostable mirror path:
//   node tools/rebuild.mjs [bridge_url] [--json]
// Default: production worker.
const BASE = process.argv[2] && !process.argv[2].startsWith("-")
  ? process.argv[2].replace(/\/$/, "")
  : "https://widespread-bridge.widespread.workers.dev";
const JSON_OUT = process.argv.includes("--json");

const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s) =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const stable = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;

async function get(path) {
  const r = await fetch(`${BASE}${path}`).catch(() => null);
  return r?.ok ? r.json() : null;
}

// --- 1. pull + verify the chain --------------------------------------
const events = [];
for (let from = 0; ; from += 200) {
  const page = await get(`/api/events?from=${from}&limit=200`);
  if (!page?.events?.length) break;
  events.push(...page.events);
  if (events.length >= (page.head?.seq ?? -1) + 1) break;
}
const breaks = [];
let prev = "genesis";
const seen = new Set();
for (const e of events) {
  if (seen.has(e.seq)) { breaks.push({ seq: e.seq, reason: "duplicate seq — fork evidence" }); continue; }
  seen.add(e.seq);
  const { hash, sig, pubkey, ...unsigned } = e;
  if (await sha256Hex(stable(unsigned)) !== hash) breaks.push({ seq: e.seq, reason: "hash mismatch — rewritten event" });
  if (e.prev_hash !== prev) breaks.push({ seq: e.seq, reason: `broken link — prev ${e.prev_hash} ≠ ${prev}` });
  if (sig && pubkey) {
    const sigB = Uint8Array.from(sig.match(/.{2}/g).map((x) => parseInt(x, 16)));
    const pubB = Uint8Array.from(pubkey.match(/.{2}/g).map((x) => parseInt(x, 16)));
    const ok = await crypto.subtle.verify({ name: "Ed25519" },
      await crypto.subtle.importKey("raw", pubB, { name: "Ed25519" }, false, ["verify"]),
      sigB, new TextEncoder().encode(`wide-event|${hash}`)).catch(() => false);
    if (!ok) breaks.push({ seq: e.seq, reason: "invalid signature" });
  }
  prev = hash;
}
const headEv = events[events.length - 1];
const headApi = await get("/api/events/head");
const headMismatch = headApi?.hash && headEv && headApi.hash !== headEv.hash
  ? { expected: headEv.hash, served: headApi.hash } : null;

// --- 2. rebuild the state index --------------------------------------
// Event refs → the public record each commits to. Resolution misses are
// censorship candidates — the signed log says a transition happened.
const rebuilt = { declares: [], reviews: [], reveals: [], rulings: [], escrows: [], missing: [] };
for (const e of events) {
  const entry = { seq: e.seq, ts: e.ts, ref: e.ref, payload_sha256: e.payload_sha256 };
  if (e.kind === "declare") {
    const hash = e.ref.replace(/^decl:/, "");
    const decl = await get(`/api/declarations/${hash}`);
    if (decl?.bounty) rebuilt.declares.push({ ...entry, hash, domain: decl.bounty.domain, amount: decl.bounty.amount, sealed: !!decl.bounty.spec_sealed });
    else rebuilt.missing.push({ ...entry, kind: "declare" });
  } else if (e.kind === "review") {
    // reviews aren't individually public — the commitment stands;
    // the record id is the ref to check in a self-hosted mirror.
    rebuilt.reviews.push(entry);
  } else if (e.kind === "reveal") {
    rebuilt.reveals.push(entry);
  } else if (e.kind === "ruling") {
    const [marketId] = e.ref.split(":");
    const docket = await get(`/api/disputes/${marketId}`);
    if (docket) rebuilt.rulings.push({ ...entry, marketId, docket });
    else rebuilt.missing.push({ ...entry, kind: "ruling" });
  } else if (e.kind === "escrow") {
    rebuilt.escrows.push(entry);
  }
}

const report = {
  bridge: BASE,
  chain: { length: events.length, head: headEv ? { seq: headEv.seq, hash: headEv.hash } : null,
           ok: !breaks.length && !headMismatch, breaks, head_mismatch: headMismatch },
  rebuilt: {
    declares: rebuilt.declares.length, reviews: rebuilt.reviews.length,
    reveals: rebuilt.reveals.length, rulings: rebuilt.rulings.length,
    escrows: rebuilt.escrows.length, missing: rebuilt.missing.length,
  },
  missing: rebuilt.missing,
};

if (JSON_OUT) console.log(JSON.stringify({ ...report, rebuilt_index: rebuilt }, null, 2));
else {
  console.log(`bridge:  ${BASE}`);
  console.log(`chain:   ${events.length} events — ${report.chain.ok ? "VERIFIED" : "BREAKS FOUND"}`);
  for (const b of breaks) console.log(`  break @${b.seq}: ${b.reason}`);
  if (headMismatch) console.log(`  head mismatch: served ${headMismatch.served} ≠ computed ${headMismatch.expected}`);
  console.log(`rebuilt: ${JSON.stringify(report.rebuilt)}`);
  for (const m of rebuilt.missing) console.log(`  missing: ${m.kind} ${m.ref} (seq ${m.seq}) — committed by the log, not served`);
}
process.exit(report.chain.ok && !rebuilt.missing.length ? 0 : 1);
