// oracle-runner — an independent Widespread oracle seat.
//
// Anyone can run this: you get a NEAR account, an oracle pubkey, an
// LLM endpoint (OpenAI-compatible — NEAR AI Cloud gives TEE attested
// inference), and this process does the rest:
//
//   node run.mjs register   → registerOracle from YOUR account (you own
//                             the seat — on-chain votes require it)
//   node run.mjs run        → poll markets, adjudicate pending attested
//                             claims, submitVerdict + release at quorum
//   node run.mjs once       → one scan cycle, for cron
//
// spec_sealed markets: the funder seals a spec copy to YOUR x25519 key
// (declared in adjudicator_x25519_pubkeys); you fetch it from the
// public declaration record (sealed box — safe to publish), decrypt
// locally, and judge the worker's deliverable copy the same way.
// The bridge never sees plaintext you hold — real independence.
//
// Env (all required unless noted):
//   ORACLE_ACCOUNT       your account id (votes must come from it)
//   ORACLE_SECRET_KEY    its ed25519 key (near format or raw seed hex)
//   ORACLE_PUBKEY_HEX    64-hex pubkey you registered under (any value;
//                        it's just your seat's id — sign votes with ORACLE_SEED_HEX)
//   ORACLE_SEED_HEX      64-hex ed25519 seed for off-chain verdict sigs
//   ORACLE_X25519_SECRET 64-hex x25519 secret for sealed spec/deliverable copies
//   NEAR_CONTRACT        market contract account
//   NEAR_RPC_URL         default https://rpc.testnet.fastnear.com
//   BRIDGE_URL           default https://widespread-bridge.widespread.workers.dev
//   JUDGE_API            OpenAI-compatible base (default https://cloud-api.near.ai/v1)
//   JUDGE_KEY            API key for the judge endpoint
//   JUDGE_MODELS         comma-separated model ids — panel majority (default single)
//   POLL_S               scan interval seconds (default 300)
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { cryptoBoxSealOpen } from "@serenity-kit/noble-sodium";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const env = process.env;
const RPC = env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const BRIDGE = env.BRIDGE_URL ?? "https://widespread-bridge.widespread.workers.dev";
const CONTRACT = env.NEAR_CONTRACT;
const POLL = Number(env.POLL_S ?? 300) * 1000;
const GAS = BigInt("100000000000000");
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/.{2}/g).map((x) => parseInt(x, 16)));

function need(k) { if (!env[k]) { console.error(`missing env ${k}`); process.exit(1); } return env[k]; }

function nearKeyPair() {
  const sk = need("ORACLE_SECRET_KEY");
  if (!sk.startsWith("ed25519:")) {
    console.error("ORACLE_SECRET_KEY must be near-cli format: ed25519:<base58>");
    process.exit(1);
  }
  return KeyPair.fromString(sk);
}

const account = new Account(need("ORACLE_ACCOUNT"), RPC, new KeyPairSigner(nearKeyPair()));

// ---------- chain io ----------
const call = (method, args, deposit = 0n) =>
  account.callFunction({ contractId: CONTRACT, methodName: method, args, gas: GAS, deposit });
async function view(method, args = {}) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "o", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) }).then((x) => x.json());
  const b = r.result?.result;
  return b ? JSON.parse(Buffer.from(b).toString()) : null;
}
// Vote rails: plain markets vote openly via submitVerdict; commitReveal
// markets go blind — commitVerdict posts sha256(marketId|claimId|verdict|
// conf|salt|oraclePubkey) and revealVerdict opens it once quorum-many
// jurors are committed. conf (0-100) is the judge's confidence — a
// unanimous high-conf quorum is auto-settleable on-chain.
const vote = async (marketId, claimId, verdict, conf, verdictSig, blind) => {
  const pk = env.ORACLE_PUBKEY_HEX;
  const args = { marketId: String(marketId), claimId: String(claimId),
    verdict, conf, oraclePubkey: pk, verdictSig };
  if (!blind) return call("submitVerdict", args);
  // Deterministic salt from the seat secret — stable across cycles so a
  // crash mid-commit doesn't strand the preimage, blind to everyone else.
  const salt = createHash("sha256")
    .update(`${env.ORACLE_SEED_HEX ?? ""}|${marketId}|${claimId}|${verdict}|${conf}`)
    .digest("hex").slice(0, 32);
  const commit = createHash("sha256")
    .update(`${marketId}|${claimId}|${verdict}|${conf}|${salt}|${pk}`).digest("hex");
  const m = await view("getMarket", { marketId: String(marketId) });
  if (m?.commits?.[pk] !== commit) {
    await call("commitVerdict", { marketId: String(marketId), oraclePubkey: pk, commit });
  }
  const commits = Object.keys(m?.commits ?? {}).length + (m?.commits?.[pk] === commit ? 0 : 1);
  if (commits < (m?.oracleQuorumM ?? 1)) return { deferred: `awaiting commit quorum (${commits} in)` };
  return call("revealVerdict", { ...args, salt });
};
const release = async (marketId, winningClaimId) =>
  call("release", { marketId: String(marketId), winningClaimId: String(winningClaimId) });

