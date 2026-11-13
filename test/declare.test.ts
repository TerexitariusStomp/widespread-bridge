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
