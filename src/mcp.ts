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
import { bountyDeclare, bountyBroadcast } from "./declare";
import { bindStatement, bindInstructions, registerBinding, listBindings, resolveHandle, revokeBinding } from "./identity";
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

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
}