// ---------- sealed copies ----------
function openMyCopy(b64) {
  const secret = fromHex(env.ORACLE_X25519_SECRET ?? "");
  const pub = x25519.getPublicKey(secret);
  try {
    const pt = cryptoBoxSealOpen({ ciphertext: Uint8Array.from(Buffer.from(b64, "base64")),
      publicKey: pub, privateKey: secret });
    return pt ? new TextDecoder().decode(pt) : null;
  } catch { return null; }
}
const sha256 = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");

// ---------- judge: competitive contest over ALL pending claims ----------
const SYSTEM = `You are an adjudicator in a verified-work market. You are shown the
spec and several candidate deliverables labeled C1, C2, … — the order is
random per judge and carries no signal. Weigh every candidate on substance,
completeness, and spec-fit, then pick the SINGLE best deliverable the escrow
should pay, or "none" if no candidate is acceptable. Reply ONLY JSON:
{"winner":"C1"|"C2"|…|"none","reasoning":"<2-3 sentences>","confidence":0..1}`;

// Per-seat deterministic shuffle: every model sees candidates in a
// different order — submission order can't create shared position bias.
function seatShuffle(items, seed) {
  const a = [...items];
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** One contest per market: every judge model scores all candidates at
 * once and picks the best (or "none"). Plurality pick wins; a "none"
 * majority means the juror abstains entirely — no votes, the market
 * can't release without accept quorum anyway. */
async function contest(spec, candidates, marketMeta) {
  const api = env.JUDGE_API ?? "https://cloud-api.near.ai/v1";
  const models = (env.JUDGE_MODELS ?? "").split(",").filter(Boolean);
  if (!models.length || !env.JUDGE_KEY) {
    console.log("  no judge configured — set JUDGE_API/JUDGE_KEY/JUDGE_MODELS");
    return null;
  }
  const picks = [];
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const order = seatShuffle(candidates.map((_, k) => k), i + 1);
    try {
      const prompt = JSON.stringify({
        spec, market: marketMeta,
        candidates: order.map((idx, k) => ({
          id: `C${k + 1}`, claimHash: candidates[idx].claim.claimHash,
          deliverable: candidates[idx].deliverable,
        })),
      });
      const r = await fetch(`${api}/chat/completions`, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.JUDGE_KEY}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 400,
          messages: [{ role: "system", content: SYSTEM },
            { role: "user", content: prompt }] }) });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content ?? "";
      const v = JSON.parse(text.replace(/```json|```/g, "").trim());
      const m = /^C(\d+)$/i.exec(String(v.winner ?? "").trim());
      picks.push({ model, winnerIndex: m ? order[+m[1] - 1] : -1,
        confidence: v.confidence ?? 0.5, reasoning: v.reasoning ?? "" });
    } catch (e) { console.log(`  judge ${model} failed: ${String(e).slice(0, 80)}`); }
  }
  const tally = new Map();
  let noneVotes = 0;
  for (const p of picks) {
    if (p.winnerIndex < 0) noneVotes++;
    else tally.set(p.winnerIndex, (tally.get(p.winnerIndex) ?? 0) + 1);
  }
  let winnerIndex = -1, winnerVotes = 0;
  for (const [idx, n] of tally) if (n > winnerVotes) { winnerIndex = idx; winnerVotes = n; }
  const conf = picks.reduce((s, p) => s + p.confidence, 0) / (picks.length || 1);
  return { winnerIndex: winnerVotes > noneVotes ? winnerIndex : -1,
           winnerVotes, noneVotes, confidence: conf, panel: picks };
}

