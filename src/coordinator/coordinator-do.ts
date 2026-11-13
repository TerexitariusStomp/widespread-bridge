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
import { verifyDidKey, decodeSig } from "./didkey";
import { verifyMessage } from "viem";
import type { Hex } from "viem";
import { getMarket } from "./nearview";
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

const MAX_RESULT_BYTES = 256 * 1024;
const MAX_REPLICAS = 4;

/** Deterministic JSON — object keys sorted recursively — so the signed
 *  job record's `sig` is over a canonical encoding anyone can recompute. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys
    .map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k]))
    .join(",") + "}";
}

export class CoordinatorDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private registry = new Map<string, VolunteerMeta>();
  /** jobId → resolve — in-memory; the alarm's flushPending redispatches
   *  anything still pending after a hibernate/wake cycle. */
  private awaiting = new Map<string, { resolve: (ok: boolean) => void }>();
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
          this.registry.delete(meta.id);
        }
        try { ws.close(1000, "exit"); } catch { /* already closed */ }
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
      // JOB_RESULT_TIMEOUT_MS.
      await this.releaseVolunteerAssignments(meta.id);
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
