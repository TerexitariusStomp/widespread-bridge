// mcp.ts — MCP server over the official SDK's Web Standard Streamable HTTP
// transport (stateless, per-request — spec 2025-11-25 compatible, and safe
// against the 2026-07-28 draft's session removal).
// Read tools + non-custodial earn tools: agents generate their own Ed25519
// keys; the bridge verifies signatures and relays. No keys server-side.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod/v4";
import type { Env } from "./types";
import { feedDoc, queryFeed, RUNNERS } from "./feed";
import { bountyDeclare, bountyBroadcast } from "./declare";
import { bindStatement, bindInstructions, registerBinding, listBindings, resolveHandle, revokeBinding } from "./identity";
import { listRunners } from "./feed";
import { agentChallenge, agentRegister, marketClaim, shipPrepare, shipSubmit, marketsList, bountiesList, agentStatus } from "./mcpearn";
import { getCoordinator } from "./coordinator";
import { listSightings, discoveryStats, ingestSighting, type Sighting } from "./sightings";
import { submitOutcome, disputeOutcome, getOutcome } from "./outcome";

const json = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }],
  structuredContent: v as Record<string, unknown>,
});

export async function handleMcpRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const server = new McpServer({ name: "widespread", version: "1.0.0" }, { capabilities: { tools: {} } });

  // ------------------------------------------------------------- reads
  server.registerTool("feed_search", {
    annotations: { title: 'Search Work Feed', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Search the unified cross-forge funded-work feed. Filter by forge, source, repo, min USD, currency, escrow state, max competition; sort by reward|newest|trust.",
    inputSchema: {
      forge: z.string().optional(), source: z.string().optional(), repo: z.string().optional(),
      domain: z.string().optional(),
      q: z.string().optional(), min_usd: z.number().optional(), currency: z.string().optional(),
      escrow: z.enum(["locked", "label-only", "external", "none"]).optional(),
      sort: z.enum(["reward", "newest", "trust"]).optional(),
      limit: z.number().optional(), cursor: z.string().optional(), max_competition: z.number().optional(),
    },
  }, async (args) => {
    const doc = await feedDoc(env, ctx);
    const page = queryFeed(doc, args);
    return json({ ...page, total_matched: page.records.length, generated_at: doc.generated_at });
  });

  server.registerTool("feed_get", {
    annotations: { title: 'Get Feed Record', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Get one feed record by id (e.g. 'gh:owner/repo#12', 'near:acct:7').",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const doc = await feedDoc(env, ctx);
    return json(doc.records.find((r) => r.id === id) ?? { error: "not found" });
  });

  server.registerTool("feed_stats", {
    annotations: { title: 'Feed Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Feed health: record count, per-source status/freshness, generated_at.",
    inputSchema: {},
  }, async () => {
    const doc = await feedDoc(env, ctx);
    return json({ generated_at: doc.generated_at, total: doc.records.length, sources: doc.sources });
  });

  server.registerTool("runners_list", {
    annotations: { title: 'List Sealed Runners', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Client-side sealed execution environments agents can run bounty work in (browser sandbox, self-hosted sealed runners).",
    inputSchema: {},
  }, async () => json({ runners: await listRunners(env) }));

  server.registerTool("wide_markets", {
    annotations: { title: 'List Work Markets', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List open escrowed work markets on the Widespread NEAR contract — funded work any agent can claim.",
    inputSchema: { chain: z.string().optional(), min_usd: z.number().optional() },
  }, async (a) => json(await marketsList(env, a)));

  server.registerTool("wide_bounties", {
    annotations: { title: 'List Bounties', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List the bridge's bounty board (NEAR-escrowed markets and mirrored pools).",
    inputSchema: {},
  }, async () => json(await bountiesList(env)));

  // ------------------------------------------------------- earn (write)
  server.registerTool("wide_agent_challenge", {
    annotations: { title: 'Agent Challenge', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Step 1 of registering an agent identity. Returns canonical bytes to sign with your OWN Ed25519 key — generate the keypair locally; the bridge never wants or stores seeds.",
    inputSchema: { label: z.string().optional() },
  }, async ({ label }) => json(await agentChallenge(env, label)));

  server.registerTool("wide_agent_register", {
    annotations: { title: 'Register Agent DID', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Step 2: submit challenge_id + your Ed25519 pubkey + signature over the challenge canonical bytes. Bridge verifies and registers a forge DID for your agent.",
    inputSchema: {
      challenge_id: z.string(), pubkey_hex: z.string(), signature_hex: z.string(), label: z.string().optional(),
    },
  }, async (a) => json(await agentRegister(env, req, a)));

  server.registerTool("wide_claim", {
    annotations: { title: 'Claim Market', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Claim intent on a funded market — validated against the on-chain market (open status, spec hash) and the submitted artifact: github PR/issue URL, btfs://cid or ipfs://cid (any deliverable, no forge account), rcpt://<id> + evidence.receipt (metered resource service), or a /api/jobs/ coordinator record. Returns shipClaim args + attestation token.",
    inputSchema: {
      marketId: z.string(), forgeRef: z.string(), forgeUserId: z.string().optional(),
      commits: z.array(z.string()).optional(), specHash: z.string().optional(),
      actor: z.string().optional(), claimant: z.string().optional(),
    },
  }, async (a) => json(await marketClaim(env, req, a)));

  server.registerTool("wide_ship_prepare", {
    annotations: { title: 'Prepare Ship Attestation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Build the canonical dg1 work-attestation fields to sign locally with your Ed25519 seed (deliverable = signed ship op on the forge).",
    inputSchema: {
      did: z.string(), repo: z.string(), session_id: z.string().optional(), tool: z.string().optional(),
      commits: z.array(z.string()), files: z.record(z.string(), z.string()).optional(),
      proof_items: z.array(z.unknown()).optional(),
      artifact: z.string().optional(), receipt: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (a) => json(await shipPrepare(env, a)));

  server.registerTool("wide_ship_submit", {
    annotations: { title: 'Submit Ship Attestation', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Submit the signed dg1 attestation — bridge verifies your signature against your registered pubkey and relays to the forge. Alternative: POST to the forge directly with x-dg-* headers.",
    inputSchema: {
      did: z.string(), repo: z.string(), body: z.record(z.string(), z.unknown()),
      ts: z.string(), nonce: z.string(), sig: z.string(),
    },
  }, async (a) => json(await shipSubmit(env, req, a)));

  server.registerTool("wide_status", {
    annotations: { title: 'Agent Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Agent's registration + records (claims, verdicts, payout traces) for a DID.",
    inputSchema: { did: z.string() },
  }, async ({ did }) => json(await agentStatus(env, { did })));

  // --------------------------------------------------- funder-side (write)
  server.registerTool("wide_bounty_declare", {
    annotations: { title: 'Declare Bounty', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Post a task: create a declared bounty market for ANY work domain (code, social-media, writing, research, data, other). Returns canonical declaration text to paste on any surface — a GitHub issue can fund a LinkedIn ghostwrite, a Bluesky post can fund code. Feed scanners bind the post to the market. deliverable_class 'resource' + meter/threshold/window declares a metered machine-service market (compute/bandwidth/storage/inference) settled by signed receipts.",
    inputSchema: {
      domain: z.string().optional(), spec: z.string(), amount: z.string(),
      currency: z.string().optional(),
      verification: z.object({ class: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }).optional(),
      payer_email: z.string().optional(), funder_handle: z.string().optional(), funder_did: z.string().optional(),
      target_platform: z.string().optional(), target_handle: z.string().optional(),
      deliverable_class: z.enum(["draft", "publish", "resource"]).optional(),
      meter: z.string().optional(), threshold: z.number().optional(), window: z.string().optional(),
      dims: z.string().optional().describe("Comma-separated capacity dims: C_e,C_h,C_k,C_inst,C_m"),
      capacity: z.object({
        dims: z.array(z.enum(["C_e", "C_h", "C_k", "C_inst", "C_m"])),
        subsystem: z.string().optional(), floor_attestation: z.string().optional(),
        evidence_plan: z.object({
          measure: z.string(), baseline: z.string().optional(),
          attester: z.enum(["claimant", "funder", "watcher", "trustee"]),
          attester_paid_by: z.enum(["protocol", "funder", "claimant"]),
          horizon_days: z.number(),
        }).optional(),
        trustee_ref: z.string().optional(),
      }).describe("REQUIRED MORE capacity objective — every market declares its life-capacity dims + evidence plan"),
    },
  }, async (a) => json(await bountyDeclare(env, a)));

  server.registerTool("wide_broadcast", {
    annotations: { title: 'Broadcast Bounty', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Declare a bounty AND get zero-auth intent URLs to post it on every surface at once (X, Bluesky, Mastodon, Nostr, HN). One escrow, N surfaces, duplicate submissions deduped, one payout.",
    inputSchema: {
      domain: z.string().optional(), spec: z.string(), amount: z.string(),
      currency: z.string().optional(),
      verification: z.object({ class: z.string().optional(), params: z.record(z.string(), z.unknown()).optional() }).optional(),
      payer_email: z.string().optional(), funder_handle: z.string().optional(), funder_did: z.string().optional(),
      target_platform: z.string().optional(), target_handle: z.string().optional(),
      deliverable_class: z.enum(["draft", "publish", "resource"]).optional(),
      meter: z.string().optional(), threshold: z.number().optional(), window: z.string().optional(),
    },
  }, async (a) => json(await bountyBroadcast(env, a)));

  // --------------------------------------------------- identity (write)
  server.registerTool("wide_identity_challenge", {
    annotations: { title: 'Identity Bind Challenge', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Get the canonical bind statement + per-platform instructions to link a DID to a platform handle (github/gitlab/forgejo/codeberg/bluesky/mastodon/nostr/x/hackernews/evm/solana/near/…). Trust-minimized: the bind is a public attestation anyone can re-verify — never inferred from name or style similarity.",
    inputSchema: { did: z.string(), platform: z.string(), handle: z.string() },
  }, async ({ did, platform, handle }) => json({ statement: bindStatement(did, platform, handle), instructions: bindInstructions(platform) }));

  server.registerTool("wide_identity_bind", {
    annotations: { title: 'Register Identity Binding', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Register a DID↔platform-handle binding after publishing/signing the bind statement. proof = the URL the statement was posted at (gist, post, comment, note id) or a signature (hex for EVM, JSON {pubkey,sig} for Solana/NEAR). Verified against the platform's public API — a handle already bound to another DID is rejected.",
    inputSchema: { did: z.string(), platform: z.string(), handle: z.string(), proof: z.string() },
  }, async (a) => json(await registerBinding(env, a)));

  server.registerTool("wide_identity_list", {
    annotations: { title: 'List Identity Bindings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List all platform bindings for a DID with their verification tier (native|sig|proof|weak) and evidence.",
    inputSchema: { did: z.string() },
  }, async ({ did }) => json({ did, bindings: await listBindings(env, did) }));

  server.registerTool("wide_identity_resolve", {
    annotations: { title: 'Resolve Platform Handle', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Resolve a platform handle to its bound DID — e.g. find the DID behind github/octocat or bluesky/alice.bsky.social.",
    inputSchema: { platform: z.string(), handle: z.string() },
  }, async ({ platform, handle }) => json(await resolveHandle(env, platform, handle) ?? { platform, handle, bound: false }));

  server.registerTool("wide_identity_revoke", {
    annotations: { title: 'Revoke Identity Binding', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Revoke a binding — signed by the bound DID's registered Ed25519 key over `widespread-revoke:v1\\n<did>\\n<platform>\\n<handle>`.",
    inputSchema: { did: z.string(), platform: z.string(), handle: z.string(), sig_hex: z.string() },
  }, async (a) => json(await revokeBinding(env, a)));

  // ------------------------------------------- resource requests (write)
  // These proxy the CoordinatorDO session API — offers are provider-priced
  // and Ed25519-signed; sessions are funded (market escrow or x402) and
  // metered in each network's native units.

  const doFetch = async (path: string, init?: RequestInit) => {
    const stub = getCoordinator(env);
    if (!stub) return { error: "coordinator not configured", status: 503 };
    const res = await stub.fetch(new Request(`https://coordinator.internal${path}`, init));
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  server.registerTool("wide_offers", {
    annotations: { title: 'List Resource Offers', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List provider-priced, Ed25519-signed resource offers across compute/storage/bandwidth/inference networks — ranked by price, reputation, and coordinator-measured latency. Filter by kind, network, or node.",
    inputSchema: {
      kind: z.enum(["compute", "inference", "storage", "bandwidth"]).optional(),
      network: z.string().optional(), node: z.string().optional(),
    },
  }, async (a) => {
    const qs = new URLSearchParams();
    if (a.kind) qs.set("kind", a.kind);
    if (a.network) qs.set("network", a.network);
    if (a.node) qs.set("node", a.node);
    const r = await doFetch(`/api/offers?${qs}`);
    return json(r.body ?? { error: "offers unavailable", status: r.status });
  });

  server.registerTool("wide_offer_stats", {
    annotations: { title: 'Resource Price Index', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Cross-resource price index: min/max/avg provider price per kind:unit across all live offers — nobody else normalizes compute+storage+bandwidth+inference together.",
    inputSchema: {},
  }, async () => {
    const r = await doFetch("/api/offers/stats");
    return json(r.body ?? { error: "stats unavailable", status: r.status });
  });

  server.registerTool("wide_request", {
    annotations: { title: 'Open Resource Session', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Open a metered resource session against a signed offer (offer_id) or a routing spec (kind/network/max_price/min_rep). Funding: market_id escrow or x402 payment; admin/testnet may omit. Returns sessionId for wide_request_call. Blocks until a node accepts (raced top-K) or times out.",
    inputSchema: {
      offer_id: z.string().optional(),
      spec: z.object({
        kind: z.string().optional(), network: z.string().optional(),
        max_price_near_per_unit: z.string().optional(), min_rep: z.number().optional(),
        deadline_secs: z.number().optional(),
      }).optional(),
      quota: z.number().optional(), market_id: z.string().optional(),
      requester: z.string().optional(), raced: z.number().optional(),
      deadline_secs: z.number().optional(), params: z.unknown().optional(),
      payment: z.unknown().optional(), mandate: z.unknown().optional(),
      siwx: z.unknown().optional(),
    },
  }, async (a) => {
    const r = await doFetch("/api/requests", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    });
    return json(r.body ?? { error: "request failed", status: r.status });
  });

  server.registerTool("wide_request_call", {
    annotations: { title: 'Session Call', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Execute one op inside an open resource session (store/fetch/infer/connect/job per the offer's network). Returns result + metered units — each call is a signed tick.",
    inputSchema: {
      sessionId: z.string(), op: z.string(), params: z.unknown().optional(),
    },
  }, async ({ sessionId, op, params }) => {
    const r = await doFetch(`/api/requests/${encodeURIComponent(sessionId)}/call`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, params }),
    });
    return json(r.body ?? { error: "call failed", status: r.status });
  });

  server.registerTool("wide_request_status", {
    annotations: { title: 'Session Status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Session record: status, accumulated metered units, tick count, upstream refs, HMAC-signed by the coordinator.",
    inputSchema: { sessionId: z.string() },
  }, async ({ sessionId }) => {
    const r = await doFetch(`/api/requests/${encodeURIComponent(sessionId)}`);
    return json(r.body ?? { error: "not found", status: r.status });
  });

  server.registerTool("wide_request_close", {
    annotations: { title: 'Close Session', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Close a resource session — the node emits its final metered receipt (rcpt://) which settles through the normal claim path.",
    inputSchema: { sessionId: z.string() },
  }, async ({ sessionId }) => {
    const r = await doFetch(`/api/requests/${encodeURIComponent(sessionId)}/close`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    return json(r.body ?? { error: "close failed", status: r.status });
  });

  server.registerTool("wide_request_tick_verdict", {
    annotations: { title: 'Tick Verdict', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Requester countersign/dispute on a metered tick — ack accepts the units, dispute flags them for review. Bounded dispute window; ticks default to accepted at settlement.",
    inputSchema: {
      sessionId: z.string(), seq: z.number(),
      verdict: z.enum(["ack", "dispute"]), requester: z.string().optional(),
    },
  }, async ({ sessionId, seq, verdict, requester }) => {
    const r = await doFetch(`/api/requests/${encodeURIComponent(sessionId)}/ticks/${seq}/${verdict}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requester }),
    });
    return json(r.body ?? { error: "verdict failed", status: r.status });
  });

  // ------------------------------------------- surface adapters (catalog)

  server.registerTool("wide_adapters", {
    annotations: { title: 'Surface Adapter Catalog', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Search the widespread-adapter/1 registry — signed manifests describing declarative HTTP ops on external surfaces (social, marketplace, forum, app). Ranked by verified-op count. Filter by surface, kind, status, or text.",
    inputSchema: {
      surface: z.string().optional(), kind: z.string().optional(),
      status: z.enum(["draft", "verified", "deprecated"]).optional(),
      q: z.string().optional(),
    },
  }, async (a) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(a)) if (v) qs.set(k, String(v));
    const r = await doFetch(`/api/adapters?${qs}`);
    return json(r.body ?? { error: "adapters unavailable", status: r.status });
  });

  server.registerTool("wide_adapter", {
    annotations: { title: 'Surface Adapter', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Fetch one adapter manifest by id — ops, auth model, verification evidence, grammar, lifecycle meta.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    const r = await doFetch(`/api/adapters/${encodeURIComponent(id)}`);
    return json(r.body ?? { error: "not found", status: r.status });
  });

  server.registerTool("wide_adapter_stats", {
    annotations: { title: 'Adapter Coverage Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live coverage metrics: adapters, distinct surfaces, verified ops, status/kind breakdown — the honest answer to 'how many surfaces can agents act on?'",
    inputSchema: {},
  }, async () => {
    const r = await doFetch("/api/adapters/stats");
    return json(r.body ?? { error: "stats unavailable", status: r.status });
  });

  // --------------------------------------- decentralized discovery (sightings)

  server.registerTool("wide_sightings", {
    annotations: { title: 'Query Task Sightings', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Query watcher-reported sightings — tasks/claims/receipts observed on external surfaces (social, forums, labor platforms) by client agents and volunteers. Filter by platform, since (ms), min_tier (lead|corroborated), limit. This is on-demand pull discovery: ask a surface directly instead of waiting for a crawl.",
    inputSchema: {
      platform: z.string().optional(), since: z.number().optional(),
      min_tier: z.enum(["lead", "corroborated"]).optional(), limit: z.number().optional(),
    },
  }, async (a) => json({ sightings: await listSightings(env, a) }));

  server.registerTool("wide_sighting_report", {
    annotations: { title: 'Report a Sighting', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Report an item you observed on an external surface (a #widespread declaration, claim, receipt, or bind statement). Watchers earn reputation when their sightings corroborate and the declaration funds. Optional watcher_did + sig (ed25519 over the canonical sighting payload) upgrades trust.",
    inputSchema: {
      platform: z.string(), native_id: z.string(), text: z.string(),
      url: z.string().optional(), author: z.string().optional(), ts: z.number().optional(),
      watcher_did: z.string().optional(), sig: z.string().optional(),
    },
  }, async (a) => {
    const { auth: _a, ...s } = a as Sighting & { auth?: string };
    return json(await ingestSighting(env, s));
  });

  server.registerTool("wide_discovery_stats", {
    annotations: { title: 'Discovery Coverage Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live decentralized-discovery metrics: surfaces watched, sightings by platform/tier/source, active watchers — the auditable answer to 'how much of the surface area is actually covered?'",
    inputSchema: {},
  }, async () => json(await discoveryStats(env)));

  server.registerTool("wide_outcome", {
    annotations: { title: 'Outcome Tranche', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "MORE two-stage escrow: submit post-horizon outcome evidence for a settled claim (id = repo:seq), check status, or file a dispute that freezes the outcome bonus. The paid party can never attest their own outcome — attester defaults to watcher.",
    inputSchema: {
      action: z.enum(["submit", "status", "dispute"]),
      id: z.string().describe("repo:seq of the settled claim"),
      ref: z.string().optional().describe("outcome evidence ref (url/cid/doi)"),
      evidence: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().optional(),
      attester: z.string().optional(),
    },
  }, async (a) => {
    if (a.action === "status") return json(await getOutcome(env, a.id) ?? { error: "not found" });
    if (a.action === "dispute") {
      return json(await disputeOutcome(env, a.id, a.attester ?? "agent", a.reason ?? ""));
    }
    return json(await submitOutcome(env, a.id, {
      ref: a.ref, evidence: a.evidence, attester: a.attester,
    }));
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
