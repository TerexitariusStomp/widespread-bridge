// coordinator.test.ts — LocalChimera port coverage: registry helpers,
// did:key interop, and the CoordinatorDO core over a fake in-memory state.
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  selectVolunteer, normalizeTaskTypes, stripGatedClaims, stripSwarmClaims,
  validateJobResult, WIDESPREAD,
  type VolunteerMeta,
} from "../src/coordinator/registry";
import { base58Decode, didKeyPublicKey, verifyDidKey, decodeSig, didKeyFromPublicKey } from "../src/coordinator/didkey";
import { canonicalJson } from "../src/artifacts";
import { CoordinatorDO } from "../src/coordinator/coordinator-do";
import { fakeEnv } from "./mock";
import type { Env } from "../src/types";

// ── fake DO state: Map-backed storage + ws stubs ──

function fakeStorage() {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    map,
    async get(key: string) { return map.get(key); },
    async put(key: string, value: unknown) { map.set(key, value); },
    async delete(key: string) { map.delete(key); },
    async list(opts?: { prefix?: string; limit?: number }) {
      const out = new Map<string, unknown>();
      for (const [k, v] of map) {
        if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
        if (opts?.limit && out.size >= opts.limit) break;
      }
      return out;
    },
    async getAlarm() { return alarm; },
    async setAlarm(t: number) { alarm = t; },
  };
}

function fakeWS() {
  const self = {
    sent: [] as string[],
    closed: false,
    attachment: null as unknown,
    send(m: string) { self.sent.push(m); },
    close() { self.closed = true; },
    serializeAttachment(a: unknown) { self.attachment = a; },
    deserializeAttachment() { return self.attachment; },
  };
  return self;
}
type FakeWS = ReturnType<typeof fakeWS>;

function fakeState() {
  const storage = fakeStorage();
  const sockets: FakeWS[] = [];
  const state = {
    storage,
    sockets,
    getWebSockets() { return sockets as unknown as WebSocket[]; },
    acceptWebSocket(ws: WebSocket) { sockets.push(ws as unknown as FakeWS); },
    waitUntil(_p: unknown) { /* noop */ },
  };
  return state;
}

type FakeState = ReturnType<typeof fakeState>;

function makeDO(env?: Partial<Env>) {
  const state = fakeState();
  const doo = new CoordinatorDO(
    state as unknown as DurableObjectState,
    fakeEnv(env) as Env,
  );
  return { doo, state };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function register(doo: CoordinatorDO, state: FakeState, over: Record<string, unknown> = {}) {
  const ws = fakeWS();
  state.sockets.push(ws);
  await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
    type: "REGISTER",
    volunteerId: "v1",
    taskTypes: [WIDESPREAD.TASK_CLAIM],
    durable: true,
    networks: ["near"],
    capabilities: { cpuCores: 4 },
    ...over,
  }));
  return ws;
}

// ── registry ──

const vol = (over: Partial<VolunteerMeta> = {}): VolunteerMeta => ({
  id: "v",
  address: "",
  taskTypes: [0],
  capabilities: {},
  networks: ["near"],
  status: "idle",
  registeredAt: Date.now(),
  lastHeartbeat: Date.now(),
  ...over,
});

