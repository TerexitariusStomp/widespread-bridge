// mcp.ts — MCP server over the official SDK's Web Standard Streamable HTTP
// transport (stateless, per-request — spec 2025-11-25 compatible, and safe
// against the 2026-07-28 draft's session removal).
// Read tools + non-custodial earn tools: agents generate their own Ed25519
// keys; the bridge verifies signatures and relays. No keys server-side.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./types";
import { feedDoc, queryFeed, RUNNERS } from "./feed";
import { listRunners } from "./feed";
import { agentChallenge, agentRegister, marketClaim, shipPrepare, shipSubmit, marketsList, bountiesList, agentStatus } from "./mcpearn";

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
    description: "List the bridge's fiat-mirror bounty board (PayPal/PYUSD-settled pools).",
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
    description: "Claim intent on a funded market — validated against the on-chain market (open status, spec hash) and the forge submission, returns shipClaim args + attestation token.",
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

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