// ---------- spec + deliverable resolution ----------
// Caches: specs/deliverables are immutable once hash-verified — no reason
// to re-fetch + re-decrypt the same bytes every poll cycle.
const specCache = new Map();
const delivCache = new Map();

async function specFor(market) {
  const spec = market.spec ?? "";
  if (!spec.startsWith("[confidential:")) return { spec };
  const declHash = spec.match(/decl=([0-9a-f]+)/)?.[1];
  if (!declHash) return { error: "confidential market without decl hash" };
  const hit = specCache.get(`${market.marketId}:${declHash}`);
  if (hit) return hit;
  const decl = await fetch(`${BRIDGE}/api/declarations/${declHash}`).then((r) => r.json()).catch(() => null);
  const mine = decl?.bounty?.spec_sealed_adjudicators_b64?.[env.ORACLE_X25519_PUBKEY ?? ""]
    ?? decl?.bounty?.spec_sealed_adjudicators_b64?.[myX25519Pub()];
  if (!mine) return { error: "no spec copy sealed to this operator's x25519 key" };
  const pt = openMyCopy(mine);
  if (!pt) return { error: "spec copy did not decrypt" };
  if (decl.bounty?.spec_hash && sha256(pt) !== decl.bounty.spec_hash) {
    return { error: "spec copy does not match spec_hash — funder bait" };
  }
  const res = { spec: pt, declHash };
  specCache.set(`${market.marketId}:${declHash}`, res);
  return res;
}
function myX25519Pub() {
  if (!env.ORACLE_X25519_SECRET) return null;
  return toHex(x25519.getPublicKey(fromHex(env.ORACLE_X25519_SECRET)));
}
function deliverableFor(claim) {
  const key = `${claim.marketId}:${claim.claimId}`;
  const hit = delivCache.get(key);
  if (hit) return hit;
  const ev = claim.evidence ?? {};
  const sealed = ev.artifact_sealed;
  if (!sealed) return { deliverable: claim.claimHash };   // public market — hash stands in
  const mine = sealed.ciphertext_adjudicators_b64?.[myX25519Pub()]
    ?? sealed.ciphertext_bridge_b64;                       // legacy: if we somehow hold bridge key
  if (!mine) return { error: "no deliverable copy for this operator" };
  const pt = openMyCopy(mine);
  if (!pt) return { error: "deliverable copy did not decrypt" };
  if (sealed.artifact_sha256 && sha256(pt) !== sealed.artifact_sha256) {
    return { error: "deliverable hash mismatch" };
  }
  const res = { deliverable: pt };
  delivCache.set(key, res);
  return res;
}