describe("registry", () => {
  it("selectVolunteer prefers idle over busy even when the busy node scores higher", () => {
    const idle = vol({ id: "idle", capabilities: { cpuCores: 2 } });
    const busy = vol({ id: "busy", status: "busy", capabilities: { hasWebGPU: true, ramGb: 64 } });
    const picked = selectVolunteer([busy, idle], 0, []);
    expect(picked?.id).toBe("idle");
  });

  it("gates 400+ widespread tasks to durable nodes", () => {
    const ephemeral = vol({ id: "e", taskTypes: [WIDESPREAD.TASK_CLAIM] });
    const durable = vol({ id: "d", taskTypes: [WIDESPREAD.TASK_CLAIM], durable: true });
    expect(selectVolunteer([ephemeral], WIDESPREAD.TASK_CLAIM, [])).toBeNull();
    expect(selectVolunteer([ephemeral, durable], WIDESPREAD.TASK_CLAIM, [])?.id).toBe("d");
  });

  it("normalizeTaskTypes accepts the 400-499 widespread range, collapses unknowns", () => {
    expect(normalizeTaskTypes([0, 3, 100, 206, 300, 301, 400, 450, 499, 999, "x"]))
      .toEqual([0, 3, 100, 206, 300, 301, 400, 450, 499, 0, 0]);
  });

  it("stripGatedClaims strips 300+ and 400+ for non-durable nodes", () => {
    expect(stripGatedClaims([0, 300, 400, 412], false)).toEqual([0, 0, 0, 0]);
    expect(stripGatedClaims([0, 300, 400, 412], true)).toEqual([0, 300, 400, 412]);
    expect(stripSwarmClaims).toBe(stripGatedClaims);
  });

  it("validateJobResult enforces the widespread schemas", () => {
    // 400 claim — {cid} json
    expect(validateJobResult(WIDESPREAD.TASK_CLAIM, JSON.stringify({ cid: "bafyabc123" }))).toBe(true);
    expect(validateJobResult(WIDESPREAD.TASK_CLAIM, JSON.stringify({ cid: "short" }))).toBe(false);
    expect(validateJobResult(WIDESPREAD.TASK_CLAIM, "not json")).toBe(false);
    // 402 inference — free text
    expect(validateJobResult(WIDESPREAD.TASK_INFERENCE, "the answer is 42")).toBe(true);
    expect(validateJobResult(WIDESPREAD.TASK_INFERENCE, "")).toBe(false);
    // 410-412 metered resources — {metered, period_secs}
    const metered = JSON.stringify({ metered: { gb: 1.5 }, period_secs: 60 });
    expect(validateJobResult(WIDESPREAD.RESOURCE_BANDWIDTH, metered)).toBe(true);
    expect(validateJobResult(WIDESPREAD.RESOURCE_STORAGE, JSON.stringify({ metered: {} }))).toBe(false);
    // unknown type passes through
    expect(validateJobResult(0, "anything")).toBe(true);
  });
});

// ── didkey ──

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

describe("didkey", () => {
  it("round-trips a generated ed25519 key through did:key and verifies", async () => {
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const prefixed = new Uint8Array(34);
    prefixed[0] = 0xed; prefixed[1] = 0x01;
    prefixed.set(pub, 2);
    const did = `did:key:z${base58Encode(prefixed)}`;
    expect(base58Decode(base58Encode(prefixed))).toEqual(prefixed);
    expect(didKeyPublicKey(did)).toEqual(pub);
    const msg = "widespread-bind:v1";
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg)));
    expect(await verifyDidKey(did, msg, sig)).toBe(true);
    expect(await verifyDidKey(did, "widespread-bind:evil", sig)).toBe(false);
    expect(decodeSig(btoa(String.fromCharCode(...sig)))).toEqual(sig);
    expect(didKeyPublicKey("did:key:z!!bad")).toBeNull();
  });
});

// ── CoordinatorDO over fake state ──

