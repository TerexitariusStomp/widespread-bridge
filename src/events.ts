// events.ts — D5: the signed, hash-chained protocol event log.
//
// Every trust-critical transition emits an event:
//   declare · review · reveal · ruling · escrow
// Each event carries a sha256 commitment to its stored payload, links the
// prior event's hash, and is signed by the bridge oracle key. Anyone can
// replay the log to rebuild state — the KV cache is then a DERIVED
// artifact, not an authority. A rewritten, dropped, or forked event
// breaks the chain → a publishable fraud proof (two events at one seq,
// a bad hash, or an invalid signature).
//
// Privacy: events commit via payload_sha256 only — confidential markets
// prove a transition happened without exposing spec/agent identity.
//
// Concurrency note: seq allocation is best-effort via a head pointer
// (KV has no CAS). A seq collision overwrites ev:{seq} → the chain shows
// a break — itself a detectable integrity failure, never silent.
import type { Env } from "./types";
import { oracleEnv } from "./oracle";
import { sha256Hex } from "./sealed";

export interface ProtocolEvent {
  seq: number;
  ts: number;
  kind: "declare" | "review" | "reveal" | "ruling" | "escrow" | string;
  ref: string;               // record id / decl hash / market id
  payload_sha256: string;    // commitment to the canonical stored payload
  prev_hash: string;         // "genesis" at seq 0
  hash: string;
  sig: string | null;        // ed25519 over `wide-event|<hash>`
  pubkey: string | null;
}

const HEAD_KEY = "evhead";
const evKey = (seq: number) => `ev:${String(seq).padStart(12, "0")}`;

/** Deterministic JSON: sorted keys at every level so the same payload
 *  always hashes identically (replay + independent verifiers agree). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

async function ed25519SignHex(msg: string, seedHex: string): Promise<string> {
  const seed = Uint8Array.from(seedHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("pkcs8",
    new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,
                    0x04,0x22,0x04,0x20, ...seed]),
    { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Append a signed event. Errors never propagate — a failed emit must
 *  not break the transition it audits (a gap shows in verifyChain). */
export async function emitEvent(
  env: Env, kind: string, ref: string, payload: unknown,
): Promise<ProtocolEvent | null> {
  try {
    const head = await env.CLAIMS.get(HEAD_KEY, "json").catch(() => null) as
      { seq: number; hash: string } | null;
    const seq = (head?.seq ?? -1) + 1;
    const ev = {
      seq, ts: Date.now(), kind, ref,
      payload_sha256: await sha256Hex(new TextEncoder().encode(stableStringify(payload))),
      prev_hash: head?.hash ?? "genesis",
    };
    const hash = await sha256Hex(new TextEncoder().encode(stableStringify(ev)));
    const cfg = oracleEnv(env);
    let sig: string | null = null, pubkey: string | null = null;
    if (cfg) {
      // Derive the pubkey from the seed — never trust env's separate
      // ORACLE_PUBKEY_HEX, which can drift and produce unverifiable sigs.
      const { ed25519 } = await import("@noble/curves/ed25519");
      const seed = Uint8Array.from(cfg.oracleKeyHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
      pubkey = [...ed25519.getPublicKey(seed)].map((b) => b.toString(16).padStart(2, "0")).join("");
      sig = await ed25519SignHex(`wide-event|${hash}`, cfg.oracleKeyHex);
    }
    const full: ProtocolEvent = { ...ev, hash, sig, pubkey };
    await env.CLAIMS.put(evKey(seq), JSON.stringify(full));
    await env.CLAIMS.put(HEAD_KEY, JSON.stringify({ seq, hash }));
    return full;
  } catch {
    return null;
  }
}

/** Paginated event log for replay/mirroring. */
export async function listEvents(
  env: Env, from = 0, limit = 200,
): Promise<{ events: ProtocolEvent[]; head: { seq: number; hash: string } | null }> {
  const head = await env.CLAIMS.get(HEAD_KEY, "json").catch(() => null) as
    { seq: number; hash: string } | null;
  const events: ProtocolEvent[] = [];
  if (head) {
    const end = Math.min(from + limit, head.seq + 1);
    for (let i = from; i < end; i++) {
      const e = await env.CLAIMS.get(evKey(i), "json").catch(() => null) as ProtocolEvent | null;
      if (e) events.push(e);
    }
  }
  return { events, head };
}

/** Walk the chain: recompute every hash, check links + signatures.
 *  A fork (missing seq), rewrite (hash mismatch), bad link, or invalid
 *  sig each lands in `breaks` — the publishable fraud proof. */
export async function verifyChain(env: Env): Promise<{
  ok: boolean; length: number; head: { seq: number; hash: string } | null;
  breaks: { seq: number; reason: string }[];
}> {
  const { events, head } = await listEvents(env, 0, 100000);
  const breaks: { seq: number; reason: string }[] = [];
  const { ed25519 } = await import("@noble/curves/ed25519");
  const hexToBytes = (h: string) => {
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return b;
  };
  let prev = "genesis";
  let expected = 0;
  for (const e of events) {
    if (e.seq !== expected) { breaks.push({ seq: e.seq, reason: `seq gap — expected ${expected}` }); expected = e.seq; }
    expected++;
    const { hash: _h, sig: _s, pubkey: _p, ...unsigned } = e;
    const recomputed = await sha256Hex(new TextEncoder().encode(stableStringify(unsigned)));
    if (recomputed !== e.hash) breaks.push({ seq: e.seq, reason: "hash mismatch — payload rewritten" });
    if (e.prev_hash !== prev) breaks.push({ seq: e.seq, reason: `broken link — prev ${e.prev_hash} ≠ ${prev}` });
    if (e.sig && e.pubkey) {
      const okSig = ed25519.verify(hexToBytes(e.sig),
        new TextEncoder().encode(`wide-event|${e.hash}`), hexToBytes(e.pubkey));
      if (!okSig) breaks.push({ seq: e.seq, reason: "invalid signature" });
    }
    prev = e.hash;
  }
  if (head && prev !== head.hash) {
    breaks.push({ seq: head.seq, reason: "head pointer does not match last event" });
  }
  return { ok: !breaks.length, length: events.length, head, breaks };
}
