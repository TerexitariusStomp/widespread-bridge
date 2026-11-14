// Ported from LocalChimera (AGPL-3.0) — workers/coordinator/src/coordinator-do.ts — © LocalChimera contributors

/**
 * CoordinatorDO — the Widespread volunteer-compute pipeline in one Durable
 * Object:
 *
 *   ws pool → DO alarm ingests open feed markets (and accepts POSTed jobs)
 *   → dispatch to a volunteer → JOB_RESULT → ledger/rep credit →
 *   public, HMAC-signed job records at /api/jobs/:id so the bridge's claim
 *   validation can verify coordinator provenance.
 *
 * Wire protocol mirrors upstream LocalChimera so a chimera-style
 * CoordinatorClient still works: REGISTER/REGISTERED, HEARTBEAT,
 * JOB_DISPATCH → JOB_RESULT | JOB_REJECTED.
 *
 * Dropped from the upstream port: chain polling / EVM settlement, x402,
 * patronage, committee ballots, ENS, proxy fetch, weights mirror,
 * referrals, wp-cloud site logic, lint/privacypass.
 *
 * Added for Widespread: feed-market ingestion, NEAR market status re-checks
 * at dispatch, replica groups with agreement tallying, resource-job
 * challenges (prove-you-still-serve), signed public job records.
 *
 * Persistence layout (state.storage):
 *   handled:<jobId>   → 1 | 'expired' | 'no-capacity' | 'invalid-result' |
 *     'market-closed' | 'canary-fail'
 *   pending:<jobId>   → PendingJob
 *   assigned:<jobId>  → { volunteerId, at }            (single-replica jobs)
 *   assigned:<jobId>:<volId> → { volunteerId, at }     (replica assignments)
 *   result:<jobId>    → { volunteerId, result, … } | { results, agreement }
 *   result:<jobId>:<volId> → one replica result
 *   tally:<jobId>     → { required, assigned[], results: {volId: result} }
 *   job:<jobId>       → JobRecord (completed/failed summary)
 *   jobflag:<jobId>   → 'challenge-failed' — claim marked unverifiable
 *   challenge:<jobId>:<seq> → ChallengeRecord;  challenge-for:<chalId> → {jobId, seq}
 *   chaljob:<chalId>  → challenge pseudo-job detail
 *   ingested:market:<id> → jobId  (feed dedupe)
 *   ledger:<volId>    → { totalWei, jobs, settledWei, claimant? }
 *   rep:<id>          → { points, jobs, referrals }
 *   rep:lane:<d>:<id> → domain-scoped rep
 *   didbind:<volId>   → DID;  claimant:<volId> → NEAR account
 *   audit:<seq>       → hash-chained audit log (head at audit:last)
 * Volunteer state lives on ws attachments (hibernation-safe) + the
 * in-memory registry rebuilt from them on wake.
 */

import type { VolunteerMeta } from "./registry";
import {
  normalizeTaskTypes, stripGatedClaims, selectVolunteer, validateJobResult,
  WIDESPREAD, RESOURCE_KIND_TASK, DETERMINISTIC_TASKS,
} from "./registry";
import type { PaymentRequirements } from "@x402/core/types";
import { verifyDidKey, decodeSig, didKeyFromPublicKey } from "./didkey";
import { verifyMessage } from "viem";
import type { Hex } from "viem";
import { getMarket } from "./nearview";
import {
  sessionRequirements, verifySessionPayment, settleSessionPayment,
  paymentRequiredBody, supportedKinds,
} from "../x402";
import { checkMandate } from "../mandate";
import { verifySiwx, type SiwxAuth } from "../siwx";
import {
  verifyAdapterManifest, effectiveStatus,
  verifiedOpCount, type AdapterRecord,
} from "../adapters";
import { canonicalJson } from "../artifacts";
import type { FeedRecord } from "../types";
import type { Env } from "../types";

interface PendingJob {
  taskType: number;
  payload: string;
  amountWei: string;
  source: "feed" | "direct" | "canary";
  /** NEAR market this job was ingested/authorized for — status re-checked
   *  at dispatch time (an open→closed transition aborts dispatch). */
  market_id?: string;
  /** Redundant-dispatch count — results collect under tally:<jobId> until
   *  `required` land. Default 1, cap 4. */
  replicas?: number;
  classification?: string;  // 'PUBLIC' (default) or 'INTERNAL' (durable+DID-only)
  difficulty?: number;      // >=2 prefers high-capability nodes
  domain?: string;          // specialization lane hint
  priority?: "interactive" | "batch";
  deadline?: number;        // unix seconds; 0/undefined = none
  since: number;
}

interface TallyRecord {
  required: number;
  assigned: string[];
  results: Record<string, string>;
  comparison: "equality" | "similarity";
  agreement?: boolean | null;
  done?: boolean;
}

interface JobRecord {
  jobId: string;
  taskType: number;
  status: "done" | "failed";
  market_id?: string;
  deadline?: number;
  completed_at: number;
  primary_volunteer?: string;
}

interface ChallengeRecord {
  nonce: string;
  issued_at: number;
  chalId: string;
  result: string | null;
  ok: boolean | null;
}

interface JobEnvelope {
  type: string;
  volunteerId?: string;
  jobId?: string;
  address?: string;
  taskTypes?: unknown;
  capabilities?: Record<string, unknown>;
  networks?: string[];
  site?: string;
  project?: string;
  referrer?: string;
  did?: string;
  sig?: string;
  durable?: boolean;
  shardCapacity?: number;
  claimant?: string;
  resources?: Record<string, unknown>;
  status?: string;
  result?: string;
  resultSig?: string;
  reason?: string;
  offers?: unknown[];
  sessionId?: string;
  seq?: number;
  op?: string;
  params?: unknown;
  units?: Record<string, number>;
  cumulative?: Record<string, number>;
  upstream_refs?: string[];
  endpoint_hint?: string;
  final_units?: Record<string, number>;
  calls?: number;
  ok?: boolean;
  error?: string;
}

interface JobPostBody {
  taskType?: number;
  payload?: string;
  replicas?: number;
  market_id?: string;
  deadline?: number;
  classification?: string;
  amountWei?: string;
  difficulty?: number;
  domain?: string;
}

/** A provider-priced resource offer, Ed25519-signed by the node (same scheme
 *  as metered receipts): id = sha256 of the canonical body, sig over
 *  `widespread-offer:<id>`. `node` is set coordinator-side to the volunteerId
 *  that presented the offer — the connection is authoritative. */
interface Offer {
  id: string;
  node_did: string;
  node: string;
  network: string;
  kind: string;
  unit: string;
  price_near_per_unit: string;
  quota_max: number;
  endpoint_hint: string | null;
  terms: string | null;
  tee: boolean;
  issued_at: number;
  pubkey: string;
  sig: string;
}

interface SessionRecord {
  id: string;
  offer_id: string;
  node: string;
  node_did: string | null;
  requester: string;
  kind: string;
  network: string;
  unit: string;
  price_near_per_unit: string;
  quota: number | null;
  quota_unit: string | null;
  used: Record<string, number>;
  calls: number;
  funding: { type: "market" | "x402" | "mandate"; market_id?: string; ref?: string; payer?: string; mandate_ref?: string };
  status: "opening" | "open" | "closed" | "failed" | "expired";
  opened_at: number;
  closed_at?: number;
  close_reason?: string;
  deadline?: number;
  upstream_refs: string[];
  endpoint_hint?: string | null;
  /** Raced open: volunteerIds still pending; a late accept gets told to
   *  close so only the first accepter serves. */
  pending_nodes?: string[];
}

interface SessionTick {
  seq: number;
  at: number;
  units: Record<string, number>;
  cumulative: Record<string, number>;
  upstream_refs: string[];
  sig?: string;
  /** true when the node's did:key signature verified over the tick body;
   *  false when present-but-invalid; absent when unverifiable (non-did:key
   *  node or no sig). */
  sig_ok?: boolean;
  acked?: boolean;
  disputed?: boolean;
}

interface RequestPostBody {
  offer_id?: string;
  spec?: {
    kind?: string;
    network?: string;
    max_price_near_per_unit?: string;
    min_rep?: number;
    deadline_secs?: number;
  };
  quota?: number;
  market_id?: string;
  requester?: string;
  raced?: number;
  deadline_secs?: number;
  params?: unknown;
  /** x402 v2 PaymentPayload — verified against requirements quoted from the
   *  chosen offer; becomes funding.type="x402". */
  payment?: unknown;
  /** AP2 mandate JWT — recorded as funding.mandate_ref (authorization
   *  artifact, not a funding source). */
  mandate?: unknown;
  /** EIP-4361 SIWX auth {address,message,signature} — binds requester to
   *  a verified EVM address. */
  siwx?: unknown;
}

interface CallPostBody {
  op?: string;
  params?: unknown;
}

interface OfferPostBody {
  id?: string;
  node_did?: string;
  network?: string;
  kind?: string;
  unit?: string;
  price_near_per_unit?: string;
  quota_max?: number;
  endpoint_hint?: string | null;
  terms?: string | null;
  tee?: boolean;
  issued_at?: number;
  pubkey?: string;
  sig?: string;
}

const MAX_RESULT_BYTES = 256 * 1024;
/** Session call params carry payloads (e.g. store data_b64) — larger than
 *  job results but still bounded against memory exhaustion. */
const MAX_CALL_PARAMS_BYTES = 4 * 1024 * 1024;
const MAX_REPLICAS = 4;
const MAX_SESSIONS_PER_MARKET = 8;
const SESSION_OPEN_TIMEOUT_MS = 10000;
const SESSION_CALL_TIMEOUT_MS = 60000;
const MAX_SESSION_TICKS = 10000;
const MAX_OFFERS_PER_NODE = 64;