describe("CoordinatorDO", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("REGISTER + HEARTBEAT keeps the node in the pool and reports status", async () => {
    const { doo, state } = makeDO();
    const ws = await register(doo, state, { claimant: "node.testnet", resources: { bandwidth_gb: 100 } });
    expect(ws.sent[0]).toContain("REGISTERED");
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "HEARTBEAT" }));
    const res = await doo.fetch(new Request("https://x/api/coordinator/status"));
    const body = await res.json() as { volunteers: number; idle: number };
    expect(body.volunteers).toBe(1);
    expect(body.idle).toBe(1);
    expect(await state.storage.get("claimant:v1")).toBe("node.testnet");
  });

  it("non-durable REGISTER collapses 400+ claims to 0", async () => {
    const { doo, state } = makeDO();
    const ws = fakeWS();
    state.sockets.push(ws);
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "REGISTER", volunteerId: "v1", taskTypes: [WIDESPREAD.TASK_CLAIM],
    }));
    const meta = (doo as unknown as { registry: Map<string, VolunteerMeta> }).registry.get("v1");
    expect(meta?.taskTypes).toEqual([0]);
  });

  it("dispatch assigns an idle volunteer and JOB_RESULT credits the ledger once", async () => {
    const { doo, state } = makeDO({ JOB_RESULT_TIMEOUT_MS: "60000" });
    const ws = await register(doo, state);
    await state.storage.put("pending:job-1", {
      taskType: WIDESPREAD.TASK_CLAIM, payload: "{}", amountWei: "5",
      source: "direct", since: Date.now(),
    });
    const dispatched = (doo as unknown as { dispatch: (id: string) => Promise<boolean> })
      .dispatch("job-1");
    await tick();
    const dispatchMsg = ws.sent.map((m) => JSON.parse(m) as { type: string; jobId?: string })
      .find((m) => m.type === "JOB_DISPATCH");
    expect(dispatchMsg?.jobId).toBe("job-1");
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "JOB_RESULT", jobId: "job-1", result: JSON.stringify({ cid: "bafyabc123" }),
    }));
    expect(await dispatched).toBe(true);
    const ledger = await state.storage.get("ledger:v1") as { totalWei: string; jobs: number };
    expect(ledger.totalWei).toBe("5");
    expect(ledger.jobs).toBe(1);
    // Replay — dedup: second JOB_RESULT for the same jobId credits nothing.
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "JOB_RESULT", jobId: "job-1", result: JSON.stringify({ cid: "bafyabc123" }),
    }));
    await tick();
    expect((await state.storage.get("ledger:v1") as { totalWei: string }).totalWei).toBe("5");
    const meta = (doo as unknown as { registry: Map<string, VolunteerMeta> }).registry.get("v1");
    expect(meta?.status).toBe("idle");
  });

  it("challengeTick issues a nonce challenge to the completing volunteer", async () => {
    const { doo, state } = makeDO({ CHALLENGE_INTERVAL_MS: "0" });
    const ws = await register(doo, state, { taskTypes: [WIDESPREAD.RESOURCE_COMPUTE] });
    await state.storage.put("job:res-1", {
      jobId: "res-1", taskType: WIDESPREAD.RESOURCE_COMPUTE, status: "done",
      completed_at: Date.now(), primary_volunteer: "v1",
    });
    await state.storage.put("result:res-1", {
      volunteerId: "v1", result: JSON.stringify({ metered: {}, period_secs: 60 }),
    });
    await (doo as unknown as { challengeTick: () => Promise<void> }).challengeTick();
    const ckeys = [...state.storage.map.keys()].filter((k) => k.startsWith("challenge:res-1:"));
    expect(ckeys).toHaveLength(1);
    const rec = await state.storage.get(ckeys[0]) as { nonce: string; chalId: string; ok: boolean | null };
    expect(rec.ok).toBeNull();
    expect(ws.sent.some((m) => m.includes(rec.chalId))).toBe(true);
    // Node answers with the nonce embedded in its challenge result → ok.
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "JOB_RESULT", jobId: rec.chalId,
      result: JSON.stringify({ metered: { gb: 1 }, period_secs: 60, nonce: rec.nonce }),
    }));
    await tick();
    expect((await state.storage.get(ckeys[0]) as { ok: boolean }).ok).toBe(true);
    expect(await state.storage.get("jobflag:res-1")).toBeUndefined();
  });

  it("a wrong challenge answer flags the job claim unverifiable", async () => {
    const { doo, state } = makeDO({ CHALLENGE_INTERVAL_MS: "0" });
    const ws = await register(doo, state, { taskTypes: [WIDESPREAD.RESOURCE_STORAGE] });
    await state.storage.put("job:res-2", {
      jobId: "res-2", taskType: WIDESPREAD.RESOURCE_STORAGE, status: "done",
      completed_at: Date.now(), primary_volunteer: "v1",
    });
    await state.storage.put("result:res-2", {
      volunteerId: "v1", result: JSON.stringify({ metered: {}, period_secs: 60 }),
    });
    await (doo as unknown as { challengeTick: () => Promise<void> }).challengeTick();
    const ckey = [...state.storage.map.keys()].find((k) => k.startsWith("challenge:res-2:"))!;
    const rec = await state.storage.get(ckey) as { chalId: string };
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "JOB_RESULT", jobId: rec.chalId, result: JSON.stringify({ bogus: true }),
    }));
    await tick();
    expect((await state.storage.get(ckey) as { ok: boolean }).ok).toBe(false);
    expect(await state.storage.get("jobflag:res-2")).toBe("challenge-failed");
  });

  it("POST /api/jobs creates a pending job for admin; rejects anonymous", async () => {
    const { doo, state } = makeDO({ ADMIN_TOKEN: "adm" });
    const deny = await doo.fetch(new Request("https://x/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskType: 400, payload: "{}" }),
    }));
    expect(deny.status).toBe(401);
    const res = await doo.fetch(new Request("https://x/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer adm" },
      body: JSON.stringify({ taskType: 400, payload: "{}", replicas: 2 }),
    }));
    const { jobId } = await res.json() as { jobId: string };
    expect(jobId).toMatch(/^job-/);
    const pending = await state.storage.get(`pending:${jobId}`) as { taskType: number; replicas: number };
    expect(pending.taskType).toBe(400);
    expect(pending.replicas).toBe(2);
  });

  it("market_id auth: an open NEAR market authorizes an anonymous POST", async () => {
    const { doo } = makeDO({ NEAR_CONTRACT: "mkt.testnet", NEAR_RPC_URL: "https://rpc.test" });
    const marketBytes = [...new TextEncoder().encode(JSON.stringify({ marketId: "7", status: "open" }))];
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ result: { result: marketBytes } })));
    const res = await doo.fetch(new Request("https://x/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskType: 400, payload: "{}", market_id: "7" }),
    }));
    expect(res.status).toBe(200);
  });

  it("GET /api/jobs/:id returns a signed, complete record", async () => {
    const { doo, state } = makeDO({ COORDINATOR_SECRET: "sec" });
    const ws = await register(doo, state);
    await state.storage.put("pending:job-9", {
      taskType: WIDESPREAD.TASK_CLAIM, payload: "{}", amountWei: "0",
      source: "direct", market_id: undefined, since: Date.now(),
    });
    const dispatched = (doo as unknown as { dispatch: (id: string) => Promise<boolean> })
      .dispatch("job-9");
    // dispatch signs with crypto.subtle when COORDINATOR_SECRET is set —
    // the send lands a few event-loop turns out.
    for (let i = 0; i < 20 && !ws.sent.some((m) => m.includes("JOB_DISPATCH")); i++) await tick();
    expect(ws.sent.some((m) => m.includes("JOB_DISPATCH"))).toBe(true);
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "JOB_RESULT", jobId: "job-9",
      result: JSON.stringify({ cid: "bafyresult99" }), resultSig: "a".repeat(128),
    }));
    expect(await dispatched).toBe(true);
    const res = await doo.fetch(new Request("https://x/api/jobs/job-9"));
    const rec = await res.json() as {
      jobId: string; status: string; sig: string | null;
      results: { volunteer: string; result: string; result_sig: string | null }[];
      tally: { required: number }; challenges: unknown[];
    };
    expect(rec.jobId).toBe("job-9");
    expect(rec.status).toBe("done");
    expect(rec.sig).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(rec.results).toHaveLength(1);
    expect(rec.results[0].volunteer).toBe("v1");
    expect(rec.results[0].result_sig).toBe("a".repeat(128));
    expect(rec.tally.required).toBe(1);
    expect(rec.challenges).toEqual([]);
    const missing = await doo.fetch(new Request("https://x/api/jobs/nope"));
    expect(missing.status).toBe(404);
  });

  it("replica dispatch collects quorum results and records agreement", async () => {
    const { doo, state } = makeDO();
    const wsA = await register(doo, state, { volunteerId: "va" });
    const wsB = await register(doo, state, { volunteerId: "vb" });
    await state.storage.put("pending:job-r", {
      taskType: WIDESPREAD.TASK_CLAIM, payload: "{}", amountWei: "1",
      source: "direct", replicas: 2, since: Date.now(),
    });
    const dispatched = (doo as unknown as { dispatch: (id: string) => Promise<boolean> })
      .dispatch("job-r");
    await tick();
    expect(wsA.sent.some((m) => m.includes("JOB_DISPATCH"))).toBe(true);
    expect(wsB.sent.some((m) => m.includes("JOB_DISPATCH"))).toBe(true);
    const result = JSON.stringify({ cid: "bafyagree123" });
    await doo.webSocketMessage(wsA as unknown as WebSocket,
      JSON.stringify({ type: "JOB_RESULT", jobId: "job-r", result }));
    await doo.webSocketMessage(wsB as unknown as WebSocket,
      JSON.stringify({ type: "JOB_RESULT", jobId: "job-r", result }));
    expect(await dispatched).toBe(true);
    const tally = await state.storage.get("tally:job-r") as
      { agreement: boolean | null; done: boolean };
    expect(tally.done).toBe(true);
    expect(tally.agreement).toBe(true);
    const res = await doo.fetch(new Request("https://x/api/jobs/job-r"));
    const rec = await res.json() as { status: string; results: unknown[]; tally: { required: number } };
    expect(rec.status).toBe("done");
    expect(rec.results).toHaveLength(2);
    expect(rec.tally.required).toBe(2);
    expect((await state.storage.get("ledger:va") as { totalWei: string }).totalWei).toBe("1");
    expect((await state.storage.get("ledger:vb") as { totalWei: string }).totalWei).toBe("1");
  });

  it("POST /receipts verifies the ed25519 sig and stores; GET returns it", async () => {
    const { doo } = makeDO();
    // Mirror the runner's signReceipt: id = sha256(canonicalJson(body)),
    // sig = ed25519 over `widespread-receipt:<id>`, fields pubkey+sig hex.
    const canon = (v: unknown): string => {
      if (v === null || typeof v !== "object") return JSON.stringify(v);
      if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
      const keys = Object.keys(v as Record<string, unknown>).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k])).join(",") + "}";
    };
    const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pubHex = [...pub].map((b) => b.toString(16).padStart(2, "0")).join("");
    const body = { v: 1, market: "mkt-1", units: { bytes_served: 1000 }, period_secs: 3600, issued_at: 1700000000 };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon(body)));
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey,
      new TextEncoder().encode(`widespread-receipt:${id}`)));
    const sigHex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
    const receipt = { ...body, id, pubkey: pubHex, sig: sigHex };

    const post = await doo.fetch(new Request("https://x/api/coordinator/receipts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(receipt),
    }));
    expect(post.status).toBe(200);
    expect((await post.json() as { id: string }).id).toBe(id);

    const get = await doo.fetch(new Request(`https://x/api/coordinator/receipts/${id}`));
    expect(get.status).toBe(200);
    expect(((await get.json()) as { units: { bytes_served: number } }).units.bytes_served).toBe(1000);

    // Bad sig → 400. Forged id → 400.
    const badSig = await doo.fetch(new Request("https://x/api/coordinator/receipts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...receipt, sig: "0".repeat(128) }),
    }));
    expect(badSig.status).toBe(400);
    const badId = await doo.fetch(new Request("https://x/api/coordinator/receipts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...receipt, id: "f".repeat(64) }),
    }));
    expect(badId.status).toBe(400);
    const missing = await doo.fetch(new Request("https://x/api/coordinator/receipts/nope"));
    expect(missing.status).toBe(404);
  });
});

