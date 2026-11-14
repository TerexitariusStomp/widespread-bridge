import { describe, expect, it } from "vitest";
import { entryHash, deltagit } from "../src/forges/deltagit";
import type { OpLogEntry as _OpLogEntry } from "../src/types";
const verifyChain = (entries: _OpLogEntry[]) => deltagit.verifyChain(entries);
const findShipEntry = (entries: _OpLogEntry[], seq: number) => entries.find((e) => e.seq === seq);
import type { Env, OpLogEntry } from "../src/types";

const mk = (seq: number, payload: Record<string, unknown>): OpLogEntry => ({
  seq,
  hash: "",
  prev_hash: "",
  kind: "ship",
  actor: "did:key:z6Mktest",
  payload,
  created_at: 1793300000000 + seq,
});

describe("entryHash", () => {
  it("replays the forge's canonical form — sha256(prevHash + JSON.stringify(entry-minus-hashes))", async () => {
    const entry = mk(0, { ship: true, commits: ["a".repeat(40)] });
    const h = await entryHash(entry, "genesis");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // same input → same hash (deterministic canonicalization)
    expect(await entryHash(entry, "genesis")).toBe(h);
    // different prevHash → different hash (chain linkage)
    expect(await entryHash(entry, "other")).not.toBe(h);
  });
});

describe("verifyChain", () => {
  it("validates a fabricated two-entry chain end to end", async () => {
    const e0 = mk(0, { ship: true, commits: ["a".repeat(40)] });
    e0.prev_hash = "genesis";
    e0.hash = await entryHash(e0, "genesis");
    const e1 = mk(1, { ship: true, commits: ["b".repeat(40)] });
    e1.prev_hash = e0.hash;
    e1.hash = await entryHash(e1, e0.hash);
    const res = await verifyChain([e0, e1]);
    expect(res.valid).toBe(true);
    expect(res.checked).toBe(2);
    expect(res.tip_hash).toBe(e1.hash);
  });

  it("fails closed on a tampered link", async () => {
    const e0 = mk(0, { ship: true, commits: ["a".repeat(40)] });
    e0.prev_hash = "genesis";
    e0.hash = await entryHash(e0, "genesis");
    const e1 = mk(1, { ship: true });
    e1.prev_hash = "deadbeef"; // forged link
    e1.hash = await entryHash(e1, "deadbeef");
    const res = await verifyChain([e0, e1]);
    expect(res.valid).toBe(false);
  });
});

describe("findShipEntry", () => {
  it("locates the entry by seq and misses others", () => {
    const e = mk(0, { ship: true });
    expect(findShipEntry([e], 0)).toBe(e);
    expect(findShipEntry([e], 1)).toBeUndefined();
  });
});