export class CoordinatorDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private registry = new Map<string, VolunteerMeta>();
  /** jobId → resolve — in-memory; the alarm's flushPending redispatches
   *  anything still pending after a hibernate/wake cycle. */
  private awaiting = new Map<string, { resolve: (ok: boolean) => void }>();
  /** sessionId → pending SESSION_OPEN resolution (raced opens resolve on
   *  the first SESSION_ACCEPTED). */
  private pendingOpens = new Map<string, {
    resolve: (node: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** `${sessionId}:${seq}` → pending SESSION_CALL resolution. */
  private pendingCalls = new Map<string, {
    resolve: (r: { ok: boolean; result?: unknown; error?: string; units?: Record<string, number>; cumulative?: Record<string, number>; upstream_refs?: string[] }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private migrated = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Rehydrate ws<->volunteer mapping from attachments after hibernation.
    for (const ws of state.getWebSockets()) {
      const meta = ws.deserializeAttachment() as VolunteerMeta | null;
      if (meta) this.registry.set(meta.id, meta);
    }
    void this.ensureAlarm();
  }

  // ── HTTP entry (called via the worker's stub.fetch) ──

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // WS volunteer connect — /api/nodes via the bridge forwarder (or bare
    // '/' on a standalone deployment).
    if (req.headers.get("Upgrade") === "websocket" &&
        (url.pathname === "/" || url.pathname === "/api/nodes" ||
         url.pathname === "/api/coordinator/nodes")) {
      return this.handleWsUpgrade(url);
    }
    // Normalize the bridge's /api/coordinator/* prefix → /* so one handler
    // serves both the forwarded surface and a standalone deployment.
    const path = url.pathname.startsWith("/api/coordinator")
      ? url.pathname.slice("/api/coordinator".length) || "/"
      : url.pathname;

    if (path === "/status") {
      return this.json({
        volunteers: this.registry.size,
        idle: [...this.registry.values()].filter((v) => v.status === "idle").length,
        byTaskType: this.countByTaskType(),
        pendingJobs: (await this.keys("pending:")).length,
      });
    }
    if (path === "/leaderboard") {
      const rows: { id: string; rep: number }[] = [];
      for (const [k, v] of await this.state.storage.list({ prefix: "rep:", limit: 500 })) {
        const rec = v as { points?: number } | undefined;
        const id = k.slice(4);
        if (id.includes(":")) continue; // skip rep:lane:* keys — they'd double-count
        if (typeof rec?.points === "number") rows.push({ id, rep: rec.points });
      }
      rows.sort((a, b) => b.rep - a.rep);
      return this.json({ top: rows.slice(0, 50) });
    }
    if (path === "/rep" && url.searchParams.get("id")) {
      const id = url.searchParams.get("id")!;
      const rep = (await this.state.storage.get(`rep:${id}`)) as
        | { points: number; jobs: number; referrals: number } | undefined;
      return this.json({ id, ...(rep ?? { points: 0, jobs: 0, referrals: 0 }) });
    }
    if (path === "/operator" && url.searchParams.get("did")) {
      // Operator rollup — the human DID is the principal; volunteerIds
      // (tabs, extensions, daemons) are instruments. `didbind:` persists at
      // REGISTER so offline nodes still roll up.
      const did = url.searchParams.get("did")!;
      const binds = await this.state.storage.list({ prefix: "didbind:", limit: 5000 });
      const ids = [...binds.entries()].filter(([, v]) => v === did).map(([k]) => k.slice(8));
      let points = 0, jobs = 0, totalWei = 0n;
      const nodes: { id: string; points: number; jobs: number; online: boolean }[] = [];
      for (const id of ids) {
        const rep = (await this.state.storage.get(`rep:${id}`)) as
          | { points?: number; jobs?: number } | undefined;
        const led = (await this.state.storage.get(`ledger:${id}`)) as
          | { totalWei?: string } | undefined;
        const online = this.registry.has(id);
        const p = rep?.points ?? 0, j = rep?.jobs ?? 0;
        points += p; jobs += j;
        totalWei += BigInt(led?.totalWei || "0");
        nodes.push({ id, points: p, jobs: j, online });
      }
      return this.json({ did, nodes, totalPoints: points, totalJobs: jobs, totalWei: totalWei.toString() });
    }
    if (path === "/earnings" && url.searchParams.get("id")) {
      const led = (await this.state.storage.get(`ledger:${url.searchParams.get("id")}`)) as
        | { totalWei: string; jobs: number; settledWei: string; claimant?: string } | undefined;
      return this.json(led ?? { totalWei: "0", jobs: 0, settledWei: "0" });
    }
    if (path === "/drill") {
      // Disaster-recovery drill — recomputes the hash-chained audit log and
      // cross-checks ledger totals against recorded job credits. Admin only.
      if (!this.bearerOk(req, this.env.COORDINATOR_ADMIN || this.env.ADMIN_TOKEN)) {
        return this.json({ error: "unauthorized" }, 401);
      }
      const entries = await this.state.storage.list({ prefix: "audit:", limit: 5000 });
      entries.delete("audit:last");
      const sorted = [...entries.entries()].sort((a, b) => Number(a[0].slice(6)) - Number(b[0].slice(6)));
      let prev = "0";
      let broken: number | null = null;
      let checked = 0;
      for (const [, v] of sorted) {
        const e = v as { seq: number; prev: string; event: string; data: unknown; at: number; hash: string };
        if (e.prev !== prev) { broken = e.seq; break; }
        const rehash = await this.sha256Hex(JSON.stringify({ seq: e.seq, prev: e.prev, event: e.event, data: e.data, at: e.at }));
        if (rehash !== e.hash) { broken = e.seq; break; }
        prev = e.hash;
        checked++;
      }
      const last = (await this.state.storage.get("audit:last")) as { seq?: number } | undefined;
      const chainOk = broken === null && (checked === 0 || (last?.seq ?? 0) === checked);
      const badLedgers: string[] = [];
      for (const key of await this.keys("ledger:")) {
        const l = (await this.state.storage.get(key)) as { totalWei?: string; settledWei?: string } | undefined;
        if (!l) continue;
        if (BigInt(l.settledWei || "0") > BigInt(l.totalWei || "0")) badLedgers.push(key);
      }
      return this.json({
        auditChain: { entries: checked, intact: chainOk, brokenAt: broken },
        ledgers: { checked: (await this.keys("ledger:")).length, inconsistent: badLedgers },
        pendingJobs: (await this.keys("pending:")).length,
        assignments: (await this.keys("assigned:")).length,
      });
    }
    if (path === "/audit") {
      // Hash-chained audit export — admin only.
      if (!this.bearerOk(req, this.env.COORDINATOR_ADMIN || this.env.ADMIN_TOKEN)) {
        return this.json({ error: "unauthorized" }, 401);
      }
      const last = (await this.state.storage.get("audit:last")) as
        | { seq: number; hash: string } | undefined;
      const events = await this.state.storage.list({ prefix: "audit:", limit: 5000 });
      events.delete("audit:last");
      return this.json({ head: last ?? null, events: [...events.values()] });
    }
    if (path === "/metrics") {
      const lines = [
        `# HELP widespread_volunteers Registered volunteers`,
        `widespread_volunteers ${this.registry.size}`,
        `widespread_idle ${[...this.registry.values()].filter((v) => v.status === "idle").length}`,
        `widespread_durable ${[...this.registry.values()].filter((v) => v.durable).length}`,
        `widespread_pending_jobs ${(await this.keys("pending:")).length}`,
      ];
      for (const [tt, n] of Object.entries(this.countByTaskType()))
        lines.push(`widespread_volunteers_by_task{taskType="${tt}"} ${n}`);
      return new Response(lines.join("\n") + "\n", {
        headers: { "content-type": "text/plain; version=0.0.4" },
      });
    }
    if ((path === "/jobs" || path === "/api/jobs") && req.method === "POST") {
      return this.handleJobPost(req);
    }
    if ((path.startsWith("/jobs/") || path.startsWith("/api/jobs/")) && req.method === "GET") {
      const jobId = decodeURIComponent(path.slice(path.indexOf("jobs/") + 5)).slice(0, 128);
      if (!jobId) return this.json({ error: "jobId required" }, 400);
      return this.handleJobGet(jobId);
    }
    if ((path === "/receipts" || path === "/api/coordinator/receipts") && req.method === "POST") {
      return this.handleReceiptPost(req);
    }
    if ((path.startsWith("/receipts/") || path.startsWith("/api/coordinator/receipts/")) && req.method === "GET") {
      const id = decodeURIComponent(path.slice(path.indexOf("receipts/") + 9)).slice(0, 128);
      if (!id) return this.json({ error: "receipt id required" }, 400);
      return this.handleReceiptGet(id);
    }

    // ── Resource offers + request sessions (the requesting data plane) ──
    if (path === "/offers" || path === "/api/offers") {
      if (req.method === "GET") return this.handleOffersList(url);
      if (req.method === "POST") return this.handleOfferPost(req);
      return this.json({ error: "method not allowed" }, 405);
    }
    if ((path === "/offers/stats" || path === "/api/offers/stats") && req.method === "GET") {
      return this.handleOfferStats();
    }
    if ((path === "/requests" || path === "/api/requests") && req.method === "POST") {
      return this.handleRequestPost(req);
    }
    if (path.startsWith("/requests/") || path.startsWith("/api/requests/")) {
      const rest = decodeURIComponent(path.slice(path.indexOf("requests/") + 9));
      const [id, action, seqStr, verdict] = rest.split("/");
      if (!id || id.length > 128) return this.json({ error: "request id required" }, 400);
      if (!action && req.method === "GET") return this.handleRequestGet(id);
      if (action === "call" && req.method === "POST") return this.handleRequestCall(id, req);
      if (action === "close" && req.method === "POST") return this.handleRequestClose(id, req);
      if (action === "ticks" && req.method === "POST" && (verdict === "ack" || verdict === "dispute")) {
        const seq = Number(seqStr);
        if (!Number.isInteger(seq) || seq < 1) return this.json({ error: "tick seq required" }, 400);
        return this.handleTickVerdict(id, seq, verdict, req);
      }
      return this.json({ error: "not found" }, 404);
    }

    // ── Surface adapter registry (widespread-adapter/1 manifests) ──
    if (path === "/adapters" || path === "/api/adapters") {
      if (req.method === "GET") return this.handleAdaptersList(url);
      if (req.method === "POST") return this.handleAdapterPost(req);
      return this.json({ error: "method not allowed" }, 405);
    }
    if ((path === "/adapters/stats" || path === "/api/adapters/stats") && req.method === "GET") {
      return this.handleAdapterStats();
    }
    if (path.startsWith("/adapters/") || path.startsWith("/api/adapters/")) {
      const rest = decodeURIComponent(path.slice(path.indexOf("adapters/") + 9));
      const [id, action] = rest.split("/");
      if (!id || id.length > 128) return this.json({ error: "adapter id required" }, 400);
      if (!action && req.method === "GET") return this.handleAdapterGet(id);
      if (action === "report" && req.method === "POST") return this.handleAdapterReport(id, req);
      if (action === "deprecate" && req.method === "POST") return this.handleAdapterDeprecate(id, req);
      return this.json({ error: "not found" }, 404);
    }

    // ── x402 facilitator surface ──
    if ((path === "/x402/supported" || path === "/api/x402/supported") && req.method === "GET") {
      return this.json(supportedKinds(this.env));
    }
    if ((path === "/x402/verify" || path === "/api/x402/verify") && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as { payload?: unknown; requirements?: PaymentRequirements } | null;
      if (!b?.payload || !b.requirements) return this.json({ error: "payload + requirements required" }, 400);
      const v = await verifySessionPayment(this.env, b.payload, b.requirements);
      return this.json(v, v.ok ? 200 : 402);
    }
    if ((path === "/x402/settle" || path === "/api/x402/settle") && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as { payload?: unknown; requirements?: PaymentRequirements } | null;
      if (!b?.payload || !b.requirements) return this.json({ error: "payload + requirements required" }, 400);
      const s = await settleSessionPayment(this.env, b.payload, b.requirements);
      return this.json(s, s.ok ? 200 : 402);
    }
    return this.json({ error: "not found" }, 404);
  }

  // ── WebSocket protocol ──

  private handleWsUpgrade(url: URL): Response {
    const token = url.searchParams.get("token");
    if (this.env.VOLUNTEER_TOKEN && token !== this.env.VOLUNTEER_TOKEN) {
      return new Response("invalid token", { status: 401 });
    }
    const max = Number(this.env.MAX_VOLUNTEERS || "5000");
    if (this.registry.size >= max) return new Response("pool full", { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The ws attachment is the authoritative identity — a client can never
   *  self-report someone else's volunteerId. */
  private metaFor(ws: WebSocket): VolunteerMeta | null {
    return ws.deserializeAttachment() as VolunteerMeta | null;
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    let env: JobEnvelope;
    try {
      env = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      ws.send(JSON.stringify({ type: "ERROR", error: "invalid message" }));
      return;
    }

    switch (env.type) {
      case "REGISTER": {
        const id = env.volunteerId || crypto.randomUUID();
        const existing = this.registry.get(id);
        if (existing && this.wsFor(existing.id) !== ws) {
          // Id is live on another connection — don't let a newcomer shadow
          // an active volunteer's dispatch stream.
          ws.send(JSON.stringify({ type: "ERROR", error: "volunteer id in use" }));
          ws.close(4009, "id in use");
          return;
        }
        // DID binding — two schemes, same trust tier:
        //  • EOA (0x…) — EIP-191 over `widespread-bind:<volunteerId>`
        //  • did:key:z… — raw ed25519 over the same message (did:key's key
        //    material is self-contained; no resolver call needed)
        let did: string | undefined;
        if (typeof env.did === "string" && typeof env.sig === "string") {
          try {
            let ok = false;
            if (env.did.startsWith("did:key:")) {
              const sigBytes = decodeSig(env.sig);
              if (sigBytes) ok = await verifyDidKey(env.did, `widespread-bind:${id}`, sigBytes);
            } else {
              ok = await verifyMessage({
                address: env.did as Hex,
                message: `widespread-bind:${id}`,
                signature: env.sig as Hex,
              });
            }
            if (ok) did = env.did;
            else console.warn(`[coordinator] ${id} presented invalid DID sig`);
          } catch {
            console.warn(`[coordinator] ${id} DID verify failed`);
          }
        }
        // Persist the DID binding — the live registry is volatile (drops on
        // disconnect), but job-record provenance needs the DID even when
        // the node is offline.
        if (did) await this.state.storage.put(`didbind:${id}`, did);
        const meta: VolunteerMeta = {
          id,
          address: env.address || "",
          taskTypes: stripGatedClaims(normalizeTaskTypes(env.taskTypes), env.durable === true),
          capabilities: env.capabilities || {},
          networks: env.networks?.length ? env.networks : ["near"],
          site: typeof env.site === "string" ? env.site.slice(0, 64) : undefined,
          project: typeof env.project === "string" ? env.project.slice(0, 64) : undefined,
          referrer: typeof env.referrer === "string" ? env.referrer.slice(0, 64) : undefined,
          did,
          durable: env.durable === true || undefined,
          shardCapacity: typeof env.shardCapacity === "number" ? Math.max(0, Math.round(env.shardCapacity)) : undefined,
          claimant: typeof env.claimant === "string" ? env.claimant.slice(0, 128) : undefined,
          resources: env.resources && typeof env.resources === "object"
            ? env.resources as Record<string, unknown> : undefined,
          status: "idle",
          registeredAt: Date.now(),
          lastHeartbeat: Date.now(),
        };
        // Resource offers — signed by the node's own key, bound to this
        // connection's identity so nobody posts offers for another node.
        // Re-registration replaces the node's offer set wholesale.
        if (Array.isArray(env.offers)) {
          void this.storeOffers(meta.id, did ?? null, env.offers.slice(0, MAX_OFFERS_PER_NODE));
        }
        if (meta.referrer && meta.referrer !== meta.id) {
          const rkey = `ref:${meta.id}`;
          if (!(await this.state.storage.get(rkey))) {
            await this.state.storage.put(rkey, { referrer: meta.referrer, project: meta.project, at: Date.now() });
          }
        }
        // Payout claimant — the NEAR account the node wants market releases
        // paid to. Persisted so offline nodes keep their payout binding.
        if (meta.claimant) await this.state.storage.put(`claimant:${meta.id}`, meta.claimant);
        this.registry.set(meta.id, meta);
        ws.serializeAttachment(meta);
        ws.send(JSON.stringify({ type: "REGISTERED", volunteerId: meta.id }));
        break;
      }
      case "HEARTBEAT": {
        // Update the REGISTRY entry — metaFor returns a fresh attachment
        // copy, so mutating it alone leaves the registry's lastHeartbeat
        // stale and the node drops out of dispatch eligibility after 60s.
        const v = this.metaFor(ws);
        const r = v ? this.registry.get(v.id) : undefined;
        const target = r ?? v;
        if (target) {
          target.lastHeartbeat = Date.now();
          // env.status is ignored — the DO owns busy/idle via the
          // assignment lifecycle.
          if (env.taskTypes) target.taskTypes = stripGatedClaims(normalizeTaskTypes(env.taskTypes), target.durable);
          if (env.capabilities) target.capabilities = env.capabilities;
          if (env.resources && typeof env.resources === "object") target.resources = env.resources;
          if (typeof env.claimant === "string" && env.claimant) {
            target.claimant = env.claimant.slice(0, 128);
            await this.state.storage.put(`claimant:${target.id}`, target.claimant);
          }
          ws.serializeAttachment(target);
        }
        break;
      }
      case "JOB_RESULT": {
        const meta = this.metaFor(ws);
        if (env.jobId && typeof env.result === "string" && meta) {
          void this.onJobResult(
            env.jobId, meta.id, env.result.slice(0, MAX_RESULT_BYTES),
            typeof env.resultSig === "string" ? env.resultSig : undefined);
        }
        break;
      }
      case "JOB_REJECTED": {
        const meta = this.metaFor(ws);
        if (env.jobId && meta) void this.onJobRejected(env.jobId, meta.id, env.reason);
        break;
      }
      case "EXIT": {
        // Honest exit — a draining node announces departure; its in-flight
        // assignments release immediately for re-dispatch rather than dying
        // on the result timeout. Then close cleanly.
        const meta = this.metaFor(ws);
        if (meta) {
          void this.releaseVolunteerAssignments(meta.id);
          void this.failNodeSessions(meta.id, "node-exit");
          void this.removeOffersFor(meta.id);
          this.registry.delete(meta.id);
        }
        try { ws.close(1000, "exit"); } catch { /* already closed */ }
        break;
      }
      case "SESSION_ACCEPTED": {
        const meta = this.metaFor(ws);
        if (meta && typeof env.sessionId === "string") {
          void this.onSessionAccepted(env.sessionId.slice(0, 128), meta.id,
            typeof env.endpoint_hint === "string" ? env.endpoint_hint.slice(0, 256) : undefined);
        }
        break;
      }
      case "SESSION_REJECTED": {
        const meta = this.metaFor(ws);
        if (meta && typeof env.sessionId === "string") {
          void this.onSessionRejected(env.sessionId.slice(0, 128), meta.id, env.reason);
        }
        break;
      }
      case "SESSION_RESULT": {
        const meta = this.metaFor(ws);
        if (meta && typeof env.sessionId === "string" && typeof env.seq === "number") {
          void this.onSessionResult(env.sessionId.slice(0, 128), meta.id, env.seq, env);
        }
        break;
      }
      case "SESSION_TICK": {
        const meta = this.metaFor(ws);
        if (meta && typeof env.sessionId === "string") {
          void this.onSessionTick(env.sessionId.slice(0, 128), meta.id, env);
        }
        break;
      }
      case "SESSION_CLOSED": {
        const meta = this.metaFor(ws);
        if (meta && typeof env.sessionId === "string") {
          void this.onSessionClosed(env.sessionId.slice(0, 128), meta.id, env);
        }
        break;
      }
      default:
        ws.send(JSON.stringify({ type: "ERROR", error: "unknown type" }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const meta = this.metaFor(ws);
    if (meta) {
      // Unannounced drop — same release path as honest EXIT so a crashed
      // node's jobs re-dispatch promptly rather than waiting out
      // JOB_RESULT_TIMEOUT_MS. Its offers stop being served and its open
      // sessions fail fast rather than hanging until the deadline.
      await this.releaseVolunteerAssignments(meta.id);
      await this.failNodeSessions(meta.id, "node-disconnected");
      await this.removeOffersFor(meta.id);
      this.registry.delete(meta.id);
    }
    try { ws.close(); } catch { /* already closed */ }
  }

  /** Release every job still assigned to a departing volunteer back to
   *  pending. In-flight RESULTs that arrive later are ignored because the
   *  assignment row is gone — correct: only the current assignee may resolve. */
  private async releaseVolunteerAssignments(volunteerId: string) {
    for (const key of await this.keys("assigned:")) {
      const a = (await this.state.storage.get(key)) as { volunteerId?: string } | undefined;
      if (a?.volunteerId === volunteerId) await this.releaseAssignment(key.slice(9));
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  private wsFor(volunteerId: string): WebSocket | undefined {
    return this.state
      .getWebSockets()
      .find((w) => this.metaFor(w)?.id === volunteerId);
  }

  // ── Automated job loop (DO alarm — replaces upstream setInterval) ──

  private async ensureAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + Number(this.env.POLL_INTERVAL_MS || "15000"));
    }
  }

  async alarm() {
    // Always reschedule first — a crash must not stall the pipeline.
    await this.state.storage.setAlarm(Date.now() + Number(this.env.POLL_INTERVAL_MS || "15000"));
    try {
      await this.migrate();
      await this.ingestMarkets();
      await this.flushPending();
      await this.canaryTick();
      await this.challengeTick();
      await this.expireSessions();
    } catch (e) {
      console.error("[coordinator] alarm error:", e);
    }
  }

  /** DO storage schema versioning — bump CURRENT and add a step when the
   *  persistence layout changes. Runs once per wake via `migrated`. */
  private static readonly SCHEMA_VERSION = 1;
  private async migrate() {
    if (this.migrated) return;
    this.migrated = true;
    const v = (await this.state.storage.get<number>("schema:v")) ?? 0;
    if (v < CoordinatorDO.SCHEMA_VERSION) {
      await this.state.storage.put("schema:v", CoordinatorDO.SCHEMA_VERSION);
      await this.audit("schema.migrated", { from: v, to: CoordinatorDO.SCHEMA_VERSION });
    }
  }

  /** Feed ingest — every MARKET_INGEST_INTERVAL_MS, pull the bridge's
   *  escrow-locked open feed records and turn unseen market_ids into
   *  pending jobs. Resource-class deliverables map onto the 410-412
   *  metered-task range; everything else is a 400 claim job. */
  private async ingestMarkets() {
    const interval = Number(this.env.MARKET_INGEST_INTERVAL_MS || "120000");
    const last = (await this.state.storage.get<number>("ingest:last")) ?? 0;
    if (Date.now() - last < interval) return;
    const base = (this.env.PUBLIC_BASE || this.env.BRIDGE_BASE || "").replace(/\/$/, "");
    if (!base) return;
    await this.state.storage.put("ingest:last", Date.now());

    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const u = new URL(`${base}/api/feed`);
      u.searchParams.set("escrow", "locked");
      u.searchParams.set("limit", "50");
      if (cursor) u.searchParams.set("cursor", cursor);
      let body: { records?: unknown[]; next_cursor?: string | null } | null = null;
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) break;
        body = (await res.json()) as
          { records?: unknown[]; next_cursor?: string | null } | null;
      } catch {
        break;
      }
      const records = Array.isArray(body?.records) ? body.records : [];
      for (const raw of records) {
        const r = raw as Record<string, unknown>;
        const escrow = r.escrow;
        const escrowLocked = escrow === "locked" ||
          (escrow !== null && typeof escrow === "object" &&
            (escrow as { state?: string }).state === "locked");
        const statusOpen = r.status === undefined || r.status === "open";
        const marketId = typeof r.market_id === "string" ? r.market_id
          : typeof r.marketId === "string" ? r.marketId : null;
        if (!escrowLocked || !statusOpen || !marketId) continue;
        if (await this.state.storage.get(`ingested:market:${marketId}`)) continue;

        const taskType = r.deliverable_class === "resource"
          ? (RESOURCE_KIND_TASK[String(r.resource_kind ?? "")] ?? WIDESPREAD.RESOURCE_COMPUTE)
          : WIDESPREAD.TASK_CLAIM;
        const verification = (r.verification ?? null) as
          | { params?: { replicas?: number } } | null;
        const replicas = Math.min(
          Math.max(Math.round(Number(verification?.params?.replicas ?? 1)) || 1, 1),
          MAX_REPLICAS);
        const jobId = `feed-${marketId}`;
        await this.state.storage.put(`pending:${jobId}`, {
          taskType,
          payload: JSON.stringify({
            market_id: marketId,
            spec: r.spec ?? null,
            domain: r.domain ?? null,
            verification: r.verification ?? null,
          }),
          amountWei: String(r.amount ?? "0"),
          source: "feed",
          market_id: marketId,
          replicas,
          domain: typeof r.domain === "string" ? r.domain.slice(0, 32) : undefined,
          since: Date.now(),
        } satisfies PendingJob);
        await this.state.storage.put(`ingested:market:${marketId}`, jobId);
        void this.audit("market.ingested", { jobId, marketId, taskType, replicas });
      }
      cursor = body?.next_cursor ?? null;
      if (!cursor) break;
    }
  }

  /** Honesty canary — periodically dispatch a CANARY job (echo-the-nonce) to
   *  a random volunteer. A node that returns anything but the nonce is
   *  fabricating results; onJobResult applies the trust penalty. */
  private async canaryTick() {
    const interval = Number(this.env.CANARY_INTERVAL_MS || "1800000");
    const last = (await this.state.storage.get<number>("canary:last")) ?? 0;
    if (Date.now() - last < interval) return;
    const idle = [...this.registry.values()].filter(
      (v) => v.status === "idle" && v.taskTypes.includes(WIDESPREAD.CANARY));
    if (!idle.length) return;
    await this.state.storage.put("canary:last", Date.now());
    const nonce = crypto.randomUUID();
    const jobId = `canary-${crypto.randomUUID()}`;
    await this.state.storage.put(`canary:${jobId}`, nonce);
    await this.state.storage.put(`pending:${jobId}`, {
      taskType: WIDESPREAD.CANARY,
      payload: JSON.stringify({ nonce }),
      amountWei: "0",
      source: "canary",
      priority: "batch",
      since: Date.now(),
    } satisfies PendingJob);
    void this.dispatch(jobId);
  }

  /** Resource-job challenges — for each accepted (result stored), not-yet-
   *  expired resource job (410-412), dispatch a CHALLENGE pseudo-job back to
   *  the SAME volunteer. The node must echo the nonce in its challenge
   *  result (storage: also prove it still holds the CID; bandwidth: echo
   *  through the service). A wrong or timed-out answer flags the job's
   *  claim unverifiable via `jobflag:<jobId>`. */
  private async challengeTick() {
    const interval = Number(this.env.CHALLENGE_INTERVAL_MS || "300000");
    const last = (await this.state.storage.get<number>("challenge:last")) ?? 0;
    const due = Date.now() - last >= interval;
    if (due) await this.state.storage.put("challenge:last", Date.now());
    await this.expireStaleChallenges();
    if (!due) return;

    for (const key of await this.keys("job:")) {
      const rec = (await this.state.storage.get(key)) as JobRecord | undefined;
      if (!rec || rec.status !== "done") continue;
      if (rec.taskType < WIDESPREAD.RESOURCE_COMPUTE || rec.taskType > WIDESPREAD.RESOURCE_STORAGE) continue;
      if (await this.state.storage.get(`jobflag:${rec.jobId}`)) continue;
      if (rec.deadline && rec.deadline * 1000 < Date.now()) continue;
      const volId = rec.primary_volunteer;
      if (!volId) continue;
      const v = this.registry.get(volId);
      const ws = v ? this.wsFor(volId) : undefined;
      if (!v || v.status !== "idle" || !ws) continue;

      const seq = Number((await this.state.storage.get(`chalseq:${rec.jobId}`)) ?? 0) + 1;
      await this.state.storage.put(`chalseq:${rec.jobId}`, seq);
      const chalId = `chal-${rec.jobId}-${seq}`;
      const nonce = crypto.randomUUID();
      const payload: Record<string, unknown> = {
        challenge_of: rec.jobId,
        nonce,
        chunk_hint: Math.floor(Math.random() * 1_000_000),
      };
      if (rec.taskType === WIDESPREAD.RESOURCE_STORAGE) {
        // "prove you still hold CID X" — the CID the node claimed it pinned.
        const stored = (await this.state.storage.get(`result:${rec.jobId}`)) as
          | { result?: string } | undefined;
        try {
          const cid = stored?.result
            ? (JSON.parse(stored.result) as { cid?: string }).cid : undefined;
          if (cid) payload.cid = cid;
        } catch { /* unparseable result — nonce challenge still applies */ }
      }
      await this.state.storage.put(`chaljob:${chalId}`, {
        taskType: rec.taskType, payload: JSON.stringify(payload),
        challenge_of: rec.jobId, volunteerId: volId,
      });
      await this.state.storage.put(`assigned:${chalId}`, { volunteerId: volId, at: Date.now() });
      await this.state.storage.put(`challenge:${rec.jobId}:${seq}`, {
        nonce, issued_at: Date.now(), chalId, result: null, ok: null,
      } satisfies ChallengeRecord);
      await this.state.storage.put(`challenge-for:${chalId}`, { jobId: rec.jobId, seq });
      v.status = "busy";
      ws.serializeAttachment(v);
      const sig = await this.dispatchSig(chalId);
      ws.send(JSON.stringify({
        type: "JOB_DISPATCH",
        jobId: chalId,
        network: "near",
        taskType: rec.taskType,
        requestHash: JSON.stringify(payload),
        amount: "0",
        challenge_of: rec.jobId,
        ...(sig ? { sig } : {}),
      }));
      void this.audit("challenge.issued", { jobId: rec.jobId, seq, volunteerId: volId });
    }
  }

  /** A challenge that went unanswered past two result timeouts is a failed
   *  challenge — the node couldn't (or wouldn't) prove it still serves the
   *  claimed resource. */
  private async expireStaleChallenges() {
    const staleMs = Number(this.env.JOB_RESULT_TIMEOUT_MS || "60000") * 2;
    for (const key of await this.keys("challenge:")) {
      const rec = (await this.state.storage.get(key)) as ChallengeRecord | undefined;
      if (!rec || rec.ok !== null) continue;
      if (Date.now() - rec.issued_at < staleMs) continue;
      rec.ok = false;
      await this.state.storage.put(key, rec);
      const jobId = key.slice("challenge:".length, key.lastIndexOf(":"));
      await this.state.storage.put(`jobflag:${jobId}`, "challenge-failed");
      const staleAssignee = (await this.state.storage.get(`assigned:${rec.chalId}`)) as
        | { volunteerId?: string } | undefined;
      await this.state.storage.delete(`assigned:${rec.chalId}`);
      await this.state.storage.delete(`challenge-for:${rec.chalId}`);
      await this.state.storage.delete(`chaljob:${rec.chalId}`);
      const v = staleAssignee?.volunteerId ? this.registry.get(staleAssignee.volunteerId) : undefined;
      if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
      await this.audit("challenge.timeout", { jobId, chalId: rec.chalId });
    }
  }

  /** Dispatch a pending job to the best available volunteer. Resolves true
   *  once a result arrived (or false on timeout/reject). */
  private async dispatch(jobId: string): Promise<boolean> {
    const job = await this.state.storage.get<PendingJob>(`pending:${jobId}`);
    if (!job) return false;
    if (await this.state.storage.get(`assigned:${jobId}`)) return true;
    {
      // Replica jobs track assignments under assigned:<jobId>:<volId> —
      // in-flight work means the job is already being served.
      const tally = (await this.state.storage.get(`tally:${jobId}`)) as TallyRecord | undefined;
      if (tally && !tally.done) {
        const inFlight = await this.keys(`assigned:${jobId}:`);
        const got = Object.keys(tally.results ?? {}).length;
        if (got + inFlight.length >= tally.required) return true;
      }
    }

    if (job.deadline && job.deadline * 1000 < Date.now()) {
      // Past deadline — consumer can refund; completing would be wasted work.
      await this.state.storage.delete(`pending:${jobId}`);
      await this.state.storage.put(`handled:${jobId}`, "expired");
      return false;
    }

    // Market re-check — feed-ingested jobs are only dispatchable while the
    // NEAR market stays open. An RPC failure fails OPEN (the market was open
    // at ingest; escrow state is re-verified at settlement anyway).
    if (job.market_id) {
      const market = await getMarket(this.env, job.market_id);
      if (market && market.status && market.status !== "open") {
        await this.state.storage.delete(`pending:${jobId}`);
        await this.state.storage.put(`handled:${jobId}`, "market-closed");
        await this.audit("job.market-closed", { jobId, marketId: job.market_id });
        return false;
      }
    }

    if ((job.replicas ?? 1) > 1) return this.dispatchReplicas(jobId, job);

    const volunteer = selectVolunteer(
      this.registry.values(), job.taskType, [], Date.now(),
      undefined, undefined, job.difficulty, job.classification,
    );
    if (!volunteer) return false;

    const ws = this.wsFor(volunteer.id);
    if (!ws) { this.registry.delete(volunteer.id); return false; }

    volunteer.status = "busy";
    ws.serializeAttachment(volunteer);
    await this.state.storage.put(`assigned:${jobId}`, { volunteerId: volunteer.id, at: Date.now() });
    const sig = await this.dispatchSig(jobId);
    ws.send(JSON.stringify({
      type: "JOB_DISPATCH",
      jobId,
      network: "near",
      taskType: job.taskType,
      requestHash: job.payload,
      amount: job.amountWei,
      ...(job.market_id ? { market_id: job.market_id } : {}),
      ...(job.difficulty !== undefined ? { difficulty: job.difficulty } : {}),
      ...(job.domain ? { domain: job.domain } : {}),
      ...(job.priority ? { priority: job.priority } : {}),
      ...(sig ? { sig } : {}),
    }));
    void this.audit("job.dispatch", { jobId, volunteerId: volunteer.id, taskType: job.taskType });

    const timeoutMs = Number(this.env.JOB_RESULT_TIMEOUT_MS || "60000");
    return new Promise<boolean>((resolve) => {
      this.awaiting.set(jobId, { resolve });
      setTimeout(() => {
        const a = this.awaiting.get(jobId);
        if (a) {
          this.awaiting.delete(jobId);
          a.resolve(false);
          // Free the assignment so the next alarm redispatches elsewhere.
          void this.state.storage.delete(`assigned:${jobId}`).then(() => {
            const v = this.registry.get(volunteer.id);
            if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
          });
        }
      }, timeoutMs);
    });
  }

  /** Redundant dispatch — assign the same job to up to `required` distinct
   *  volunteers. Each result lands at result:<jobId>:<volId>; the job
   *  resolves when `required` results are in. */
  private async dispatchReplicas(jobId: string, job: PendingJob): Promise<boolean> {
    const required = Math.min(Math.max(Math.round(job.replicas ?? 1), 1), MAX_REPLICAS);
    const tkey = `tally:${jobId}`;
    const tally = ((await this.state.storage.get(tkey)) as TallyRecord | undefined)
      ?? {
        required,
        assigned: [],
        results: {},
        comparison: DETERMINISTIC_TASKS.has(job.taskType) ? "equality" : "similarity",
      };
    tally.required = required;
    const exclude = new Set(tally.assigned);
    let sent = 0;
    while (tally.assigned.length + Object.keys(tally.results).length < required) {
      const pool = [...this.registry.values()].filter((v) => !exclude.has(v.id));
      const volunteer = selectVolunteer(
        pool, job.taskType, [], Date.now(),
        undefined, undefined, job.difficulty, job.classification);
      if (!volunteer) break;
      const ws = this.wsFor(volunteer.id);
      if (!ws) { this.registry.delete(volunteer.id); continue; }
      volunteer.status = "busy";
      ws.serializeAttachment(volunteer);
      await this.state.storage.put(`assigned:${jobId}:${volunteer.id}`,
        { volunteerId: volunteer.id, at: Date.now() });
      tally.assigned.push(volunteer.id);
      exclude.add(volunteer.id);
      const sig = await this.dispatchSig(jobId);
      ws.send(JSON.stringify({
        type: "JOB_DISPATCH",
        jobId,
        network: "near",
        taskType: job.taskType,
        requestHash: job.payload,
        amount: job.amountWei,
        replicas: required,
        ...(job.market_id ? { market_id: job.market_id } : {}),
        ...(job.domain ? { domain: job.domain } : {}),
        ...(sig ? { sig } : {}),
      }));
      sent++;
      void this.audit("job.dispatch", { jobId, volunteerId: volunteer.id, taskType: job.taskType, replica: true });
    }
    await this.state.storage.put(tkey, tally);
    if (!tally.assigned.length && !Object.keys(tally.results).length) return false;

    const timeoutMs = Number(this.env.JOB_RESULT_TIMEOUT_MS || "60000");
    return new Promise<boolean>((resolve) => {
      this.awaiting.set(jobId, { resolve });
      setTimeout(() => {
        const a = this.awaiting.get(jobId);
        if (a) {
          this.awaiting.delete(jobId);
          a.resolve(false);
          // Release in-flight replica assignments; collected results stay.
          void (async () => {
            for (const key of await this.keys(`assigned:${jobId}:`))
              await this.state.storage.delete(key);
            for (const vid of tally.assigned) {
              const v = this.registry.get(vid);
              if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
            }
          })();
        }
      }, timeoutMs);
    });
  }

  private async releaseAssignment(jobId: string) {
    await this.state.storage.delete(`assigned:${jobId}`);
  }

  private async onJobResult(jobId: string, volunteerId: string, result: string, resultSig?: string) {
    // Challenge result — resolves against the stored nonce, not the job schema.
    const chalRef = (await this.state.storage.get(`challenge-for:${jobId}`)) as
      | { jobId: string; seq: number } | undefined;
    if (chalRef) {
      await this.onChallengeResult(chalRef.jobId, chalRef.seq, jobId, volunteerId, result);
      return;
    }

    // Replica result — per-volunteer assignment key.
    const repAssignment = (await this.state.storage.get(`assigned:${jobId}:${volunteerId}`)) as
      | { volunteerId: string; at: number } | undefined;
    if (repAssignment) {
      await this.onReplicaResult(jobId, volunteerId, result, resultSig);
      return;
    }

    const assignment = (await this.state.storage.get(`assigned:${jobId}`)) as
      | { volunteerId: string; at: number }
      | undefined;
    // Only the volunteer the job was dispatched to may resolve it — otherwise
    // anyone could claim credit for a jobId they saw in transit.
    if (!assignment || assignment.volunteerId !== volunteerId) return;

    // Result dedup — a replayed JOB_RESULT for an already-stored job is a
    // no-op (idempotent), not a second credit.
    if (await this.state.storage.get(`result:${jobId}`)) {
      const pending = this.awaiting.get(jobId);
      if (pending) { this.awaiting.delete(jobId); pending.resolve(true); }
      return;
    }

    const job = await this.state.storage.get<PendingJob>(`pending:${jobId}`);
    if (!job) {
      await this.releaseAssignment(jobId);
      const pending = this.awaiting.get(jobId);
      if (pending) { this.awaiting.delete(jobId); pending.resolve(true); }
      return;
    }

    // Schema-gate typed results before credit — a malformed result is stored
    // (for audit) but earns nothing and is not retried.
    if (!validateJobResult(job.taskType, result)) {
      await this.state.storage.delete(`pending:${jobId}`);
      await this.state.storage.delete(`assigned:${jobId}`);
      await this.state.storage.put(`handled:${jobId}`, "invalid-result");
      await this.state.storage.put(`result:${jobId}`, {
        volunteerId, result, at: Date.now(), source: job.source, invalid: true,
      });
      await this.finishJobRecord(jobId, job, "failed", volunteerId);
      const v0 = this.registry.get(volunteerId);
      if (v0) { v0.status = "idle"; this.wsFor(v0.id)?.serializeAttachment(v0); }
      const pending = this.awaiting.get(jobId);
      if (pending) { this.awaiting.delete(jobId); pending.resolve(true); }
      return;
    }

    // Honesty canary — CANARY jobs carry a coordinator-generated nonce the
    // node must echo verbatim. Anything else = fabricated result → trust
    // penalty slides the node down the dispatch order. Never credited,
    // never retried. (A timed-out canary is just an offline node — no
    // penalty; only a wrong answer trips it.)
    const canaryNonce = await this.state.storage.get<string>(`canary:${jobId}`);
    if (canaryNonce !== undefined) {
      const passed = result === canaryNonce;
      await this.state.storage.delete(`pending:${jobId}`);
      await this.state.storage.delete(`assigned:${jobId}`);
      await this.state.storage.delete(`canary:${jobId}`);
      await this.state.storage.put(`handled:${jobId}`, passed ? 1 : "canary-fail");
      await this.state.storage.put(`result:${jobId}`, {
        volunteerId, result, at: Date.now(), source: job.source, canary: true, passed,
      });
      const v0 = this.registry.get(volunteerId);
      if (v0) {
        v0.status = "idle";
        if (!passed) v0.trust = (v0.trust ?? 0) - 5;
        this.wsFor(v0.id)?.serializeAttachment(v0);
      }
      await this.audit(passed ? "canary.pass" : "canary.fail", { jobId, volunteerId });
      const pending = this.awaiting.get(jobId);
      if (pending) { this.awaiting.delete(jobId); pending.resolve(passed); }
      return;
    }

    await this.state.storage.delete(`pending:${jobId}`);
    await this.state.storage.delete(`assigned:${jobId}`);
    await this.state.storage.put(`handled:${jobId}`, 1);
    const assignmentAt = assignment.at ?? Date.now();
    const durMs = Math.max(0, Date.now() - assignmentAt);
    const cores = Number(this.registry.get(volunteerId)?.capabilities?.cpuCores ?? 2);
    const estWh = Number((((cores * 4 + 5) * durMs) / 3_600_000).toFixed(4));
    // Result proof — a DID-bound node signs `widespread-result:<jobId>:<hash>`
    // so a consumer can prove *this registered node* produced *this result*.
    let proof: { did: string; sig: string; verified: boolean } | undefined;
    const nodeDid = this.registry.get(volunteerId)?.did
      ?? (await this.state.storage.get(`didbind:${volunteerId}`)) as string | undefined;
    if (resultSig && nodeDid) {
      const msg = `widespread-result:${jobId}:${await this.sha256Hex(result)}`;
      let verified = false;
      try {
        if (nodeDid.startsWith("did:key:")) {
          const sigBytes = decodeSig(resultSig);
          if (sigBytes) verified = await verifyDidKey(nodeDid, msg, sigBytes);
        } else {
          verified = await verifyMessage({ address: nodeDid as Hex, message: msg, signature: resultSig as Hex });
        }
      } catch { /* malformed sig → unproven */ }
      proof = { did: nodeDid, sig: resultSig.slice(0, 512), verified };
      if (!verified) await this.audit("result.bad-sig", { jobId, volunteerId });
    }
    const claimant = this.registry.get(volunteerId)?.claimant
      ?? (await this.state.storage.get(`claimant:${volunteerId}`)) as string | undefined;
    await this.state.storage.put(`result:${jobId}`, {
      volunteerId, result, at: Date.now(), source: job.source,
      taskType: job.taskType, payload: job.payload, market_id: job.market_id,
      estWh, result_sig: resultSig ?? null,
      ...(claimant ? { claimant } : {}),
      ...(proof ? { proof } : {}),
    });
    await this.finishJobRecord(jobId, job, "done", volunteerId);
    await this.credit(volunteerId, job.amountWei, job.domain);
    const v = this.registry.get(volunteerId);
    if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
    // Resolve last — readers see result:<jobId> once dispatch resolves.
    const pending = this.awaiting.get(jobId);
    if (pending) { this.awaiting.delete(jobId); pending.resolve(true); }
  }

  /** One replica's result. Schema-gated like a single result; tally
   *  membership is what resolves the job once `required` results land. */
  private async onReplicaResult(jobId: string, volunteerId: string, result: string, resultSig?: string) {
    const tkey = `tally:${jobId}`;
    const tally = (await this.state.storage.get(tkey)) as TallyRecord | undefined;
    if (!tally || tally.done) {
      // No live tally — late/duplicate replica; free the assignment + node.
      await this.state.storage.delete(`assigned:${jobId}:${volunteerId}`);
      const v = this.registry.get(volunteerId);
      if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
      return;
    }
    const job = await this.state.storage.get<PendingJob>(`pending:${jobId}`);
    await this.state.storage.delete(`assigned:${jobId}:${volunteerId}`);
    const v = this.registry.get(volunteerId);
    if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }

    if (!validateJobResult(job?.taskType ?? 0, result)) {
      // Malformed replica — stored for audit, doesn't count toward quorum;
      // the slot frees up so the next flush dispatches a replacement.
      await this.state.storage.put(`result:${jobId}:${volunteerId}`, {
        volunteerId, result, at: Date.now(), invalid: true,
      });
      tally.assigned = tally.assigned.filter((id) => id !== volunteerId);
      await this.state.storage.put(tkey, tally);
      await this.audit("replica.invalid", { jobId, volunteerId });
      return;
    }
    await this.state.storage.put(`result:${jobId}:${volunteerId}`, {
      volunteerId, result, at: Date.now(), result_sig: resultSig ?? null,
    });
    tally.results[volunteerId] = result;
    await this.state.storage.put(tkey, tally);

    if (Object.keys(tally.results).length < tally.required) return;

    // Quorum — resolve the job. Deterministic task types compare normalized
    // results for equality; inference (402) is judged by the bridge.
    const results = Object.values(tally.results);
    const agreement = tally.comparison === "equality"
      ? results.every((r) => this.normalizeResult(r) === this.normalizeResult(results[0]))
      : null;
    tally.done = true;
    tally.agreement = agreement;
    await this.state.storage.put(tkey, tally);
    await this.state.storage.delete(`pending:${jobId}`);
    await this.state.storage.put(`handled:${jobId}`, 1);
    await this.state.storage.put(`result:${jobId}`, {
      results: tally.results,
      agreement,
      comparison: tally.comparison,
      taskType: job?.taskType,
      market_id: job?.market_id,
      at: Date.now(),
      source: job?.source,
    });
    await this.finishJobRecord(jobId, job ?? null, "done", tally.assigned[0]);
    // Every contributing replica earns its share — agreement is reported,
    // not enforced; the bridge-side judge decides market settlement.
    for (const vid of Object.keys(tally.results)) {
      await this.credit(vid, job?.amountWei ?? "0", job?.domain);
    }
    await this.audit("job.replicas", {
      jobId, required: tally.required, got: results.length, agreement,
    });
    const pending = this.awaiting.get(jobId);
    if (pending) { this.awaiting.delete(jobId); pending.resolve(true); }
  }

  /** Challenge resolution — the node's challenge result must contain the
   *  issued nonce. A correct echo keeps the job's claim verifiable; anything
   *  else flags it `challenge-failed` for the bridge to see on the record. */
  private async onChallengeResult(
    jobId: string, seq: number, chalId: string, volunteerId: string, result: string,
  ) {
    const assignment = (await this.state.storage.get(`assigned:${chalId}`)) as
      | { volunteerId: string } | undefined;
    if (!assignment || assignment.volunteerId !== volunteerId) return;
    const ckey = `challenge:${jobId}:${seq}`;
    const rec = (await this.state.storage.get(ckey)) as ChallengeRecord | undefined;
    if (!rec || rec.ok !== null) return;
    const ok = result.includes(rec.nonce);
    rec.result = result.slice(0, 2048);
    rec.ok = ok;
    await this.state.storage.put(ckey, rec);
    await this.state.storage.delete(`assigned:${chalId}`);
    await this.state.storage.delete(`challenge-for:${chalId}`);
    await this.state.storage.delete(`chaljob:${chalId}`);
    if (!ok) await this.state.storage.put(`jobflag:${jobId}`, "challenge-failed");
    const v = this.registry.get(volunteerId);
    if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
    await this.audit(ok ? "challenge.pass" : "challenge.fail", {
      jobId, seq, volunteerId, chalId,
    });
  }

  /** Persist the job:<id> summary record — the index challengeTick scans
   *  and /api/jobs/:id reads status from. */
  private async finishJobRecord(
    jobId: string, job: PendingJob | null, status: "done" | "failed", primary?: string,
  ) {
    await this.state.storage.put(`job:${jobId}`, {
      jobId,
      taskType: job?.taskType ?? 0,
      status,
      market_id: job?.market_id,
      deadline: job?.deadline,
      completed_at: Date.now(),
      primary_volunteer: primary,
    } satisfies JobRecord);
  }

  private async onJobRejected(jobId: string, volunteerId: string, reason?: string) {
    const assignment = (await this.state.storage.get(`assigned:${jobId}`)) as
      | { volunteerId: string }
      | undefined;
    const repAssignment = (await this.state.storage.get(`assigned:${jobId}:${volunteerId}`)) as
      | { volunteerId: string } | undefined;
    if (repAssignment) {
      // Replica rejected — free the slot; next flush tops it up.
      await this.state.storage.delete(`assigned:${jobId}:${volunteerId}`);
      const tally = (await this.state.storage.get(`tally:${jobId}`)) as TallyRecord | undefined;
      if (tally) {
        tally.assigned = tally.assigned.filter((id) => id !== volunteerId);
        await this.state.storage.put(`tally:${jobId}`, tally);
      }
      const v = this.registry.get(volunteerId);
      if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
      return;
    }
    if (assignment?.volunteerId !== volunteerId) return;
    // A rejected CHALLENGE is a failed proof — refusing to answer the probe
    // is the same signal as answering it wrong.
    const chalRef = (await this.state.storage.get(`challenge-for:${jobId}`)) as
      | { jobId: string; seq: number } | undefined;
    if (chalRef) {
      const ckey = `challenge:${chalRef.jobId}:${chalRef.seq}`;
      const c = (await this.state.storage.get(ckey)) as ChallengeRecord | undefined;
      if (c && c.ok === null) {
        c.ok = false;
        c.result = `rejected: ${reason ?? "no reason"}`;
        await this.state.storage.put(ckey, c);
        await this.state.storage.put(`jobflag:${chalRef.jobId}`, "challenge-failed");
      }
      await this.state.storage.delete(`challenge-for:${jobId}`);
      await this.state.storage.delete(`chaljob:${jobId}`);
      await this.audit("challenge.rejected", { jobId: chalRef.jobId, seq: chalRef.seq, volunteerId });
    }
    const pending = this.awaiting.get(jobId);
    if (pending) { this.awaiting.delete(jobId); pending.resolve(false); }
    console.warn(`[coordinator] ${volunteerId} rejected ${jobId}: ${reason || "n/a"}`);
    await this.releaseAssignment(jobId);
    const v = this.registry.get(volunteerId);
    if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
  }

  /** Re-dispatch pending jobs that have no live assignment, and expire
   *  assignments whose result timeout clearly elapsed (e.g. across a
   *  hibernate/wake where the in-memory timer was lost). */
  private async flushPending() {
    const timeoutMs = Number(this.env.JOB_RESULT_TIMEOUT_MS || "60000");
    const pending = await Promise.all(
      (await this.keys("pending:")).map(async (key) => ({
        jobId: key.slice(8),
        job: await this.state.storage.get<PendingJob>(key),
      })),
    );
    pending.sort((a, b) =>
      (a.job?.priority === "interactive" ? 0 : 1) - (b.job?.priority === "interactive" ? 0 : 1));
    // Pending TTL — a job no volunteer can serve would otherwise sit in
    // storage forever. Expire unassigned old jobs as 'no-capacity'.
    const ttlMs = Number(this.env.PENDING_TTL_MS || "3600000");
    for (const { jobId, job } of pending) {
      if (!job || Date.now() - job.since <= ttlMs) continue;
      if (await this.state.storage.get(`assigned:${jobId}`)) continue;
      await this.state.storage.delete(`pending:${jobId}`);
      await this.state.storage.put(`handled:${jobId}`, "no-capacity");
      await this.finishJobRecord(jobId, job, "failed");
      await this.audit("job.expired", { jobId, taskType: job.taskType });
    }
    for (const { jobId } of pending) {
      const a = (await this.state.storage.get(`assigned:${jobId}`)) as
        | { volunteerId: string; at: number }
        | undefined;
      if (a) {
        if (Date.now() - a.at > timeoutMs * 2 && !this.awaiting.has(jobId)) {
          await this.releaseAssignment(jobId);
          const v = this.registry.get(a.volunteerId);
          if (v) { v.status = "idle"; this.wsFor(v.id)?.serializeAttachment(v); }
        } else {
          continue;
        }
      }
      void this.dispatch(jobId);
    }
  }

  // ── /api/jobs — job creation + public signed records ──

  /** POST /api/jobs — create a pending job. Gated by the coordinator admin
   *  bearer OR a valid open NEAR market_id (the market's escrow is the
   *  authorization — anyone funding a market may submit work for it). */
  private async handleJobPost(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as JobPostBody | null;
    if (!body) return this.json({ error: "json body required" }, 400);
    const taskType = Number(body.taskType);
    if (!Number.isInteger(taskType) || normalizeTaskTypes([taskType])[0] !== taskType) {
      return this.json({ error: "taskType must be a registered range integer" }, 400);
    }
    if (typeof body.payload !== "string" || !body.payload.length) {
      return this.json({ error: "payload required" }, 400);
    }
    const maxBytes = Number(this.env.MAX_PAYLOAD_BYTES || "8192");
    if (new TextEncoder().encode(body.payload).length > maxBytes) {
      return this.json({ error: `payload exceeds ${maxBytes} bytes` }, 413);
    }

    const admin = this.bearerOk(req, this.env.COORDINATOR_ADMIN || this.env.ADMIN_TOKEN);
    let marketOk = false;
    const marketId = typeof body.market_id === "string" ? body.market_id.slice(0, 128) : undefined;
    if (!admin && marketId) {
      const m = await getMarket(this.env, marketId);
      marketOk = !!m && m.status === "open";
    }
    if (!admin && !marketOk) return this.json({ error: "unauthorized" }, 401);

    const jobId = `job-${crypto.randomUUID()}`;
    const replicas = Math.min(Math.max(Math.round(Number(body.replicas ?? 1)) || 1, 1), MAX_REPLICAS);
    await this.state.storage.put(`pending:${jobId}`, {
      taskType,
      payload: body.payload,
      amountWei: body.amountWei || "0",
      source: "direct",
      market_id: marketId,
      replicas: replicas > 1 ? replicas : undefined,
      classification: body.classification === "INTERNAL" ? "INTERNAL" : "PUBLIC",
      difficulty: typeof body.difficulty === "number"
        ? Math.min(Math.max(Math.round(body.difficulty), 0), 3) : undefined,
      domain: typeof body.domain === "string" ? body.domain.slice(0, 32) : undefined,
      deadline: typeof body.deadline === "number" && body.deadline > 0
        ? Math.round(body.deadline) : undefined,
      since: Date.now(),
    } satisfies PendingJob);
    void this.audit("job.submit", { jobId, taskType, marketId, replicas, admin });
    return this.json({ jobId });
  }

  /** GET /api/jobs/:id — the public, HMAC-signed job record. The bridge's
   *  claim validation recomputes `sig` over the canonical record to verify
   *  coordinator provenance; sig is null when no secret is configured
   *  (dev mode — the record is then unattested). */
  private async handleJobGet(jobId: string): Promise<Response> {
    const [job, handled, jobRec, tally, flag] = await Promise.all([
      this.state.storage.get<PendingJob>(`pending:${jobId}`),
      this.state.storage.get(`handled:${jobId}`),
      this.state.storage.get<JobRecord>(`job:${jobId}`),
      this.state.storage.get<TallyRecord>(`tally:${jobId}`),
      this.state.storage.get(`jobflag:${jobId}`),
    ]);
    const result = (await this.state.storage.get(`result:${jobId}`)) as
      | { volunteerId?: string; result?: string; result_sig?: string | null;
          results?: Record<string, string>; agreement?: boolean | null }
      | undefined;
    if (!job && !jobRec && !result && !tally && handled === undefined) {
      return this.json({ error: "not found" }, 404);
    }

    const assigned = (await this.state.storage.get(`assigned:${jobId}`)) as
      | { volunteerId: string } | undefined;
    const replicaAssigned = await this.keys(`assigned:${jobId}:`);

    let status: "pending" | "assigned" | "done" | "failed";
    if (jobRec?.status === "done" || handled === 1) status = "done";
    else if (jobRec?.status === "failed" || typeof handled === "string") status = "failed";
    else if (assigned || replicaAssigned.length) status = "assigned";
    else status = "pending";

    // Results — single jobs carry one record at result:<id>; replica jobs
    // aggregate {results: {volId: result}} plus per-volunteer detail rows.
    const results: { volunteer: string; did: string | null; result: string; result_sig: string | null }[] = [];
    if (result?.results) {
      for (const [vid, r] of Object.entries(result.results)) {
        const detail = (await this.state.storage.get(`result:${jobId}:${vid}`)) as
          | { result_sig?: string | null } | undefined;
        results.push({
          volunteer: vid,
          did: (await this.state.storage.get(`didbind:${vid}`)) as string | undefined ?? null,
          result: r,
          result_sig: detail?.result_sig ?? null,
        });
      }
    } else if (result?.volunteerId) {
      results.push({
        volunteer: result.volunteerId,
        did: (await this.state.storage.get(`didbind:${result.volunteerId}`)) as string | undefined ?? null,
        result: result.result ?? "",
        result_sig: result.result_sig ?? null,
      });
    }

    const challenges: { nonce: string; ok: boolean | null; issued_at: number }[] = [];
    for (const key of await this.keys(`challenge:${jobId}:`)) {
      const c = (await this.state.storage.get(key)) as ChallengeRecord | undefined;
      if (c) challenges.push({ nonce: c.nonce, ok: c.ok, issued_at: c.issued_at });
    }
    challenges.sort((a, b) => a.issued_at - b.issued_at);

    const record: Record<string, unknown> = {
      jobId,
      taskType: jobRec?.taskType ?? job?.taskType ?? 0,
      status,
      market_id: jobRec?.market_id ?? job?.market_id ?? null,
      results,
      tally: {
        required: tally?.required ?? job?.replicas ?? 1,
        agreement: tally?.agreement ?? result?.agreement ?? null,
        comparison: tally?.comparison
          ?? (job && DETERMINISTIC_TASKS.has(job.taskType) ? "equality" : null),
      },
      challenges: challenges.map((c) => ({ nonce: c.nonce, ok: c.ok })),
      flag: flag ?? null,
      issued_at: job?.since ?? null,
      completed_at: jobRec?.completed_at ?? null,
    };

    // HMAC provenance — recomputable by anyone holding the shared secret;
    // the bridge verifies coordinator-issued work before crediting escrow.
    const secret = this.env.COORDINATOR_SECRET || this.env.ATTEST_SECRET || this.env.ADMIN_TOKEN;
    record.sig = secret
      ? `hmac-sha256:${await this.hmacHex(secret, canonicalJson(record))}`
      : null;
    return this.json(record);
  }

  // ── Metered-work receipts (runner gossip → verifiable store) ──

  /** POST /receipts — a runner's signed metered-work receipt. The receipt's
   *  id is sha256 over the canonical body (minus id/pubkey/sig fields); the
   *  Ed25519 sig covers `widespread-receipt:<id>` under the embedded pubkey.
   *  Verified receipts are stored verbatim at receipt:<id> and indexed by
   *  publisher pubkey; unverifiable ones are rejected — a stored receipt is
   *  always a *checked* receipt. */
  private async handleReceiptPost(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return this.json({ error: "json body required" }, 400);
    if (JSON.stringify(body).length > MAX_RESULT_BYTES) {
      return this.json({ error: "receipt too large" }, 413);
    }
    const { id, sig, pubkey, signature, ...rest } = body as {
      id?: string; sig?: string; pubkey?: string; signature?: string;
      [k: string]: unknown;
    };
    void signature; // alternate field name — excluded from the hashed body either way
    const computedId = await this.sha256Hex(canonicalJson(rest));
    if (id && id !== computedId) return this.json({ error: "id mismatch" }, 400);
    const receiptId = id ?? computedId;
    if (typeof pubkey !== "string" || typeof sig !== "string") {
      return this.json({ error: "unsigned receipt" }, 400);
    }
    const pub = this.hexToBytes(pubkey);
    const sigBytes = this.hexToBytes(sig);
    if (!pub || pub.length !== 32 || !sigBytes || sigBytes.length !== 64) {
      return this.json({ error: "bad pubkey or sig encoding" }, 400);
    }
    let ok = false;
    try {
      const key = await crypto.subtle.importKey(
        "raw", pub as BufferSource, "Ed25519", false, ["verify"]);
      ok = await crypto.subtle.verify(
        "Ed25519", key, sigBytes as BufferSource,
        new TextEncoder().encode(`widespread-receipt:${receiptId}`) as BufferSource);
    } catch { ok = false; }
    if (!ok) return this.json({ error: "bad signature" }, 400);

    const stored = { ...rest, id: receiptId, pubkey, sig };
    await this.state.storage.put(`receipt:${receiptId}`, stored);
    // Publisher index — list receipts a node has submitted.
    await this.state.storage.put(`receipt:pub:${pubkey}:${receiptId}`, Date.now());
    void this.audit("receipt.submit", { id: receiptId, pubkey });
    return this.json({ ok: true, id: receiptId });
  }

  /** GET /receipts/:id — return a stored receipt (verified at intake). */
  private async handleReceiptGet(id: string): Promise<Response> {
    const receipt = await this.state.storage.get(`receipt:${id}`);
    if (!receipt) return this.json({ error: "not found" }, 404);
    return this.json(receipt);
  }

  // ── Resource offers + request sessions ──

  /** Verify a signed offer: canonical-body id, ed25519 sig over
   *  `widespread-offer:<id>`, and the signing pubkey must derive to the
   *  claimed node_did. Returns the unsigned offer fields or an error. */
  private async verifyOffer(raw: unknown): Promise<{ offer?: Offer; error?: string }> {
    if (!raw || typeof raw !== "object") return { error: "offer must be an object" };
    const o = raw as OfferPostBody & { id?: string; pubkey?: string; sig?: string };
    const { id, sig, pubkey, ...body } = o as Record<string, unknown>;
    for (const f of ["node_did", "network", "kind", "unit"]) {
      if (typeof body[f] !== "string" || !(body[f] as string).length) {
        return { error: `offer.${f} required` };
      }
    }
    // Price arrives as a JSON number from the runner (or a numeric string
    // from hand-built offers) — both are fine; canonical-id covers the raw
    // value either way.
    const priceNum = Number(body.price_near_per_unit);
    if (!Number.isFinite(priceNum) || priceNum < 0 ||
        (typeof body.price_near_per_unit !== "number" && typeof body.price_near_per_unit !== "string")) {
      return { error: "offer.price_near_per_unit must be a non-negative number" };
    }
    if (!["compute", "inference", "storage", "bandwidth"].includes(body.kind as string)) {
      return { error: "offer.kind must be compute|inference|storage|bandwidth" };
    }
    if (typeof pubkey !== "string" || typeof sig !== "string") {
      return { error: "unsigned offer" };
    }
    const pub = this.hexToBytes(pubkey);
    const sigBytes = this.hexToBytes(sig);
    if (!pub || pub.length !== 32 || !sigBytes || sigBytes.length !== 64) {
      return { error: "bad pubkey or sig encoding" };
    }
    if (didKeyFromPublicKey(pub) !== body.node_did) {
      return { error: "pubkey does not match node_did" };
    }
    const computedId = await this.sha256Hex(canonicalJson(body));
    if (id && id !== computedId) return { error: "offer id mismatch" };
    let ok = false;
    try {
      const key = await crypto.subtle.importKey("raw", pub as BufferSource, "Ed25519", false, ["verify"]);
      ok = await crypto.subtle.verify("Ed25519", key, sigBytes as BufferSource,
        new TextEncoder().encode(`widespread-offer:${computedId}`) as BufferSource);
    } catch { ok = false; }
    if (!ok) return { error: "bad signature" };
    return { offer: {
      id: computedId,
      node_did: body.node_did as string,
      node: "",
      network: body.network as string,
      kind: body.kind as string,
      unit: body.unit as string,
      price_near_per_unit: String(body.price_near_per_unit),
      quota_max: Number.isFinite(Number(body.quota_max)) ? Number(body.quota_max) : 0,
      endpoint_hint: typeof body.endpoint_hint === "string" ? body.endpoint_hint.slice(0, 256) : null,
      terms: typeof body.terms === "string" ? body.terms.slice(0, 500) : null,
      tee: body.tee === true,
      issued_at: Number.isFinite(Number(body.issued_at)) ? Number(body.issued_at) : Date.now(),
      pubkey, sig,
    } };
  }

  /** Replace a node's offer set with freshly verified signed offers. */
  private async storeOffers(nodeId: string, did: string | null, rawOffers: unknown[]) {
    await this.removeOffersFor(nodeId);
    let stored = 0;
    for (const raw of rawOffers) {
      const { offer, error } = await this.verifyOffer(raw);
      if (!offer) { void this.audit("offer.rejected", { node: nodeId, error }); continue; }
      // A node presenting a did:key DID must sign offers under that exact
      // key — otherwise offers are just bound to this connection's identity.
      if (did && did.startsWith("did:key:") && offer.node_did !== did) {
        void this.audit("offer.rejected", { node: nodeId, error: "node_did mismatch" });
        continue;
      }
      offer.node = nodeId;
      await this.state.storage.put(`offer:${nodeId}:${offer.id}`, offer);
      stored++;
    }
    if (stored) void this.audit("offer.publish", { node: nodeId, count: stored });
  }

  private async removeOffersFor(nodeId: string) {
    for (const key of await this.keys(`offer:${nodeId}:`)) {
      await this.state.storage.delete(key);
    }
  }

  // ── Surface adapter registry ──

  private adapterKey(id: string): string { return `adapter:${id}`; }

  private async getAdapter(id: string): Promise<AdapterRecord | null> {
    return (await this.state.storage.get(this.adapterKey(id))) as AdapterRecord | undefined ?? null;
  }

  private async listAdapters(): Promise<AdapterRecord[]> {
    const out: AdapterRecord[] = [];
    for (const key of await this.keys("adapter:")) {
      const r = (await this.state.storage.get(key)) as AdapterRecord | undefined;
      if (r?.manifest) out.push(r);
    }
    return out;
  }

  /** GET /api/adapters — catalog query. Ranked by verified-op count (the
   *  honesty signal), then recency. Filters: surface, kind, status, q. */
  private async handleAdaptersList(url: URL): Promise<Response> {
    const surface = url.searchParams.get("surface")?.toLowerCase();
    const kind = url.searchParams.get("kind");
    const status = url.searchParams.get("status");
    const q = url.searchParams.get("q")?.toLowerCase();
    let recs = await this.listAdapters();
    if (surface) recs = recs.filter((r) => r.manifest.surface === surface || r.manifest.surface.endsWith(`.${surface}`));
    if (kind) recs = recs.filter((r) => r.manifest.kind === kind);
    if (status) recs = recs.filter((r) => effectiveStatus(r) === status);
    if (q) recs = recs.filter((r) =>
      r.manifest.surface.includes(q) || r.manifest.author.includes(q) ||
      r.manifest.ops.some((o) => o.name.includes(q)));
    recs.sort((a, b) =>
      verifiedOpCount(b.manifest) - verifiedOpCount(a.manifest) ||
      b.manifest.issued_at - a.manifest.issued_at ||
      a.manifest.id.localeCompare(b.manifest.id));
    return this.json({
      adapters: recs.slice(0, 500).map((r) => ({
        ...r.manifest, status: effectiveStatus(r),
        meta: { ...r.meta, verified_ops: verifiedOpCount(r.manifest) },
      })),
    });
  }

  /** GET /api/adapters/stats — live coverage metrics: the honest answer to
   *  "how many surfaces can you actually act on?" */
  private async handleAdapterStats(): Promise<Response> {
    const recs = await this.listAdapters();
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const surfaces = new Set<string>();
    let ops = 0, verifiedOps = 0;
    for (const r of recs) {
      const s = effectiveStatus(r);
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      byKind[r.manifest.kind] = (byKind[r.manifest.kind] ?? 0) + 1;
      surfaces.add(r.manifest.surface);
      ops += r.manifest.ops.length;
      verifiedOps += verifiedOpCount(r.manifest);
    }
    return this.json({
      adapters: recs.length, surfaces: surfaces.size, ops, verified_ops: verifiedOps,
      by_status: byStatus, by_kind: byKind,
    });
  }

  private async handleAdapterGet(id: string): Promise<Response> {
    const rec = await this.getAdapter(id);
    if (!rec) return this.json({ error: "adapter not found" }, 404);
    return this.json({ ...rec.manifest, status: effectiveStatus(rec), meta: rec.meta });
  }

  /** POST /api/adapters — publish a signed manifest. Dedupes by id;
   *  links `supersedes` chains. The manifest signature is the only
   *  admission requirement — the registry is advisory, clients re-probe
   *  before trusting `verified` claims. */
  private async handleAdapterPost(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as unknown;
    if (!body) return this.json({ error: "json body required" }, 400);
    const res = await verifyAdapterManifest(body);
    if (!res.ok) return this.json({ error: res.error ?? "invalid manifest" }, 400);
    const manifest = res.manifest;

    const existing = await this.getAdapter(manifest.id);
    if (existing) {
      return this.json({ ok: true, id: manifest.id, deduped: true });
    }
    const rec: AdapterRecord = {
      manifest,
      meta: {
        status: null, superseded_by: null, imports: 1, invocations: 0,
        verify_ok: 0, verify_fail: 0, last_report_at: null, bounty_posted: false,
      },
    };
    await this.state.storage.put(this.adapterKey(manifest.id), rec);
    if (manifest.supersedes) {
      const old = await this.getAdapter(manifest.supersedes);
      if (old && !old.meta.superseded_by) {
        old.meta.superseded_by = manifest.id;
        await this.state.storage.put(this.adapterKey(old.manifest.id), old);
      }
    }
    void this.audit("adapter.publish", {
      id: manifest.id, surface: manifest.surface, kind: manifest.kind,
      author: manifest.author, supersedes: manifest.supersedes ?? null,
      verified_ops: verifiedOpCount(manifest),
    });
    return this.json({ ok: true, id: manifest.id });
  }

  /** POST /api/adapters/:id/report — client telemetry: invoke / verify_ok /
   *  verify_fail / import. Repeated verify failures degrade the effective
   *  status to deprecated and post a regeneration bounty to the feed —
   *  adapter decay becomes paid work instead of silent breakage. */
  private async handleAdapterReport(id: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as
      | { event?: string; op?: string } | null;
    if (!body?.event) return this.json({ error: "event required" }, 400);
    const rec = await this.getAdapter(id);
    if (!rec) return this.json({ error: "adapter not found" }, 404);
    const m = rec.meta;
    m.last_report_at = Date.now();
    switch (body.event) {
      case "import": m.imports++; break;
      case "invoke": m.invocations++; break;
      case "verify_ok": m.verify_ok++; break;
      case "verify_fail": m.verify_fail++; break;
      default: return this.json({ error: "event must be import|invoke|verify_ok|verify_fail" }, 400);
    }
    // Auto-degrade: ≥5 cumulative verify failures and the adapter is
    // effectively broken in the wild. The signed manifest stays intact —
    // only the registry's effective status moves.
    if (m.verify_fail >= 5 && m.status !== "deprecated") {
      m.status = "deprecated";
      await this.postAdapterBounty(rec, "auto-degrade: ≥5 verify failures");
    }
    await this.state.storage.put(this.adapterKey(id), rec);
    return this.json({ ok: true, status: effectiveStatus(rec), meta: m });
  }

  /** POST /api/adapters/:id/deprecate — explicit deprecation. Author or
   *  admin only; emits the regeneration bounty once. */
  private async handleAdapterDeprecate(id: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as
      | { reason?: string; author?: string } | null;
    const rec = await this.getAdapter(id);
    if (!rec) return this.json({ error: "adapter not found" }, 404);
    const admin = this.bearerOk(req, this.env.COORDINATOR_ADMIN || this.env.ADMIN_TOKEN);
    if (!admin && body?.author !== rec.manifest.author) {
      return this.json({ error: "unauthorized — author did:key or admin required" }, 401);
    }
    if (rec.meta.status !== "deprecated") {
      rec.meta.status = "deprecated";
      await this.postAdapterBounty(rec, body?.reason ?? "explicit deprecation");
    }
    await this.state.storage.put(this.adapterKey(id), rec);
    return this.json({ ok: true, status: "deprecated" });
  }

  /** Write a regeneration opportunity into the declared-feed lane — the
   *  protocol's own labor market maintains its adapter catalog. Deduped
   *  per adapter via bounty_posted. */
  private async postAdapterBounty(rec: AdapterRecord, reason: string): Promise<void> {
    if (rec.meta.bounty_posted) return;
    rec.meta.bounty_posted = true;
    const short = rec.manifest.id.slice(0, 12);
    const hash = `adapter-regen:${rec.manifest.surface}:${short}`;
    const record: FeedRecord = {
      id: hash,
      source: "adapter-registry",
      forge: "generic",
      kind: "bounty",
      title: `Regenerate widespread adapter for ${rec.manifest.surface} (${rec.manifest.kind})`,
      spec: [
        `Adapter ${rec.manifest.id} for ${rec.manifest.surface} is deprecated (${reason}).`,
        `Inspect the surface with REA (@morluto/rea) or browser capture, then publish a`,
        `superseding widespread-adapter/1 manifest via POST /api/adapters.`,
        `Ops must carry side-effect-asserting verify metadata; verified ops need probe evidence.`,
        `Old manifest: GET /api/adapters/${rec.manifest.id}`,
      ].join("\n"),
      escrow: { state: "label-only" },
      verification: { required: "adapter-reprobe", spec_hash: hash },
      url: `https://widespread.fyi/api/adapters/${rec.manifest.id}`,
      claim: {
        how: `submit superseding manifest (supersedes: ${rec.manifest.id}) via POST /api/adapters, then POST /api/claims`,
        grammar: `widespread claim ${hash}`,
      },
      domain: "other",
      deliverable_class: "publish",
      execution: {
        recommended: "browser-tab + REA inspection",
        isolation: "client-side",
        alternatives: ["self-hosted sealed runner"],
        note: "adapter manifests are declarative HTTP only — no code execution",
      },
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await this.env.CLAIMS.put(`feedrec:decl:${record.id}`, JSON.stringify(record));
    void this.audit("adapter.regen-bounty", { adapter: rec.manifest.id, surface: rec.manifest.surface, reason });
  }

  private async findOffer(id: string): Promise<Offer | null> {
    for (const key of await this.keys("offer:")) {
      const o = (await this.state.storage.get(key)) as Offer | undefined;
      if (o?.id === id) return o;
    }
    return null;
  }

  private async listOffers(): Promise<Offer[]> {
    const out: Offer[] = [];
    for (const key of await this.keys("offer:")) {
      const o = (await this.state.storage.get(key)) as Offer | undefined;
      if (o) out.push(o);
    }
    return out;
  }

  /** Per-node ranking inputs — all coordinator-measured (rep ledger,
   *  canary trust, challenge RTT). Nodes can't inflate rank by self-report. */
  private async nodeStats(node: string): Promise<{ rep: number; trust: number; benchRttMs: number | null }> {
    const rep = (await this.state.storage.get(`rep:${node}`)) as { points?: number } | undefined;
    const meta = this.registry.get(node);
    const bench = (await this.state.storage.get(`bench:${node}`)) as
      | { count?: number; total_rtt_ms?: number } | undefined;
    return {
      rep: rep?.points ?? 0,
      trust: meta?.trust ?? 0,
      benchRttMs: bench?.count ? Math.round((bench.total_rtt_ms ?? 0) / bench.count) : null,
    };
  }

  /** Deterministic, auditable ranking: lowest price first, then reputation,
   *  then coordinator-measured challenge latency. `score` is attached so the
   *  ranking is explainable, not a black box. */
  private async rankOffers(offers: Offer[]): Promise<(Offer & { score: Record<string, number | null> })[]> {
    const scored = [];
    for (const o of offers) {
      const st = await this.nodeStats(o.node);
      scored.push({
        ...o,
        score: {
          price: Number(o.price_near_per_unit),
          rep: st.rep,
          trust: st.trust,
          bench_rtt_ms: st.benchRttMs,
        },
      });
    }
    scored.sort((a, b) =>
      a.score.price! - b.score.price! ||
      b.score.rep! - a.score.rep! ||
      b.score.trust! - a.score.trust! ||
      (a.score.bench_rtt_ms ?? Infinity) - (b.score.bench_rtt_ms ?? Infinity) ||
      a.node.localeCompare(b.node));
    return scored;
  }

  private async handleOffersList(url: URL): Promise<Response> {
    const kind = url.searchParams.get("kind");
    const network = url.searchParams.get("network");
    const node = url.searchParams.get("node");
    let offers = await this.listOffers();
    if (kind) offers = offers.filter((o) => o.kind === kind);
    if (network) offers = offers.filter((o) => o.network === network);
    if (node) offers = offers.filter((o) => o.node === node);
    // Only offers from currently-connected nodes can actually serve.
    offers = offers.filter((o) => this.registry.has(o.node));
    const ranked = await this.rankOffers(offers);
    return this.json({ offers: ranked.slice(0, 500) });
  }

  private async handleOfferStats(): Promise<Response> {
    const offers = (await this.listOffers()).filter((o) => this.registry.has(o.node));
    const byKey: Record<string, { count: number; prices: number[] }> = {};
    for (const o of offers) {
      const k = `${o.kind}:${o.unit}`;
      const p = Number(o.price_near_per_unit);
      if (!Number.isFinite(p)) continue;
      (byKey[k] ??= { count: 0, prices: [] }).count++;
      byKey[k].prices.push(p);
    }
    const stats: Record<string, { count: number; min: number; max: number; avg: number }> = {};
    for (const [k, v] of Object.entries(byKey)) {
      v.prices.sort((a, b) => a - b);
      stats[k] = {
        count: v.count,
        min: v.prices[0],
        max: v.prices[v.prices.length - 1],
        avg: Math.round(v.prices.reduce((a, b) => a + b, 0) / v.prices.length * 1e6) / 1e6,
      };
    }
    return this.json({ offers: offers.length, price_index: stats });
  }

  /** POST /api/offers — publish a signed offer outside the WS path. The
   *  offering node must be registered AND currently connected (its DID must
   *  match offer.node_did). */
  private async handleOfferPost(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as OfferPostBody | null;
    if (!body) return this.json({ error: "json body required" }, 400);
    const { offer, error } = await this.verifyOffer(body);
    if (!offer) return this.json({ error: error ?? "invalid offer" }, 400);
    const node = [...this.registry.values()].find((v) => v.did === offer.node_did);
    if (!node) return this.json({ error: "offering node not connected" }, 409);
    offer.node = node.id;
    await this.state.storage.put(`offer:${node.id}:${offer.id}`, offer);
    void this.audit("offer.publish", { node: node.id, offerId: offer.id, via: "http" });
    return this.json({ ok: true, offerId: offer.id });
  }

  private async routeSpec(spec: NonNullable<RequestPostBody["spec"]>): Promise<Offer[]> {
    let offers = await this.listOffers();
    if (spec.kind) offers = offers.filter((o) => o.kind === spec.kind);
    if (spec.network) offers = offers.filter((o) => o.network === spec.network);
    offers = offers.filter((o) => this.registry.has(o.node));
    const maxPrice = Number(spec.max_price_near_per_unit);
    if (Number.isFinite(maxPrice)) offers = offers.filter((o) => Number(o.price_near_per_unit) <= maxPrice);
    if (spec.min_rep !== undefined) {
      const minRep = Number(spec.min_rep);
      const kept: Offer[] = [];
      for (const o of offers) {
        const st = await this.nodeStats(o.node);
        if (st.rep >= minRep) kept.push(o);
      }
      offers = kept;
    }
    const ranked = await this.rankOffers(offers);
    return ranked.map(({ score: _score, ...o }) => o);
  }

  /** POST /api/requests — open a resource session. Funding in phase 1 is a
   *  funded open NEAR market (market_id); x402/AP2 land in phase 3. The
   *  request blocks until the first candidate node accepts (raced) or the
   *  open timeout elapses. */
  private async handleRequestPost(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as RequestPostBody | null;
    if (!body) return this.json({ error: "json body required" }, 400);
    const admin = this.bearerOk(req, this.env.COORDINATOR_ADMIN || this.env.ADMIN_TOKEN);

    // Resolve candidates first — x402 requirements quote the chosen offer.
    let candidates: Offer[] = [];
    if (body.offer_id) {
      const o = await this.findOffer(body.offer_id.slice(0, 128));
      if (!o) return this.json({ error: "offer not found" }, 404);
      candidates = [o];
    } else if (body.spec) {
      candidates = await this.routeSpec(body.spec);
      if (!candidates.length) return this.json({ error: "no offer matches spec" }, 404);
    } else {
      return this.json({ error: "offer_id or spec required" }, 400);
    }

    const online = candidates.filter((o) => this.wsFor(o.node));
    if (!online.length) return this.json({ error: "no candidate node online" }, 409);

    const raced = Math.min(Math.max(Math.round(Number(body.raced ?? 1)) || 1, 1), MAX_REPLICAS);
    const chosen: Offer[] = [];
    const seenNodes = new Set<string>();
    for (const o of online) {
      if (seenNodes.has(o.node)) continue;
      seenNodes.add(o.node);
      chosen.push(o);
      if (chosen.length >= raced) break;
    }
    const primary = chosen[0];
    const quota = Number.isFinite(Number(body.quota)) ? Number(body.quota) : null;

    // ── Funding ── market escrow | x402 exact payment | admin (dev).
    // An AP2 mandate (body.mandate) is an *authorization artifact* recorded
    // on any funded session — it is not itself a funding source.
    let funding: SessionRecord["funding"];
    let marketPayer: string | undefined;
    let x402Payer: string | undefined;
    const marketId = typeof body.market_id === "string" ? body.market_id.slice(0, 128) : undefined;
    if (marketId) {
      const m = await getMarket(this.env, marketId);
      if (!m || m.status !== "open") return this.json({ error: "market not open" }, 402);
      funding = { type: "market", market_id: marketId };
      marketPayer = typeof m.payer === "string" ? m.payer : undefined;
    } else if (body.payment !== undefined && body.payment !== null) {
      const requirements = sessionRequirements(this.env, primary, quota ?? 1,
        `${req.url}`);
      if (!requirements) {
        return this.json({ error: "x402 rail not configured or unquotable" }, 503);
      }
      const verdict = await verifySessionPayment(this.env, body.payment, requirements);
      if (!verdict.ok) {
        return this.json({ error: `payment rejected: ${verdict.reason}` }, 402);
      }
      const ref = await this.sha256Hex(canonicalJson(body.payment));
      funding = { type: "x402", ref, payer: verdict.payer };
      x402Payer = verdict.payer;
      void this.audit("session.x402.verified", { ref, payer: verdict.payer });
    } else if (admin) {
      funding = { type: "market", market_id: marketId };
    } else {
      // unpaid → proper x402 PAYMENT-REQUIRED when the rail is live
      const requirements = sessionRequirements(this.env, primary, quota ?? 1, `${req.url}`);
      if (requirements) {
        return this.json(paymentRequiredBody(requirements, `${req.url}`), 402);
      }
      return this.json({ error: "funding required: market_id escrow or x402 payment" }, 401);
    }

    // AP2 mandate — structural check always; signature verification when
    // AP2_TRUSTED_ISSUERS is configured. Malformed → 400; valid-but-
    // unverified → advisory ref on the session (never a funding source).
    if (body.mandate !== undefined && body.mandate !== null) {
      const m = await checkMandate(this.env, body.mandate,
        (s) => this.sha256Hex(s));
      if (!m.ok) return this.json({ error: m.reason ?? "invalid mandate" }, 400);
      funding.mandate_ref = m.ref;
      if (m.verified) void this.audit("session.mandate.verified", { ref: m.ref });
    }

    // SIWX — optional wallet-signed requester auth binds `requester` to a
    // verified EVM address (overrides the self-declared field).
    let siwxAddress: string | undefined;
    if (body.siwx !== undefined && body.siwx !== null) {
      const domain = new URL(req.url).host;
      const v = await verifySiwx(body.siwx as SiwxAuth, domain);
      if (!v.ok) return this.json({ error: `siwx: ${v.reason}` }, 401);
      siwxAddress = v.address;
    }

    // Budget ledger — one market funds at most MAX_SESSIONS_PER_MARKET
    // concurrent sessions. Amount-unit math is deferred (market amount is
    // not safely NEAR-denominated); the claim path settles actual delivered
    // units, and this cap bounds exposure per escrow.
    if (marketId) {
      const reserved = ((await this.state.storage.get(`reserved:${marketId}`)) || {}) as Record<string, number>;
      if (Object.keys(reserved).length >= MAX_SESSIONS_PER_MARKET && !admin) {
        return this.json({ error: `market session cap (${MAX_SESSIONS_PER_MARKET}) reached` }, 409);
      }
    }

    const sessionId = `sess-${crypto.randomUUID()}`;
    const requester = siwxAddress
      || (typeof body.requester === "string" ? body.requester.slice(0, 128) : "")
      || marketPayer || x402Payer || "anonymous";
    const deadlineSecs = Number(body.deadline_secs ?? body.spec?.deadline_secs ?? 0);
    const deadline = deadlineSecs > 0 ? Math.floor(Date.now() / 1000) + Math.floor(deadlineSecs) : undefined;
    const session: SessionRecord = {
      id: sessionId,
      offer_id: primary.id,
      node: "",
      node_did: primary.node_did,
      requester,
      kind: primary.kind,
      network: primary.network,
      unit: primary.unit,
      price_near_per_unit: primary.price_near_per_unit,
      quota,
      quota_unit: primary.unit,
      used: {},
      calls: 0,
      funding,
      status: "opening",
      opened_at: Date.now(),
      deadline,
      upstream_refs: [],
      pending_nodes: chosen.map((o) => o.node),
    };
    await this.state.storage.put(`sess:${sessionId}`, session);
    if (marketId) {
      const reserved = ((await this.state.storage.get(`reserved:${marketId}`)) || {}) as Record<string, number>;
      reserved[sessionId] = quota ?? 0;
      await this.state.storage.put(`reserved:${marketId}`, reserved);
    }

    for (const o of chosen) {
      const ws = this.wsFor(o.node);
      ws?.send(JSON.stringify({
        type: "SESSION_OPEN", sessionId, offer: o,
        requester, quota, quota_unit: o.unit, deadline, market_id: marketId,
        params: body.params ?? null,
      }));
    }
    void this.audit("session.open", { sessionId, marketId, raced: chosen.length });

    const winner = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(sessionId);
        resolve(null);
      }, SESSION_OPEN_TIMEOUT_MS);
      this.pendingOpens.set(sessionId, { resolve, timer });
    });

    if (!winner) {
      session.status = "failed";
      session.close_reason = "no-accept";
      session.closed_at = Date.now();
      await this.state.storage.put(`sess:${sessionId}`, session);
      if (marketId) await this.releaseReservation(marketId, sessionId);
      return this.json({ error: "no candidate accepted the session" }, 409);
    }

    session.status = "open";
    session.node = winner;
    session.pending_nodes = [];
    await this.state.storage.put(`sess:${sessionId}`, session);
    return this.json({ session: await this.publicSession(session), candidates: chosen.map((o) => ({ offer: o.id, node: o.node })) }, 201);
  }

  private async handleRequestGet(id: string): Promise<Response> {
    const session = (await this.state.storage.get(`sess:${id}`)) as SessionRecord | undefined;
    if (!session) return this.json({ error: "not found" }, 404);
    return this.json({ session: await this.publicSession(session) });
  }

  private async handleRequestCall(id: string, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as CallPostBody | null;
    if (!body || typeof body.op !== "string" || !body.op.length) {
      return this.json({ error: "op required" }, 400);
    }
    if (JSON.stringify(body.params ?? null).length > MAX_CALL_PARAMS_BYTES) {
      return this.json({ error: "params too large" }, 413);
    }
    const session = (await this.state.storage.get(`sess:${id}`)) as SessionRecord | undefined;
    if (!session) return this.json({ error: "not found" }, 404);
    if (session.status !== "open") return this.json({ error: `session ${session.status}` }, 409);
    const ws = this.wsFor(session.node);
    if (!ws) return this.json({ error: "serving node offline" }, 409);
    const seq = session.calls + 1;
    session.calls = seq;
    await this.state.storage.put(`sess:${id}`, session);

    const key = `${id}:${seq}`;
    const callStart = Date.now();
    const reply = await new Promise<{ ok: boolean; result?: unknown; error?: string; units?: Record<string, number>; cumulative?: Record<string, number>; upstream_refs?: string[] }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(key);
        resolve({ ok: false, error: "call timeout" });
      }, SESSION_CALL_TIMEOUT_MS);
      this.pendingCalls.set(key, { resolve, timer });
      ws.send(JSON.stringify({
        type: "SESSION_CALL", sessionId: id, seq,
        op: body.op, params: body.params ?? {},
      }));
    });
    // Coordinator-measured call latency feeds offer ranking (bench_rtt_ms)
    // — a node can't inflate its rank by self-reporting speed.
    if (reply.ok) await this.recordBench(session.node, Date.now() - callStart);
    if (!reply.ok) return this.json({ ok: false, seq, error: reply.error ?? "call failed" }, 504);
    return this.json({
      ok: true, sessionId: id, seq,
      result: reply.result ?? null,
      units: reply.units ?? {},
      cumulative: reply.cumulative ?? session.used,
      upstream_refs: reply.upstream_refs ?? [],
    });
  }

  private async handleRequestClose(id: string, req: Request): Promise<Response> {
    const session = (await this.state.storage.get(`sess:${id}`)) as SessionRecord | undefined;
    if (!session) return this.json({ error: "not found" }, 404);
    if (session.status === "closed" || session.status === "failed" || session.status === "expired") {
      return this.json({ session: await this.publicSession(session) });
    }
    void req; // body optional — close is idempotent
    await this.finalizeSession(id, "requester");
    const updated = (await this.state.storage.get(`sess:${id}`)) as SessionRecord;
    return this.json({ session: await this.publicSession(updated) });
  }

  /** POST /api/requests/:id/ticks/:seq/ack|dispute — requester verdict on a
   *  metered tick. The session id is the bearer capability for now; SIWX
   *  wallet auth lands with the funding rails. */
  private async handleTickVerdict(id: string, seq: number, verdict: "ack" | "dispute", req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { requester?: string } | null;
    const session = (await this.state.storage.get(`sess:${id}`)) as SessionRecord | undefined;
    if (!session) return this.json({ error: "not found" }, 404);
    if (body?.requester && session.requester !== "anonymous" && body.requester !== session.requester) {
      return this.json({ error: "requester mismatch" }, 403);
    }
    const key = `sesstick:${id}:${seq}`;
    const tick = (await this.state.storage.get(key)) as SessionTick | undefined;
    if (!tick) return this.json({ error: "tick not found" }, 404);
    tick.acked = verdict === "ack" ? true : tick.acked;
    tick.disputed = verdict === "dispute" ? true : tick.disputed;
    await this.state.storage.put(key, tick);
    return this.json({ ok: true, seq, verdict });
  }

  // ── Session WS handlers ──

  private async onSessionAccepted(sessionId: string, nodeId: string, endpointHint?: string) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session) { this.sendTo(nodeId, { type: "SESSION_CLOSE", sessionId }); return; }
    if (session.status !== "opening" || !(session.pending_nodes ?? []).includes(nodeId)) {
      // Late/losing accept in a race — tell the node to stand down.
      this.sendTo(nodeId, { type: "SESSION_CLOSE", sessionId });
      return;
    }
    session.status = "open";
    session.node = nodeId;
    if (endpointHint) session.endpoint_hint = endpointHint;
    session.pending_nodes = (session.pending_nodes ?? []).filter((n) => n !== nodeId);
    await this.state.storage.put(`sess:${sessionId}`, session);
    // Losers stand down; the winner keeps the session.
    for (const loser of session.pending_nodes) {
      this.sendTo(loser, { type: "SESSION_CLOSE", sessionId });
    }
    const pending = this.pendingOpens.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingOpens.delete(sessionId);
      pending.resolve(nodeId);
    }
    void this.audit("session.accepted", { sessionId, node: nodeId });
  }

  private async onSessionRejected(sessionId: string, nodeId: string, reason?: string) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.status !== "opening") return;
    session.pending_nodes = (session.pending_nodes ?? []).filter((n) => n !== nodeId);
    if (session.pending_nodes.length === 0) {
      session.status = "failed";
      session.close_reason = `rejected: ${String(reason ?? "").slice(0, 120)}`;
      session.closed_at = Date.now();
      if (session.funding.market_id) await this.releaseReservation(session.funding.market_id, sessionId);
      const pending = this.pendingOpens.get(sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingOpens.delete(sessionId);
        pending.resolve(null);
      }
    }
    await this.state.storage.put(`sess:${sessionId}`, session);
  }

  private async onSessionResult(sessionId: string, nodeId: string, seq: number, env: JobEnvelope) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.status !== "open" || session.node !== nodeId) return;
    const key = `${sessionId}:${seq}`;
    const pending = this.pendingCalls.get(key);
    if (!pending) return; // late/duplicate result — idempotent
    clearTimeout(pending.timer);
    this.pendingCalls.delete(key);
    if (env.ok === false) {
      pending.resolve({ ok: false, error: typeof env.error === "string" ? env.error : "call failed" });
      return;
    }
    await this.applySessionUnits(sessionId, seq, env.units, env.cumulative, env.upstream_refs, env.sig ?? env.resultSig);
    // Session results arrive as objects (serve() output); JOB_RESULT uses a
    // JSON string. Handle both without double-parsing.
    let result: unknown = env.result ?? null;
    if (typeof result === "string") {
      try { result = JSON.parse(result); } catch { /* keep raw string */ }
    }
    pending.resolve({
      ok: true,
      result,
      units: env.units ?? {},
      cumulative: env.cumulative ?? {},
      upstream_refs: env.upstream_refs ?? [],
    });
    await this.maybeQuotaClose(sessionId);
  }

  private async onSessionTick(sessionId: string, nodeId: string, env: JobEnvelope) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.status !== "open" || session.node !== nodeId) return;
    const seq = Number.isInteger(env.seq) ? env.seq! : session.calls + 1;
    await this.applySessionUnits(sessionId, seq, env.units, env.cumulative, env.upstream_refs, env.sig ?? env.resultSig);
    await this.maybeQuotaClose(sessionId);
  }

  private async onSessionClosed(sessionId: string, nodeId: string, env: JobEnvelope) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.node !== nodeId) return;
    if (session.status !== "closed" && session.status !== "failed" && session.status !== "expired") {
      await this.finalizeSession(sessionId, typeof env.reason === "string" ? env.reason : "node-closed");
    }
  }

  /** Accumulate node-reported units into the session ledger + a signed tick
   *  record. Deltas are summed — a node can't rewrite history. */
  private async applySessionUnits(
    sessionId: string, seq: number,
    units: Record<string, number> | undefined,
    _cumulative: Record<string, number> | undefined,
    refs: string[] | undefined,
    sig: string | undefined,
  ) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session) return;
    const delta: Record<string, number> = {};
    for (const [k, v] of Object.entries(units ?? {})) {
      if (Number.isFinite(v) && v > 0) {
        delta[k] = v;
        session.used[k] = (session.used[k] ?? 0) + v;
      }
    }
    for (const r of refs ?? []) {
      if (typeof r === "string" && r.length <= 256 && !session.upstream_refs.includes(r)) {
        session.upstream_refs.push(r);
      }
    }
    await this.state.storage.put(`sess:${sessionId}`, session);
    const tick: SessionTick = {
      seq, at: Date.now(), units: delta,
      cumulative: { ...session.used },
      upstream_refs: refs ?? [], sig,
    };
    // Verify the node's tick signature when its DID is a did:key we can
    // decode — the runner signs
    //   widespread-tick:<sessionId>:<seq>:<sha256(JSON({sessionId,seq,units,cumulative}))>
    // Reconstructing with the *reported* cumulative (not our ledger) keeps
    // the signed bytes identical to what the node hashed.
    if (sig && session.node_did?.startsWith("did:key:")) {
      try {
        const body = JSON.stringify({
          sessionId, seq,
          units: units ?? {},
          cumulative: _cumulative ?? {},
        });
        const hash = await this.sha256Hex(body);
        const msg = `widespread-tick:${sessionId}:${seq}:${hash}`;
        tick.sig_ok = await verifyDidKey(session.node_did, msg, this.hexToBytes(sig) ?? new Uint8Array());
      } catch { tick.sig_ok = false; }
    }
    await this.state.storage.put(`sesstick:${sessionId}:${seq}`, tick);
    if (session.upstream_refs.length > 200) session.upstream_refs = session.upstream_refs.slice(-200);
    await this.state.storage.put(`sess:${sessionId}`, session);
  }

  private async maybeQuotaClose(sessionId: string) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.status !== "open" || session.quota == null || !session.quota_unit) return;
    if ((session.used[session.quota_unit] ?? 0) >= session.quota) {
      this.sendTo(session.node, { type: "SESSION_CLOSE", sessionId });
      await this.finalizeSession(sessionId, "quota");
    }
  }

  private async finalizeSession(sessionId: string, reason: string) {
    const session = (await this.state.storage.get(`sess:${sessionId}`)) as SessionRecord | undefined;
    if (!session || session.status === "closed" || session.status === "failed" || session.status === "expired") return;
    session.status = reason === "deadline" ? "expired" : "closed";
    session.close_reason = reason;
    session.closed_at = Date.now();
    await this.state.storage.put(`sess:${sessionId}`, session);
    if (session.funding.market_id) await this.releaseReservation(session.funding.market_id, sessionId);
    void this.audit("session.closed", { sessionId, reason, used: session.used });
  }

  private async releaseReservation(marketId: string, sessionId: string) {
    const reserved = ((await this.state.storage.get(`reserved:${marketId}`)) || {}) as Record<string, number>;
    if (sessionId in reserved) {
      delete reserved[sessionId];
      await this.state.storage.put(`reserved:${marketId}`, reserved);
    }
  }

  /** Node went away — fail its opening/open sessions and resolve waiters. */
  private async failNodeSessions(nodeId: string, reason: string) {
    for (const key of await this.keys("sess:")) {
      const s = (await this.state.storage.get(key)) as SessionRecord | undefined;
      if (!s || (s.status !== "opening" && s.status !== "open")) continue;
      const involved = s.node === nodeId || (s.pending_nodes ?? []).includes(nodeId);
      if (!involved) continue;
      s.pending_nodes = (s.pending_nodes ?? []).filter((n) => n !== nodeId);
      if (s.status === "opening" && s.node !== nodeId && s.pending_nodes.length > 0) continue;
      s.status = "failed";
      s.close_reason = reason;
      s.closed_at = Date.now();
      await this.state.storage.put(key, s);
      if (s.funding.market_id) await this.releaseReservation(s.funding.market_id, s.id);
      const po = this.pendingOpens.get(s.id);
      if (po) { clearTimeout(po.timer); this.pendingOpens.delete(s.id); po.resolve(null); }
      for (const [k, pc] of this.pendingCalls) {
        if (k.startsWith(`${s.id}:`)) { clearTimeout(pc.timer); this.pendingCalls.delete(k); pc.resolve({ ok: false, error: "node disconnected" }); }
      }
    }
  }

  /** Deadline sweep — sessions past `deadline` expire and release quota. */
  private async expireSessions() {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const key of await this.keys("sess:")) {
      const s = (await this.state.storage.get(key)) as SessionRecord | undefined;
      if (!s || (s.status !== "opening" && s.status !== "open")) continue;
      if (s.deadline && s.deadline < nowSec) {
        this.sendTo(s.node, { type: "SESSION_CLOSE", sessionId: s.id });
        await this.finalizeSession(s.id, "deadline");
      }
    }
  }

  /** Rolling call-latency stats per node — the bench signal in offer
   *  ranking. Only successful calls count; failures don't reward fast-fail. */
  private async recordBench(node: string, rttMs: number) {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 600000) return;
    const b = ((await this.state.storage.get(`bench:${node}`)) ||
      { count: 0, total_rtt_ms: 0, window_start: Date.now() }) as
      { count: number; total_rtt_ms: number; window_start: number };
    // Reset the window daily so stale latencies don't pin the average.
    if (Date.now() - b.window_start > 24 * 3600 * 1000) {
      b.count = 0; b.total_rtt_ms = 0; b.window_start = Date.now();
    }
    b.count++;
    b.total_rtt_ms += rttMs;
    await this.state.storage.put(`bench:${node}`, b);
  }

  private sendTo(volunteerId: string, msg: Record<string, unknown>) {
    const ws = this.wsFor(volunteerId);
    if (ws) ws.send(JSON.stringify(msg));
  }

  /** Public session record — used units, tick count, funding, upstream refs.
   *  Signed like job records so anyone can verify coordinator provenance. */
  private async publicSession(s: SessionRecord): Promise<Record<string, unknown>> {
    const ticks = await this.keys(`sesstick:${s.id}:`);
    const rec: Record<string, unknown> = {
      sessionId: s.id,
      offer_id: s.offer_id,
      node: s.node || null,
      node_did: s.node_did,
      requester: s.requester,
      kind: s.kind,
      network: s.network,
      unit: s.unit,
      price_near_per_unit: s.price_near_per_unit,
      quota: s.quota,
      quota_unit: s.quota_unit,
      used: s.used,
      calls: s.calls,
      funding: s.funding,
      status: s.status,
      close_reason: s.close_reason ?? null,
      opened_at: s.opened_at,
      closed_at: s.closed_at ?? null,
      deadline: s.deadline ?? null,
      ticks: ticks.length,
      upstream_refs: s.upstream_refs.slice(-50),
    };
    const secret = this.env.COORDINATOR_SECRET || this.env.ATTEST_SECRET || this.env.ADMIN_TOKEN;
    rec.sig = secret
      ? `hmac-sha256:${await this.hmacHex(secret, canonicalJson(rec))}`
      : null;
    return rec;
  }

  private hexToBytes(hex: string): Uint8Array | null {
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // ── Ledger + rep ──

  private async credit(volunteerId: string, amountWei: string, domain?: string) {
    const key = `ledger:${volunteerId}`;
    const led = ((await this.state.storage.get(key)) as
      | { totalWei: string; jobs: number; settledWei: string; claimant?: string }
      | undefined) ?? { totalWei: "0", jobs: 0, settledWei: "0" };
    led.totalWei = (BigInt(led.totalWei) + BigInt(amountWei || "0")).toString();
    led.jobs += 1;
    const claimant = this.registry.get(volunteerId)?.claimant
      ?? (await this.state.storage.get(`claimant:${volunteerId}`)) as string | undefined;
    if (claimant) led.claimant = claimant;
    await this.state.storage.put(key, led);
    await this.addRep(volunteerId, 1, "job", domain);
    await this.audit("credit", { volunteerId, amount: amountWei, claimant });
  }

  /** Rep ledger — rep:<id> → { points, jobs, referrals }, plus lane-scoped
   *  rep:lane:<domain>:<id> when a domain is set. Points are non-transferable
   *  reputation; negative points (jury dissents, canary failures) subtract —
   *  floor is 0. */
  private async addRep(id: string, points: number, reason: string, lane?: string) {
    if (!points) return;
    const apply = async (key: string) => {
      const rep = ((await this.state.storage.get(key)) as
        | { points: number; jobs: number; referrals: number } | undefined)
        ?? { points: 0, jobs: 0, referrals: 0 };
      rep.points = Math.max(0, rep.points + points);
      if (reason === "job") rep.jobs += 1;
      if (reason === "referral") rep.referrals += 1;
      await this.state.storage.put(key, rep);
    };
    await apply(`rep:${id}`);
    if (lane) await apply(`rep:lane:${lane.slice(0, 32)}:${id}`);
  }

  // ── helpers ──

  private async keys(prefix: string): Promise<string[]> {
    const m = await this.state.storage.list({ prefix });
    return [...m.keys()];
  }

  private countByTaskType(pool?: VolunteerMeta[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const v of pool ?? this.registry.values())
      for (const tt of v.taskTypes) counts[tt] = (counts[tt] || 0) + 1;
    return counts;
  }

  private bearerOk(req: Request, secret?: string): boolean {
    if (!secret) return false;
    return req.headers.get("authorization") === `Bearer ${secret}`;
  }

  /** Dispatch signature — HMAC-SHA256 over `widespread-job:<jobId>` when
   *  COORDINATOR_SECRET is configured (nodes verify provenance against the
   *  secret shared with the bridge). Unsigned in dev mode. */
  private async dispatchSig(jobId: string): Promise<string | undefined> {
    const secret = this.env.COORDINATOR_SECRET;
    if (!secret) return undefined;
    return `hmac-sha256:${await this.hmacHex(secret, `widespread-job:${jobId}`)}`;
  }

  private async hmacHex(secret: string, text: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret) as BufferSource,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text) as BufferSource);
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Normalize a result for replica agreement — parsed JSON re-encodes
   *  canonically (key order can't create false disagreement). */
  private normalizeResult(result: string): string {
    try { return canonicalJson(JSON.parse(result)); } catch { return result; }
  }

  /** Tamper-evident audit chain — each entry carries the previous entry's
   *  hash, so a forged gap breaks the chain. `audit:last` holds the head.
   *  Exported via GET /audit (admin). */
  private async audit(event: string, data: Record<string, unknown>) {
    try {
      const last = ((await this.state.storage.get("audit:last")) as
        | { seq: number; hash: string } | undefined) ?? { seq: 0, hash: "0" };
      const seq = last.seq + 1;
      const at = Date.now();
      const entry = { seq, prev: last.hash, event, data, at };
      const hash = await this.sha256Hex(JSON.stringify(entry));
      await this.state.storage.put(`audit:${seq}`, { ...entry, hash });
      await this.state.storage.put("audit:last", { seq, hash });
    } catch (e) {
      // Audit must never break the job path — log and continue.
      console.error("[coordinator] audit write failed:", e);
    }
  }

  private async sha256Hex(text: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