// ── resource offers + request sessions ──

const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

const hexOf = (b: Uint8Array | ArrayBuffer) =>
  [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sessionKey() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  const did = `did:key:z${base58Encode(prefixed)}`;
  expect(didKeyFromPublicKey(pub)).toBe(did);
  const sign = async (msg: string) =>
    hexOf(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg)));
  return { did, pubHex: hexOf(pub), sign };
}

async function signedOffer(k: Awaited<ReturnType<typeof sessionKey>>, over: Record<string, unknown> = {}) {
  const body = {
    node_did: k.did, network: "btfs", kind: "storage", unit: "bytes_month",
    price_near_per_unit: 0.001, quota_max: 0, endpoint_hint: null, terms: null,
    tee: false, issued_at: 1700000000, ...over,
  };
  const id = await sha256Hex(canonicalJson(body));
  const sig = await k.sign(`widespread-offer:${id}`);
  return { ...body, id, pubkey: k.pubHex, sig };
}

async function flush() { for (let i = 0; i < 12; i++) await tick(); }

async function registerWithOffer(
  doo: CoordinatorDO, state: FakeState,
  k: Awaited<ReturnType<typeof sessionKey>>, offer: Record<string, unknown>,
  volunteerId = "v1",
) {
  const ws = fakeWS();
  state.sockets.push(ws);
  const sig = await k.sign(`widespread-bind:${volunteerId}`);
  await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
    type: "REGISTER", volunteerId, did: k.did, sig,
    taskTypes: [412], networks: ["btfs"], offers: [offer],
  }));
  await flush();
  return ws;
}

