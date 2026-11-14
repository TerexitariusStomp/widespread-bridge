// events.test.ts — D5 signed hash-chained event log: emits link into a
// verifiable chain, rewrites/forks/gaps are publishable fraud proofs.
import { describe, it, expect } from "vitest";
import { emitEvent, listEvents, verifyChain, stableStringify } from "../src/events";
import { fakeEnv, fakeKV } from "./mock";
import type { Env } from "../src/types";

const env = () => fakeEnv({
  CLAIMS: fakeKV(),
  NEAR_CONTRACT: "mkt.testnet",
  ORACLE_SEED_HEX: "cd".repeat(32),
  ORACLE_PUBKEY_HEX: "ab".repeat(32),
} as Partial<Env>);

describe("D5 event log", () => {
  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3] } }))
      .toBe(stableStringify({ a: { c: [3], d: 2 }, b: 1 }));
  });

  it("emits signed, hash-linked events; verifyChain passes", async () => {
    const e = env();
    const e1 = await emitEvent(e, "declare", "decl:aaa", { spec: "public task" });
    const e2 = await emitEvent(e, "review", "claim:x:1", { status: "accepted_paid" });
    const e3 = await emitEvent(e, "reveal", "decl:aaa", { agent: "hidden-ok-hashes" });
    expect(e1!.seq).toBe(0);
    expect(e1!.prev_hash).toBe("genesis");
    expect(e2!.prev_hash).toBe(e1!.hash);
    expect(e3!.prev_hash).toBe(e2!.hash);
    expect(e1!.sig).toBeTruthy();                       // oracle-signed
    const v = await verifyChain(e);
    expect(v.ok).toBe(true);
    expect(v.length).toBe(3);
    expect(v.head!.hash).toBe(e3!.hash);
  });

  it("a rewritten event is a fraud proof — hash mismatch detected", async () => {
    const e = env();
    await emitEvent(e, "declare", "decl:aaa", { spec: "original" });
    await emitEvent(e, "review", "claim:x:1", { status: "accepted_paid" });
    const kv = e.CLAIMS as unknown as { store: Map<string, string> };
    const { events } = await listEvents(e, 0, 10);
    const tampered = { ...events[0], kind: "escrow" };  // silently rewrite
    await kv.put(`ev:${String(0).padStart(12, "0")}`, JSON.stringify(tampered));
    const v = await verifyChain(e);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => b.reason).join()).toMatch(/hash mismatch/);
  });

  it("a dropped event breaks the link — visible, never silent", async () => {
    const e = env();
    await emitEvent(e, "declare", "decl:a", {});
    await emitEvent(e, "review", "claim:x:1", {});
    await emitEvent(e, "ruling", "7:3", {});
    const kv = e.CLAIMS as unknown as { store: Map<string, string> };
    await kv.delete(`ev:${String(1).padStart(12, "0")}`);
    const v = await verifyChain(e);
    // seq gap detected (list skips missing keys)
    expect(v.ok).toBe(false);
    expect(v.breaks.length).toBeGreaterThan(0);
  });

  it("no oracle key → unsigned events still chain-verifiable", async () => {
    const e = fakeEnv({ CLAIMS: fakeKV() });
    const ev = await emitEvent(e, "declare", "decl:a", { x: 1 });
    expect(ev!.sig).toBeNull();
    const v = await verifyChain(e);
    expect(v.ok).toBe(true);              // hash chain alone still detects tampering
  });
});
