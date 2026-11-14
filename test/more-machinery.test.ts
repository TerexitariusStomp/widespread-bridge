// MORE Stage B/C machinery: outcome escrow state machine, maximin pool,
// life-capacity packs, dispute sightings.
import { describe, expect, it, vi, beforeAll } from "vitest";
import { scheduleOutcome, submitOutcome, disputeOutcome, resolveDispute, getOutcome, trancheBps } from "../src/outcome";
import { recordFunding, matchFor, poolStatus, leastFunded } from "../src/maximin";
import { validateDomain } from "../src/domains/index";
import { ingestSighting } from "../src/sightings";
import { fakeEnv } from "./mock";
import type { ReviewRecord } from "../src/types";

const env = () => fakeEnv();

function recordWithCapacity(dims = ["C_e", "C_k"], horizon = 30): ReviewRecord {
  return {
    id: "repo/x:1", repo: "repo/x", seq: 1, status: "accepted_unpaid",
    claim: { seq: 1, kind: "ship", actor: "w", hash: "h", payload: {} } as never,
    chain: { valid: true, checked: 1 } as never,
    commits: [], crosscheck: {} as never, bounty: {
      repo: "repo/x", amount: "100", currency: "USD", receiver_account: "",
      spec: "restore wetland", created_at: Date.now(),
      capacity: {
        dims: dims as never,
        evidence_plan: { measure: "tree survival + eDNA resamples", attester: "watcher",
          attester_paid_by: "protocol", horizon_days: horizon },
      },
    },
    adjudication: null, payout: null, writeback: null, reviewed_at: Date.now(),
  } as ReviewRecord;
}

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("crossref.org")) {
      return Response.json({ message: { DOI: "10.1234/test", title: ["A paper"], type: "journal-article" } });
    }
    return new Response("nf", { status: 404 });
  }));
});

describe("outcome escrow", () => {
  it("schedules tranche-2 for capacity-tagged accepts only", async () => {
    const e = env();
    const st = await scheduleOutcome(e, recordWithCapacity());
    expect(st?.status).toBe("pending");
    expect(st?.tranche_bps).toBe(40); // 30 + 10*(2-1)
    expect(st?.due_at).toBeGreaterThan(Date.now());
    // idempotent
    expect((await scheduleOutcome(e, recordWithCapacity()))?.id).toBe(st?.id);
    // untagged → null
    const unt = recordWithCapacity();
    unt.bounty = { ...unt.bounty!, capacity: undefined };
    expect(await scheduleOutcome(e, unt)).toBeNull();
  });

  it("horizon gate blocks early submission", async () => {
    const e = env();
    await scheduleOutcome(e, recordWithCapacity(["C_k"], 30));
    const r = await submitOutcome(e, "repo/x:1", { ref: "https://example.com/evidence" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/horizon/);
  });

  it("trancheBps scales and caps", () => {
    expect(trancheBps(["C_k"])).toBe(30);
    expect(trancheBps(["C_e", "C_k", "C_h"])).toBe(50);
    expect(trancheBps(["C_e", "C_h", "C_k", "C_inst", "C_m"])).toBe(70);
  });

  it("dispute freezes; resolve unfreezes", async () => {
    const e = env();
    await scheduleOutcome(e, recordWithCapacity());
    const d = await disputeOutcome(e, "repo/x:1", "did:key:zWatcher", "forest is monoculture");
    expect(d.outcome?.status).toBe("frozen");
    const r1 = await submitOutcome(e, "repo/x:1", { ref: "https://x" });
    expect(r1.ok).toBe(false);
    const res = await resolveDispute(e, "repo/x:1", "failed");
    expect(res.outcome?.status).toBe("failed");
  });
});

describe("maximin pool", () => {
  it("records funding and finds least-funded dim", async () => {
    const e = env();
    // fund every dim so "least" is meaningful — C_e is the scarcest
    for (const [d, amt] of [["C_e","10"],["C_h","50"],["C_k","30"],["C_inst","80"],["C_m","60"]] as const)
      await recordFunding(e, [d], amt);
    const st = await poolStatus(e);
    expect(leastFunded(st.dims as never)).toBe("C_e");
    const hint = await matchFor(e, ["C_e"]);
    expect(hint.matched).toBe(true);
    expect(hint.match_bps).toBeGreaterThan(0);
    const hint2 = await matchFor(e, ["C_k"]);
    expect(hint2.matched).toBe(false);
    expect(hint2.match_bps).toBe(0);
  });
});

describe("life-capacity packs", () => {
  it("ecological requires modalities + cids + uncertainty", async () => {
    const v = await validateDomain(
      { id: "m", domain: "ecological", verification: { class: "x" } },
      { ref: "ipfs://bafytest", evidence: {} }, env());
    expect(v.pack).toBe("ecological");
    expect(v.failures.length).toBeGreaterThan(0);
    expect(v.evidence.capacity_dims).toEqual(["C_e"]);
  });

  it("ecological passes with multi-modal DMRV evidence", async () => {
    const cid = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4sfolr";
    const v = await validateDomain(
      { id: "m", domain: "ecological", verification: { class: "x" } },
      { ref: "site:wetland-7", evidence: {
          modalities: ["satellite", "edna"], cids: [cid],
          uncertainty: "±12% cover estimate, 95% CI", observer_receipt: "sig:abc",
        } }, env());
    expect(v.failures).toEqual([]);
    expect(v.evidence.multi_modal_confirmed).toBe(true);
  });

  it("knowledge resolves DOI via Crossref", async () => {
    const v = await validateDomain(
      { id: "m", domain: "knowledge", verification: { class: "x" } },
      { ref: "doi:10.1234/test", evidence: {} }, env());
    expect(v.pack).toBe("knowledge");
    expect(v.failures).toEqual([]);
    expect(v.evidence.doi).toBe("10.1234/test");
    expect(v.evidence.capacity_dims).toEqual(["C_k"]);
  });
});

describe("dispute sightings", () => {
  it("'#widespread dispute repo:seq' freezes the outcome", async () => {
    const e = env();
    await scheduleOutcome(e, recordWithCapacity());
    await ingestSighting(e, {
      platform: "nostr", native_id: "ev1",
      text: "#widespread dispute repo/x:1 — claimed restoration is a monoculture plantation",
      watcher_did: "did:key:zW",
    });
    const st = await getOutcome(e, "repo/x:1");
    expect(st?.status).toBe("frozen");
    expect(st?.dispute?.by).toBe("did:key:zW");
  });
});
