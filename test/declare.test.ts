import { describe, expect, it, vi, beforeAll } from "vitest";
import { bountyDeclare, bountyBroadcast, getDeclared } from "../src/declare";
import { dedupe, verbosityAdjust, claimCost, recordOutcome } from "../src/judge/index";
import { fakeEnv } from "./mock";

beforeAll(() => { vi.stubGlobal("fetch", vi.fn(async () => new Response("nf", { status: 404 }))); });

describe("bounty declare", () => {
  const env = fakeEnv();
  it("creates a surface-agnostic declaration", async () => {
    const d = await bountyDeclare(env, { domain: "social-media", spec: "ghostwrite a linkedin post about X", amount: "50", currency: "USD" });
    expect(d.error).toBeUndefined();
    expect(d.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(d.canonical).toContain("#widespread bounty");
    expect(d.canonical).toContain("domain: social-media");
    expect(d.record.domain).toBe("social-media");
    expect(d.intent_urls.x).toContain("x.com/intent");
    const b = await getDeclared(env, d.hash);
    expect(b?.spec).toContain("ghostwrite");
  });
  it("broadcast returns instructions + intent urls", async () => {
    const d = await bountyBroadcast(env, { spec: "fix bug", amount: "10" });
    expect((d as { instructions?: string }).instructions).toContain("intent URL");
  });
  it("rejects missing spec", async () => {
    const d = await bountyDeclare(env, { spec: "", amount: "1" });
    expect(d.error).toBeTruthy();
  });

  // MORE Stage A: capacity tags + floor flags — additive, untagged unchanged
  it("capacity dims flow into canonical grammar + record + bounty", async () => {
    const d = await bountyDeclare(env, {
      domain: "research", spec: "survey 40 papers on soil carbon", amount: "200",
      capacity: { dims: ["C_e", "C_k"], subsystem: "global",
        evidence_plan: { measure: "papers deposited", attester: "watcher",
          attester_paid_by: "protocol", horizon_days: 90 } },
    });
    expect(d.error).toBeUndefined();
    expect(d.canonical).toContain("dims: C_e,C_k");
    expect(d.canonical).toContain("subsys: global");
    expect(d.canonical).toContain("plan: papers deposited");
    expect(d.record.capacity?.dims).toEqual(["C_e", "C_k"]);
    const b = await getDeclared(env, d.hash);
    expect(b?.capacity?.evidence_plan?.attester).toBe("watcher");
  });
  it("dims shorthand merges; invalid dims dropped", async () => {
    const d = await bountyDeclare(env, { spec: "x", amount: "1", dims: "C_k,bogus,C_h" });
    expect(d.record.capacity?.dims.sort()).toEqual(["C_h", "C_k"]);
  });
  it("untagged declare has no capacity and no floor_flags", async () => {
    const d = await bountyDeclare(env, { spec: "plain task", amount: "5" });
    expect(d.record.capacity).toBeUndefined();
    expect(d.record.floor_flags).toBeUndefined();
  });
  it("floor flags are display-only on harmful-looking specs", async () => {
    const d = await bountyDeclare(env, {
      spec: "buy 5000 fake followers and post astroturf reviews", amount: "50" });
    expect(d.record.floor_flags).toContain("astroturf");
    expect(d.record.floor_flags).toContain("engagement-farming");
    const b = await getDeclared(env, d.hash);
    expect(b?.floor_flags?.length).toBeGreaterThan(0);
  });
  it("clean spec gets no floor flags", async () => {
    const d = await bountyDeclare(env, { spec: "write documentation for the API", amount: "30" });
    expect(d.record.floor_flags).toBeUndefined();
  });
});

describe("judge science", () => {
  const env = fakeEnv();
  it("verbosity penalty decays score over cap", () => {
    expect(verbosityAdjust(90, "x".repeat(100), 4000)).toBe(90);
    expect(verbosityAdjust(90, "x".repeat(40000), 4000)).toBe(75); // 1 decade over
  });
  it("dedupe: exact dup flagged, near-dup scored", async () => {
    const t = "the same submission text about widespread work protocol";
    const h = "sha256:x";
    const first = await dedupe(env, "m1", h, t);
    expect(first.dup).toBeNull();
    const second = await dedupe(env, "m1", h, t);
    expect(second.dup).toBe("exact");
    const near = await dedupe(env, "m1", "sha256:y", t + " extra");
    expect(near.similarity).toBeGreaterThan(0.85);
  });
  it("fp-rate cost: clean actor free, slop pays", async () => {
    expect((await claimCost(env, "good-actor")).cost).toBe("0");
    for (let i = 0; i < 6; i++) await recordOutcome(env, "slopper", false);
    const c = await claimCost(env, "slopper");
    expect(c.window_rejects).toBe(6);
    expect(Number(c.cost)).toBeGreaterThan(0);
    // reinsertion: accepts shrink the window rate
    for (let i = 0; i < 5; i++) await recordOutcome(env, "slopper", true);
    const c2 = await claimCost(env, "slopper");
    expect(Number(c2.cost)).toBeLessThan(Number(c.cost));
  });
});