// Per-seat claim order: every juror walks pending claims in a different
// deterministic order (seeded by seat pubkey + market), so submission
// order can't create a shared position bias across the jury while a
// given operator's re-runs stay stable.
function seatOrder(pending, seed) {
  const a = [...pending];
  let h = 2166136261 >>> 0;
  for (const ch of seed) h = (((h ^ ch.charCodeAt(0)) * 16777619) >>> 0);
  for (let i = a.length - 1; i > 0; i--) {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- scan cycle ----------
// Returns the number of markets the seat did real work on — feeds the
// poll loop's exponential backoff so idle seats don't spin.
async function scan() {
  let worked = 0;
  const markets = await view("listOpen") ?? [];
  const me = env.ORACLE_PUBKEY_HEX;
  for (const m of markets) {
    if (m.oracleAllowlist && !m.oracleAllowlist.includes(me)) continue;      // not our jury
    const open = (m.disputes ? Object.values(m.disputes) : []).some((d) => d.status === "open");
    if (open) { console.log(`market ${m.marketId}: frozen by dispute — skip`); continue; }
    const { spec, error: sErr } = await specFor(m);
    if (sErr) { console.log(`market ${m.marketId}: ${sErr} — skip`); continue; }
    const page = await view("getClaims", { marketId: m.marketId, from: 0, limit: 100 });
    const pending = (page?.claims ?? []).filter((c) => c.status === "pending" && c.attested);
    if (!pending.length) continue;
    worked++;
    const verdicts = await view("getVerdicts", { marketId: m.marketId }).catch(() => null);
    const mine = verdicts?.votes?.[me];
    // Already voted: still attempt release on accepts — quorum may
    // have formed via other jurors since our vote.
    if (mine?.verdict === "accept") {
      try { await release(m.marketId, mine.claimId);
        console.log(`  RELEASED ${m.marketId} → (post-quorum claim ${mine.claimId})`);
      } catch { /* still short of quorum — fine */ }
      continue;                                        // our call is cast
    }
    // Competitive adjudication: all unvoted claims go to the panel at
    // once — the jury picks the single best deliverable, matching
    // on-chain winner-selection semantics. Claims we've already
    // rejected stay out of the ballot.
    const candidates = [];
    for (const claim of pending) {
      if (mine?.claimId === claim.claimId) continue;
      const { deliverable, error: dErr } = deliverableFor(claim);
      if (dErr) { console.log(`  ${m.marketId}/${claim.claimId}: ${dErr}`); continue; }
      candidates.push({ claim, deliverable });
    }
    if (!candidates.length) continue;
    const j = await contest(spec, candidates, { marketId: m.marketId, rule: m.acceptanceRule });
    if (!j) continue;
    if (j.winnerIndex < 0) {
      console.log(`  ${m.marketId}: panel ${j.noneVotes}/${j.panel?.length ?? 0} said none — abstain`);
      continue;
    }
    const winner = candidates[j.winnerIndex].claim;
    console.log(`  ${m.marketId}/${winner.claimId}: winner ${j.winnerVotes}/${j.panel?.length ?? 0} picks`);
    // Same canonical the bridge oracle signs: wide-verdict|marketId|claimHash|verdict|deadline
    const sig = toHex(ed25519.sign(
      new TextEncoder().encode(`wide-verdict|${m.marketId}|${winner.claimHash}|accept|${m.deadline ?? ""}`),
      fromHex(env.ORACLE_SEED_HEX)));
    const conf = Math.round(Math.max(0, Math.min(1, j.confidence ?? 0)) * 100);
    try {
      const r = await vote(m.marketId, winner.claimId, "accept", conf, sig, m.commitReveal === true);
      if (r?.deferred) { console.log(`  ${r.deferred} — reveal next cycle`); continue; }
    } catch (e) { console.log(`  vote failed: ${String(e).slice(0, 120)}`); continue; }
    // Release attempt on every accept — the CONTRACT asserts quorum
    // itself, so a premature release just reverts (read-after-write
    // finality can hide fresh votes; never trust our own tally read).
    try {
      const r = await release(m.marketId, winner.claimId);
      console.log(`  RELEASED ${m.marketId} → ${r?.paid ?? winner.claimant}`);
    } catch (e) {
      const msg = String(e);
      if (!/quorum|consensus|accept/i.test(msg)) {
        console.log(`  release failed: ${msg.slice(0, 120)}`);
      } else {
        console.log(`  awaiting quorum on ${m.marketId}/${winner.claimId}`);
      }
    }
  }
  return worked;
}

// ---------- commands ----------
const cmd = process.argv[2];
if (cmd === "register") {
  need("ORACLE_PUBKEY_HEX");
  await call("registerOracle", { pubkey: env.ORACLE_PUBKEY_HEX });
  console.log(`registered oracle ${env.ORACLE_PUBKEY_HEX.slice(0, 12)}… owner=${account.accountId}`);
} else if (cmd === "run") {
  console.log(`oracle-runner: ${account.accountId} scanning ${CONTRACT} every ${POLL / 1000}s (backs off to ${POLL * 10 / 1000}s when idle)`);
  let idleStreak = 0;
  for (;;) {
    const worked = await scan().catch((e) => { console.log("scan error:", String(e).slice(0, 160)); return 1; });
    idleStreak = worked > 0 ? 0 : idleStreak + 1;
    const wait = POLL * Math.min(10, 2 ** Math.min(idleStreak, 4));
    if (idleStreak === 1) console.log(`  idle — backing off (${wait / 1000}s next)`);
    await new Promise((r) => setTimeout(r, wait));
  }
} else if (cmd === "once") {
  await scan();
} else {
  console.log("usage: node run.mjs [register|run|once]");
}