describe("resource sessions", () => {
  const adminEnv = { COORDINATOR_ADMIN: "adm" } as Partial<Env>;
  const adminHeaders = { "content-type": "application/json", authorization: "Bearer adm" };

  it("offer → request → call → close round-trips units into a signed tick ledger", async () => {
    const { doo, state } = makeDO(adminEnv);
    const k = await sessionKey();
    const offer = await signedOffer(k);
    const ws = await registerWithOffer(doo, state, k, offer);

    // Offer is listed and ranked.
    const list = await doo.fetch(new Request("https://x/api/offers?kind=storage"));
    expect(list.status).toBe(200);
    const offers = (await list.json() as { offers: { id: string; node: string }[] }).offers;
    expect(offers.map((o) => o.id)).toContain(offer.id);
    expect(offers[0].node).toBe("v1");

    // Open a session — admin-funded (market escrow path covered separately).
    const openP = doo.fetch(new Request("https://x/api/requests", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ offer_id: offer.id, requester: "tester" }),
    }));
    await flush();
    const openMsg = JSON.parse(ws.sent.at(-1)!) as { type: string; sessionId: string };
    expect(openMsg.type).toBe("SESSION_OPEN");
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "SESSION_ACCEPTED", sessionId: openMsg.sessionId, endpoint_hint: "btfs://QmNode",
    }));
    const openRes = await openP;
    expect(openRes.status).toBe(201);
    const { session } = await openRes.json() as { session: { sessionId: string; status: string } };
    expect(session.status).toBe("open");

    // Call → SESSION_CALL dispatched, SESSION_RESULT accumulates units.
    const callP = doo.fetch(new Request(`https://x/api/requests/${session.sessionId}/call`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ op: "store", params: { data_b64: "aGk=" } }),
    }));
    await flush();
    const callMsg = JSON.parse(ws.sent.at(-1)!) as { type: string; seq: number };
    expect(callMsg.type).toBe("SESSION_CALL");
    expect(callMsg.seq).toBe(1);

    const units = { bytes_stored: 2 };
    const cumulative = { bytes_stored: 2 };
    const body = JSON.stringify({ sessionId: session.sessionId, seq: callMsg.seq, units, cumulative });
    const hash = await sha256Hex(body);
    const tickSig = await k.sign(`widespread-tick:${session.sessionId}:${callMsg.seq}:${hash}`);
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "SESSION_RESULT", sessionId: session.sessionId, seq: callMsg.seq, ok: true,
      result: { cid: "bafyTest" }, units, cumulative,
      upstream_refs: ["btfs:bafyTest"], sig: tickSig,
    }));
    const callRes = await callP;
    expect(callRes.status).toBe(200);
    const callJson = await callRes.json() as { cumulative: { bytes_stored: number }; result: { cid: string } };
    expect(callJson.cumulative.bytes_stored).toBe(2);
    expect(callJson.result.cid).toBe("bafyTest");

    // Tick ledger recorded with a verified node signature.
    const tickRec = state.storage.map.get(`sesstick:${session.sessionId}:1`) as { sig_ok?: boolean; units: Record<string, number> };
    expect(tickRec.units.bytes_stored).toBe(2);
    expect(tickRec.sig_ok).toBe(true);

    // Session view shows accumulated units + upstream refs.
    const get = await doo.fetch(new Request(`https://x/api/requests/${session.sessionId}`));
    const view = (await get.json() as { session: { used: Record<string, number>; ticks: number; status: string } }).session;
    expect(view.used.bytes_stored).toBe(2);
    expect(view.ticks).toBe(1);

    // Close is idempotent.
    const close = await doo.fetch(new Request(`https://x/api/requests/${session.sessionId}/close`, {
      method: "POST", headers: adminHeaders, body: "{}",
    }));
    expect(((await close.json()) as { session: { status: string } }).session.status).toBe("closed");
    const again = await doo.fetch(new Request(`https://x/api/requests/${session.sessionId}/close`, {
      method: "POST", headers: adminHeaders, body: "{}",
    }));
    expect(((await again.json()) as { session: { status: string } }).session.status).toBe("closed");
    // Calls on a closed session are rejected.
    const late = await doo.fetch(new Request(`https://x/api/requests/${session.sessionId}/call`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ op: "fetch", params: {} }),
    }));
    expect(late.status).toBe(409);
  });

  it("spec routing ranks by price and filters by kind/price ceiling", async () => {
    const { doo, state } = makeDO(adminEnv);
    const k1 = await sessionKey();
    const k2 = await sessionKey();
    const cheap = await signedOffer(k1, { price_near_per_unit: 0.0005, network: "btfs" });
    const pricey = await signedOffer(k2, { price_near_per_unit: 0.01, network: "btfs" });
    await registerWithOffer(doo, state, k1, cheap, "cheap-node");
    await registerWithOffer(doo, state, k2, pricey, "pricey-node");

    const list = await doo.fetch(new Request("https://x/api/offers?kind=storage"));
    const ranked = (await list.json() as { offers: { id: string; score: { price: number } }[] }).offers;
    expect(ranked[0].id).toBe(cheap.id);
    expect(ranked[0].score.price).toBe(0.0005);

    // Price ceiling excludes the pricey offer → spec routes only to cheap.
    const openP = doo.fetch(new Request("https://x/api/requests", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ spec: { kind: "storage", max_price_near_per_unit: "0.001" }, requester: "t" }),
    }));
    await flush();
    const openMsg = JSON.parse((state.sockets.find((s) => s.sent.some((m) => m.includes("SESSION_OPEN")))!.sent.at(-1)!)) as { sessionId: string };
    // Whichever node got it, accept and confirm close-out works.
    const ws = state.sockets.find((s) => s.sent.some((m) => m.includes(openMsg.sessionId)))!;
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "SESSION_ACCEPTED", sessionId: openMsg.sessionId,
    }));
    const res = await openP;
    expect(res.status).toBe(201);
    const { session } = await res.json() as { session: { node: string; network: string } };
    expect(session.node).toBe("cheap-node");
    expect(session.network).toBe("btfs");
  });

  it("rejects unsigned/forged offers and requests without funding", async () => {
    const { doo, state } = makeDO(adminEnv);
    const k = await sessionKey();
    const good = await signedOffer(k);
    // Tampered sig → offer must not be stored.
    const bad = { ...good, sig: "0".repeat(128) };
    const ws = fakeWS();
    state.sockets.push(ws);
    const sig = await k.sign(`widespread-bind:v1`);
    await doo.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({
      type: "REGISTER", volunteerId: "v1", did: k.did, sig,
      taskTypes: [412], networks: ["btfs"], offers: [bad],
    }));
    await flush();
    const list = await doo.fetch(new Request("https://x/api/offers"));
    expect(((await list.json()) as { offers: unknown[] }).offers).toHaveLength(0);

    // No market_id and no admin → 401.
    const denied = await doo.fetch(new Request("https://x/api/requests", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer_id: good.id }),
    }));
    expect(denied.status).toBe(401);
    // Unknown offer → 404 even for admin.
    const missing = await doo.fetch(new Request("https://x/api/requests", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ offer_id: "f".repeat(64) }),
    }));
    expect(missing.status).toBe(404);
  });

  it("raced open: first accept wins, loser is told to close", async () => {
    const { doo, state } = makeDO(adminEnv);
    const k1 = await sessionKey();
    const k2 = await sessionKey();
    // Same offer content signed by two different nodes → two offers.
    const offer1 = await signedOffer(k1, { issued_at: 1700000001 });
    const offer2 = await signedOffer(k2, { issued_at: 1700000001 });
    const ws1 = await registerWithOffer(doo, state, k1, offer1, "node-a");
    const ws2 = await registerWithOffer(doo, state, k2, offer2, "node-b");

    const openP = doo.fetch(new Request("https://x/api/requests", {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ spec: { kind: "storage" }, raced: 2, requester: "t" }),
    }));
    await flush();
    const opens = state.sockets.filter((s) => s.sent.some((m) => (JSON.parse(m) as { type?: string }).type === "SESSION_OPEN"));
    expect(opens.length).toBe(2);
    const sessionId = (JSON.parse(opens[0].sent.find((m) => m.includes("SESSION_OPEN"))!) as { sessionId: string }).sessionId;
    // First accepter wins.
    await doo.webSocketMessage(opens[0] as unknown as WebSocket, JSON.stringify({
      type: "SESSION_ACCEPTED", sessionId,
    }));
    const res = await openP;
    expect(res.status).toBe(201);
    const { session } = await res.json() as { session: { node: string } };
    const winner = session.node;
    // The loser received SESSION_CLOSE.
    const loserWs = opens.find((s) => !s.sent.some((m) => m.includes(`"node":"${winner}"`))) ?? opens[1];
    const loserGotClose = state.sockets.some((s) =>
      s.sent.some((m) => { try { const j = JSON.parse(m) as { type?: string; sessionId?: string }; return j.type === "SESSION_CLOSE" && j.sessionId === sessionId; } catch { return false; } }));
    expect(loserGotClose).toBe(true);
    void ws1; void ws2; void loserWs;
  });
});
