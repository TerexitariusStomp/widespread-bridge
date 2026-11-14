// Widespread verified-work protocol worker — forge-agnostic claim →
// evidence → verdict → payout bridge. Forge specifics live in src/forges/.
//
//   GET  /                    market home (bounties, mirrors, receipts)
//   GET  /ops                 ops dashboard (claim → evidence → verdict → payout)
//   GET  /api/state           all review records + bounties (dashboard feed)
//   POST /review              {repo, seq} one claim · {repo, all:true} outstanding
//   GET  /review?repo&seq     same, for linkable demo runs
//   GET  /api/bounties        funded-work registry
//   POST /api/bounties        open/overwrite a bounty (ADMIN_TOKEN if set)
//   DELETE /api/bounties/:r   close one
//   GET  /healthz
//   scheduled(*/5m)           scan WATCH_REPOS claim streams, review new work claims

import { OPS_HTML } from "./ops";
import { homePage, bountiesPage, bountyPage, fundPage, receiptPage, docsPage, bountyMarkdown } from "./web/pages";
import { reviewOutstanding, runReview } from "./review";
import { handleBotVerdict, type BotVerdictBody } from "./botverdict";
import { attestClaim, ecosystem, openDispute } from "./ecosystem";
import { resolveLocator } from "./locator";
import { sponsorPage } from "./sponsor";
import { poidhInfo } from "./poidh";
import { hatsOrg, hatsHat, hatsStanceCheck, hatsOpportunities,
         hatsForeign, hatsPayoutQuote, intentsStatus, mechanismList, mechanismRun,
         earnedStance, delegatedStance, parseIdentityRef, stanceScore,
         ERC8004_REGISTRIES } from "./hats";
import { nearView, listOnchainMarkets } from "./near";
import { nearViewCall } from "./nearops";
import { oracleEnv, oracleVote, signVerdict } from "./oracle";
import { scanOnchain, scanMirrorPayouts } from "./onchainscan";
import { handleMcpRequest } from "./mcp";
import { OPENAPI, LLMS_TXT, SKILL_MD, INSTALL_HTML, PRIVACY_HTML, TERMS_HTML } from "./docs";
import { checkLimit, callerKey, rateLimited } from "./ratelimit";
import { handleEvaluate } from "./evaluator";
import { deleteBounty, listBounties, listRecords, putBounty } from "./store";
import {
  feedDoc, queryFeed, feedRss, FEED_MD,
  listRunners, registerRunner, refreshFeed, handleMirrorQuote,
} from "./feed";
import { bountyDeclare, bountyBroadcast, getDeclared, specReveal } from "./declare";
import { ingestSighting, listSightings, discoveryStats } from "./sightings";
import { submitOutcome, disputeOutcome, resolveDispute, getOutcome } from "./outcome";
import { poolStatus, creditTreasury } from "./maximin";
import { publishSighting as gossipPublishSighting } from "./gossip";
import { handleWebhook } from "./webhooks";
import { bindStatement, bindInstructions, registerBinding, listBindings, resolveHandle, revokeBinding, reverifyBinding } from "./identity";
import { putFeedDoc } from "./feedstore";
import { bountiesList, marketsList } from "./mcpearn";
import { handleClaimPost, handleClaimVerify } from "./claims";
import { tryOpsEscrow, tryDeclEscrow, declEscrowPlan } from "./escrow";
import { handleMirrorClaimPost, handleMirrorClaimsList, handleMirrorClaimTimeout, handleMirrorRequestChanges, handleMirrorVerdict, handleMirrorPayout } from "./mirrorclaims";
import { scanMirrorSubmissions } from "./ingest";
import { agentCard, createDispatch, handleA2a, listDispatches, markDispatch, settleCalldata } from "./dispatch";
import { listDispatchSubmissions, scanDispatchChannels } from "./collect";
import { handleCoordinatorRequest } from "./coordinator/index";
import type { FeedRecord, Bounty, Env } from "./types";

// Durable Object class must be exported from the worker entry for the
// wrangler `class_name` binding to resolve.
export { CoordinatorDO } from "./coordinator/coordinator-do";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const bad = (msg: string, status = 400) => json({ error: msg }, status);

/** Anonymous HTML GET memoization — feed pages render from the KV feed
 * doc and cost real CPU; free-tier isolates get ~10ms. Authenticated or
 * cookie-bearing requests always bypass. */
const pageCache = new Map<string, { body: string; expires: number }>();
const PAGE_TTL_MS = 45_000;

/** Decode a path segment that may contain %2F-encoded id characters.
 * Malformed escapes fall back to the raw segment rather than throwing. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function cacheable(req: Request): boolean {
  return req.method === "GET"
    && !req.headers.get("authorization")
    && !req.headers.get("cookie");
}

async function cachedPage(url: URL, req: Request, render: () => Promise<Response>): Promise<Response> {
  if (!cacheable(req)) return render();
  const key = url.pathname + url.search;
  const hit = pageCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const res = await render();
  if (res.headers.get("content-type")?.includes("text/html")) {
    const body = await res.clone().text();
    if (pageCache.size > 200) pageCache.clear();
    pageCache.set(key, { body, expires: Date.now() + PAGE_TTL_MS });
  }
  return res;
}

/** Where-the-money-goes trace for a claim: escrow → paid | refunded |
 * open | expired | slashed — the public answer to "where did it go". */
function payoutTrace(c: { status?: string; payout?: { transaction_id?: string; batch_id?: string; receiver?: string; amount?: string; currency?: string } | null }) {
  const pay = c.payout ?? {};
  const status = c.status ?? "open";
  return {
    escrowed: true,
    state: status === "accepted_paid" ? "paid" : status,
    to: pay.receiver ?? (status === "accepted_paid" ? "claimant" : "escrow"),
    tx: pay.transaction_id ?? pay.batch_id ?? null,
    amount: pay.amount ?? null,
    currency: pay.currency ?? null,
  };
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true;
  return req.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

interface ReviewBody {
  repo?: string;
  seq?: number;
  all?: boolean;
  force?: boolean;
}

async function handleReview(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let body: ReviewBody = {};
  if (req.method === "POST") {
    body = (await req.json().catch(() => ({}))) as ReviewBody;
  }
  const repo = body.repo ?? url.searchParams.get("repo") ?? "";
  const seqRaw = body.seq ?? url.searchParams.get("seq") ?? undefined;
  const all = body.all || url.searchParams.get("all") === "1";
  const force = body.force || url.searchParams.get("force") === "1";
  const seq = seqRaw === undefined || seqRaw === null ? undefined : Number(seqRaw);
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) return bad("repo must look like owner/repo");
  try {
    if (all || seq === undefined || !Number.isFinite(seq)) {
      const records = await reviewOutstanding(env, repo);
      return json({ reviewed: records.length, status: "ok", records });
    }
    const record = await runReview(env, repo, seq, { force: !!force });
    return json({ reviewed: 1, status: record.status, records: [record] });
  } catch (e) {
    return bad(String(e), e instanceof Error && e.message.includes("not") ? 404 : 422);
  }
}

/** Read open markets straight from the NEAR market contract — the chain is
 * the state; KV is only a dev fallback when no contract is configured. */
interface BountyBody {
  repo?: string;
  amount?: string;
  currency?: string;
  receiver_account?: string;    // NEAR claimant account
  recipients?: Record<string, string>;
  spec?: string;
  upstream?: string;
  work_id?: string;
  note?: string;
}

async function handleBountyPost(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env)) return bad("unauthorized", 401);
  const body = (await req.json().catch(() => null)) as BountyBody | null;
  if (!body?.repo || !/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(body.repo)) {
    return bad("repo must look like owner/repo");
  }
  if (!body.receiver_account && !body.recipients) {
    return bad("receiver_account (or recipients map) required — a NEAR claimant account");
  }
  const bounty: Bounty = {
    repo: body.repo,
    amount: body.amount ?? "1.00",
    currency: (body.currency ?? "USD").toUpperCase(),
    receiver_account: body.receiver_account ?? "",
    ...(body.recipients ? { recipients: body.recipients } : {}),
    spec: body.spec ?? "",
    ...(body.upstream ? { upstream: body.upstream } : {}),
    ...(body.work_id ? { work_id: body.work_id } : {}),
    ...(body.note ? { note: body.note } : {}),
    created_at: Date.now(),
  };
  await putBounty(env, bounty);
  return json({ ok: true, bounty }, 201);
}

function watchRepos(env: Env): string[] {
  return (env.WATCH_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/** Scan watched repos' claim streams; review work claims we haven't seen.
 * Also adjudicates on-chain attested claims + executes mirror payouts —
 * the money path needs no human step. */
async function scan(env: Env): Promise<number> {
  let reviewed = 0;
  for (const repo of watchRepos(env)) {
    reviewed += (await reviewOutstanding(env, repo)).length;
  }
  const oc = await scanOnchain(env).catch((e) => {
    console.error(`onchain scan: ${String(e)}`);
    return { reviewed: 0, voted: 0 };
  });
  reviewed += oc.reviewed;
  await scanMirrorPayouts(env).catch((e) => {
    console.error(`mirror payout scan: ${String(e)}`);
    return 0;
  });
  return reviewed;
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // CoordinatorDO surface — volunteer nodes connect over ws at /api/nodes,
    // jobs are created via POST /api/jobs and their signed public records
    // read via GET /api/jobs/:id; /api/coordinator/* forwards the read
    // endpoints (/status, /leaderboard, /rep, /operator, /earnings, /audit).
    if (pathname === "/api/nodes" || pathname.startsWith("/api/jobs") ||
        pathname.startsWith("/api/offers") || pathname.startsWith("/api/requests") ||
        pathname.startsWith("/api/adapters") ||
        pathname.startsWith("/api/x402") ||
        pathname.startsWith("/api/coordinator")) {
      const res = handleCoordinatorRequest(req, env);
      if (res) return res;
      return bad("coordinator not configured", 503);
    }
    // 1Click cross-chain funding quotes — real defuse-protocol API calls.
    if (pathname === "/api/funding/1click/tokens" && req.method === "GET") {
      try {
        const { listTokens } = await import("./oneclick");
        return Response.json({ tokens: await listTokens(url.searchParams.get("ondo") ?? "false") });
      } catch (e) {
        return Response.json({ error: `1click tokens: ${e instanceof Error ? e.message.slice(0, 160) : "unavailable"}` }, { status: 502 });
      }
    }
    if (pathname === "/api/funding/1click/quote" && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b?.originAsset || !b?.destinationAsset || !b?.amount || !b?.refundTo || !b?.recipient) {
        return bad("originAsset, destinationAsset, amount, refundTo, recipient required", 400);
      }
      try {
        const { quoteSwap } = await import("./oneclick");
        const quote = await quoteSwap(b as never);
        return Response.json(quote);
      } catch (e) {
        return Response.json({ error: `1click quote: ${e instanceof Error ? e.message.slice(0, 200) : "unavailable"}` }, { status: 502 });
      }
    }
    if (pathname.startsWith("/api/funding/1click/status/") && req.method === "GET") {
      const addr = decodeURIComponent(pathname.slice("/api/funding/1click/status/".length));
      if (!addr) return bad("depositAddress required", 400);
      try {
        const { executionStatus } = await import("./oneclick");
        return Response.json(await executionStatus(addr, url.searchParams.get("memo") ?? undefined));
      } catch (e) {
        return Response.json({ error: `1click status: ${e instanceof Error ? e.message.slice(0, 160) : "unavailable"}` }, { status: 502 });
      }
    }
    if (pathname === "/" || pathname === "/index.html") {
      return cachedPage(url, req, () => homePage(env, ctx));
    }
    // Human surfaces — SSR pages over the feed/mirror/claim APIs.
    // Pretty paths: record/mirror ids contain '/', '#', ':' so they travel
    // percent-encoded as a single segment (%2F survives in pathname).
    if (pathname === "/bounties") {
      return cachedPage(url, req, () => bountiesPage(env, ctx));
    }
    if (pathname.startsWith("/bounties/")) {
      const id = safeDecode(pathname.slice("/bounties/".length));
      if (!id) return bad("id required", 400);
      return cachedPage(url, req, () => bountyPage(env, ctx, id));
    }
    if (pathname === "/bounty" || pathname === "/bounty/") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return bad("id required", 400);
      return cachedPage(url, req, () => bountyPage(env, ctx, id));
    }
    if (pathname === "/bounty.md" || pathname === "/bounty.md/") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return bad("id required", 400);
      return cachedPage(url, req, () => bountyMarkdown(env, ctx, id));
    }
    if (pathname.startsWith("/fund/")) {
      const id = safeDecode(pathname.slice("/fund/".length));
      if (!id) return bad("id required", 400);
      return cachedPage(url, req, () => fundPage(env, ctx, id));
    }
    if (pathname === "/fund") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return bad("id required", 400);
      return cachedPage(url, req, () => fundPage(env, ctx, id));
    }
    if (pathname.startsWith("/receipts/m/")) {
      // /receipts/m/<mirrorId>/<claimHash> — mirror ids stay one encoded
      // segment; the claim hash is the final segment.
      const rest = pathname.slice("/receipts/m/".length).split("/");
      const claimHash = safeDecode(rest.pop() ?? "");
      const mirrorId = safeDecode(rest.join("/"));
      if (!mirrorId || !claimHash) return bad("mirror and claim required", 400);
      return cachedPage(url, req, () => receiptPage(env, mirrorId, claimHash, null, null));
    }
    if (pathname.startsWith("/receipts/r/")) {
      // /receipts/r/<owner>/<repo>/<seq> — repo path segments are real slashes.
      const rest = pathname.slice("/receipts/r/".length).split("/");
      const seqRaw = rest.pop() ?? "";
      const repo = rest.join("/");
      const seq = Number(seqRaw);
      if (!repo || !Number.isFinite(seq)) return bad("repo and seq required", 400);
      return cachedPage(url, req, () => receiptPage(env, null, null, repo, seq));
    }
    if (pathname === "/receipt") {
      const mirrorId = url.searchParams.get("mirror");
      const claimHash = url.searchParams.get("claim");
      const repo = url.searchParams.get("repo");
      const seqRaw = url.searchParams.get("seq");
      const seq = seqRaw == null ? null : Number(seqRaw);
      return cachedPage(url, req, () =>
        receiptPage(env, mirrorId, claimHash, repo, Number.isFinite(seq) ? seq : null));
    }
    if (pathname === "/docs") return docsPage();
    // Ops dashboard — the claim→evidence→verdict→payout console. Gated like
    // the other admin surfaces: open when ADMIN_TOKEN is unset (dev/testnet),
    // Bearer-required once configured.
    if (pathname === "/ops" || pathname === "/dashboard") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      return new Response(OPS_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // Sponsor-tool surface: AG Grid payout-trace viewer.
    if (pathname === "/sponsor") return sponsorPage(env);
    if (pathname === "/healthz") return json({ ok: true, service: "widespread-bridge" });
    if (pathname === "/.well-known/agent-card.json" && req.method === "GET") {
      return json(agentCard(env.PUBLIC_BASE || url.origin));
    }
    if (pathname === "/a2a" && req.method === "POST") {
      return handleA2a(req, async () => {
        const markets = await listOnchainMarkets(env).catch(() => null);
        return { markets: markets ?? [], total: markets?.length ?? 0, source: markets ? "chain" : "unavailable" };
      });
    }
    if (pathname === "/api/state" && req.method === "GET") {
      // Opportunistic pickup, time-bucketed: agent/plugin polling must not
      // re-run the forge sweep on every request — at most 1 scan per
      // SCAN_MIN_INTERVAL_S (default 300s) across all callers.
      const scanMinMs = Number((env as { SCAN_MIN_INTERVAL_S?: string }).SCAN_MIN_INTERVAL_S ?? "300") * 1000;
      const lastScan = Number(await env.CLAIMS.get("scan:last").catch(() => 0)) || 0;
      if (Date.now() - lastScan > scanMinMs) {
        ctx.waitUntil((async () => {
          await env.CLAIMS.put("scan:last", String(Date.now())).catch(() => {});
          await scan(env).catch((e) => console.error(`scan: ${String(e)}`));
        })());
      }
      const ttlMs = Number((env as { STATE_TTL_S?: string }).STATE_TTL_S ?? "30") * 1000;
      const doc = await env.CLAIMS.get("state:doc", "json").catch(() => null) as
        { generated_at?: number; claims?: unknown[]; bounties?: unknown[] } | null;
      if (doc?.generated_at && Date.now() - doc.generated_at < ttlMs) return json(doc);
      const [claims, bounties] = await Promise.all([listRecords(env), listBounties(env)]);
      const claimsWithTrace = claims.map((c) => ({ ...c, payout_trace: payoutTrace(c) }));
      const out = { generated_at: Date.now(), claims: claimsWithTrace, bounties };
      ctx.waitUntil(env.CLAIMS.put("state:doc", JSON.stringify(out)).catch(() => {}));
      return json(out);
    }
    // Public bounty board — funded, open markets + where the money goes.
    // Market truth is the CHAIN (widespread-near contract listOpen), not our
    // KV — the bridge is a thin renderer; participant infra holds the state.
    if (pathname === "/api/markets" && req.method === "GET") {
      const marketId = url.searchParams.get("market_id");
      if (marketId) {
        const acct = env.NEAR_CONTRACT;
        if (!acct) return bad("no NEAR_CONTRACT configured", 503);
        const market = await nearView(env, acct, "getMarket", { marketId }).catch(() => null);
        return market ? json({ market }) : bad("market not found", 404);
      }
      const mttl = Number((env as { MARKETS_TTL_S?: string }).MARKETS_TTL_S ?? "60") * 1000;
      const mc = await env.CLAIMS.get("markets:cache", "json").catch(() => null) as
        { generated_at?: number; markets?: unknown[] } | null;
      const onchain = (mc?.generated_at && Date.now() - mc.generated_at < mttl)
        ? mc.markets
        : await (async () => {
            const m = await listOnchainMarkets(env).catch(() => null);
            if (m) ctx.waitUntil(env.CLAIMS.put("markets:cache",
              JSON.stringify({ generated_at: Date.now(), markets: m })).catch(() => {}));
            return m;
          })();
      if (onchain && url.searchParams.get("format") === "erc8183") {
        // ERC-8183 repo-variant job descriptors — any conformant client
        // can read our supply in the standard's vocabulary.
        const jobs = onchain.map((m: unknown, i: number) => {
          const r = (m ?? {}) as Record<string, unknown>;
          return {
            jobId: i,
            client: String(r.client ?? r.creator ?? ""),
            provider: "0x0000000000000000000000000000000000000000",
            evaluator: "widespread-oracle", // independent, not client-self
            description: String(r.description ?? r.title ?? ""),
            budget: String(r.amount ?? "0"),
            expiredAt: 0,
            status: "Open",
          };
        });
        return json({ schema: "erc-8183/repo-variant", jobs, total: jobs.length, source: "chain" });
      }
      if (onchain) return json({ markets: onchain, total: onchain.length, source: "chain" });
      return json({ markets: [], total: 0, source: "chain",
        error: "no NEAR_CONTRACT configured — markets live on-chain, not in KV" });
    }
    if (pathname === "/api/dispatch" && req.method === "GET") {
      return json({ dispatches: await listDispatches(env, url.searchParams.get("market_id") ?? undefined) });
    }
    if (pathname === "/api/dispatch" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const body = await req.json().catch(() => null) as {
        market_id?: string; platforms?: string[];
        spend_auth?: import("./types").SpendAuth[];
        targets?: Record<string, { rpc?: string; contract?: string }>;
        description?: string; expired_at?: number;
      } | null;
      if (!body?.market_id || !Array.isArray(body.platforms)) {
        return bad("market_id and platforms[] required", 400);
      }
      const result = await createDispatch(env, {
        market_id: body.market_id,
        platforms: body.platforms,
        spend_auth: body.spend_auth,
        targets: body.targets,
        description: body.description,
        expired_at: body.expired_at,
      }, env.PUBLIC_BASE || url.origin);
      if (result.error) return bad(result.error, result.status ?? 400);
      return json({ ok: true, dispatches: result.records,
        ...(result.skipped_no_auth ? { skipped_no_auth: result.skipped_no_auth } : {}) }, 201);
    }
    if (pathname === "/api/dispatch/mark" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const b = (await req.json().catch(() => ({}))) as { market_id?: string; platform?: string; ref?: string; state?: "active" | "settled" | "closed" };
      if (!b.market_id || !b.platform || !b.ref) return bad("market_id, platform, ref required", 400);
      const rec = await markDispatch(env, b.market_id, b.platform, b.ref, b.state);
      return rec ? json({ ok: true, dispatch: rec }) : bad("dispatch channel not found", 404);
    }
    if (pathname === "/api/dispatch/submissions" && req.method === "GET") {
      return json({ submissions: await listDispatchSubmissions(env, url.searchParams.get("market_id") ?? undefined) });
    }
    // Platform-rail settlement — returns complete() calldata for the
    // evaluator seat after adjudication accepts a deliverable. The canonical
    // payout on rail=platform happens on that contract, once.
    if (pathname === "/api/dispatch/settle" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const b = (await req.json().catch(() => ({}))) as { market_id?: string; platform?: string; job_id?: number; reason?: string };
      if (!b.market_id || !b.platform || b.job_id === undefined) return bad("market_id, platform, job_id required", 400);
      const ch = await env.CLAIMS.get(`dispatch:${b.market_id}:${b.platform}`, "json").catch(() => null) as
        { rail?: string; prepared_tx?: { to: string; chain: string }; state?: string } | null;
      if (!ch || ch.rail !== "platform" || !ch.prepared_tx) return bad("no platform-rail channel for that market+platform", 404);
      return json({ prepared_tx: {
        to: ch.prepared_tx.to, chain: ch.prepared_tx.chain,
        data: settleCalldata(b.job_id, `0x${"776964652d766572646963742d6163636570746564".padEnd(64, "0")}`),
        note: "complete(jobId, reason) — evaluator seat signs; releases the platform escrow to the winning provider once.",
      } });
    }
    if (pathname === "/api/evaluate" && req.method === "POST") {
      const rl = await checkLimit(env, "evaluate", callerKey(req), 10, 200);
      if (!rl.ok) return rateLimited(rl.retryAfter);
      return handleEvaluate(req, env);
    }
    if (pathname === "/api/scan" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      return json({ reviewed: await scan(env) });
    }
    if (pathname === "/review" && (req.method === "POST" || req.method === "GET")) {
      return handleReview(req, env);
    }
    if (pathname === "/api/bounties" && req.method === "GET") {
      return json({ bounties: await listBounties(env) });
    }
    if (pathname === "/api/bounties" && req.method === "POST") {
      const rl = await checkLimit(env, "bounties", callerKey(req), 20, 200);
      if (!rl.ok) return rateLimited(rl.retryAfter);
      return handleBountyPost(req, env);
    }
    // PR-bot verdict oracle — widespread-bot posts a bot's public verdict on
    // a wide:funded PR; we sign it as a wide-verdict and settle if bound.
    if (pathname === "/api/bot-verdict" && req.method === "POST") {
      return handleBotVerdict(env, (await req.json().catch(() => ({}))) as BotVerdictBody);
    }
    // Public audit feed of PR-bot oracle verdicts (who verified, what score,
    // where the money went) — the "they're the verifier, we're the money" trail.
    if (pathname === "/api/bot-verdicts" && req.method === "GET") {
      const list = await env.CLAIMS.list({ prefix: "botverdict:" }).catch(() => null);
      const records = await Promise.all(
        (list?.keys ?? []).map((k) => env.CLAIMS.get(k.name, "json").catch(() => null))
      );
      return json({ verdicts: records.filter(Boolean), total: records.filter(Boolean).length });
    }
    // Collaborator ecosystem feed — rails, funding pools, security boards,
    // forges, workers, dispute/proof seams. All env-gated, all optional.
    if (pathname === "/api/ecosystem" && req.method === "GET") {
      return json(await ecosystem(env));
    }
    // Foreguild futarchy — live governance proposals on the NEAR contract.
    if (pathname === "/api/futarchy" && req.method === "GET") {
      const acct = (env as { FUTARCHY_CONTRACT?: string }).FUTARCHY_CONTRACT;
      if (!acct) return json({ proposals: [], total: 0,
        error: "no FUTARCHY_CONTRACT configured" });
      const proposals = await nearView(env, acct, "listProposals", {})
        .catch(() => null) as unknown[] | null;
      return json({ proposals: proposals ?? [], total: proposals?.length ?? 0,
        contract: acct, source: "chain" });
    }
    // Intentional Hats — org charts, stance checks, ranked opportunities.
    // All contract reads via nearView; writes happen on-chain by wearers.
    if (pathname === "/api/hats" && req.method === "GET") {
      const orgId = url.searchParams.get("org")
        ?? (env as { HATS_ORG?: string }).HATS_ORG ?? "2";
      return json(await hatsOrg(env, orgId));
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/stance-check") && req.method === "POST") {
      const hatId = pathname.split("/")[3];
      const d = (await req.json().catch(() => ({}))) as
        { spec?: string; verdicts?: { spec?: string; outcome?: string }[]; delegate?: boolean };
      if (!d.spec) return bad("need {spec}", 400);
      const base = await hatsStanceCheck(env, hatId, d.spec) as Record<string, unknown>;
      if ("error" in base) return json(base);
      const hat = await hatsHat(env, hatId);
      const hatOk = hat && !("error" in hat) && hat ? hat : null;
      // earned stance: fold verified verdict history into effective prefs
      if (d.verdicts?.length && hatOk) {
        const es = earnedStance(hatOk, d.verdicts);
        const adj = { ...hatOk, stance: { ...hatOk.stance, prefs: es.prefs } };
        const rescored = stanceScore(adj, d.spec);
        base.earned = { ...es, rescored };
      }
      // delegated deliberation: constitutionRef as live endpoint (Simocracy)
      if (d.delegate !== false && hatOk)
        base.delegated = await delegatedStance(hatOk, d.spec);
      // identity ref parsing (ERC-8004 / ATProto / NEAR)
      if (hatOk) {
        const ref = parseIdentityRef(hatOk.identityRef ?? hatOk.constitutionRef);
        base.identity = ref?.kind === "erc8004"
          ? { ...ref, registries: ERC8004_REGISTRIES[ref.chainId] ?? null }
          : ref;
      }
      return json(base);
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/foreign") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      return json(await hatsForeign(env, hatId));
    }
    if (pathname === "/api/hats/payout-quote" && req.method === "POST") {
      const d = (await req.json().catch(() => ({}))) as Record<string, string>;
      return json(await hatsPayoutQuote(env, d));
    }
    if (pathname === "/api/intents/status" && req.method === "GET") {
      const dep = url.searchParams.get("depositAddress") ?? "";
      return dep ? json(await intentsStatus(dep)) : bad("need ?depositAddress=", 400);
    }
    // Simocracy-compatible mechanism service (org.simocracy.mechanism).
    if (pathname === "/api/mechanisms" && req.method === "GET") {
      return json(mechanismList());
    }
    if (pathname.startsWith("/api/workflows/") && req.method === "POST") {
      const id = pathname.split("/")[3];
      const d = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return json(await mechanismRun(env, id, d));
    }
    if (pathname.startsWith("/api/hats/") && pathname.endsWith("/opportunities") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      const markets = (await listOnchainMarkets(env).catch(() => null)) as
        { marketId: string; spec: string; locked: string }[] | null ?? [];
      return json(await hatsOpportunities(env, hatId, markets));
    }
    if (pathname.startsWith("/api/hats/") && req.method === "GET") {
      const hatId = pathname.split("/")[3];
      const hat = await hatsHat(env, hatId);
      if (!hat || ("error" in hat)) return bad("hat not found", 404);
      const acct = (env as { HATS_CONTRACT?: string }).HATS_CONTRACT;
      const scope = url.searchParams.get("scope");
      const has = scope
        ? await nearView(env, acct!, "hasScope", { hatId, scope }).catch(() => null)
        : null;
      return json({
        ...hat, contract: acct,
        foreign: hat.foreign
          ? { ...hat.foreign, address: "see /api/hats/:id/foreign (derived_public_key view)" }
          : null,
        scopeCheck: scope ? { scope, granted: has } : undefined,
      });
    }
    // Unified forge bounty feed — normalized cross-forge discovery index.
    // JSON canonical · Atom RSS · minimal MCP · self-describing doc.
    // Maximin pool: scarcity stats + protocol-earnings treasury.
    if (pathname === "/api/pool" && req.method === "GET") {
      return json(await poolStatus(env));
    }
    if (pathname === "/api/pool/credit" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { amount?: number; note?: string };
      if (!body.amount || body.amount <= 0) return json({ error: "amount required" }, 400);
      return json({ treasury: await creditTreasury(env, body.amount, body.note) });
    }
    // MORE outcome bonus: watcher-submitted re-verification post-horizon,
    // dispute freeze, trustee resolution.
    if (pathname === "/api/outcome/submit" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; ref?: string; evidence?: Record<string, unknown>; attester?: string };
      if (!body.id) return json({ error: "id required (repo:seq)" }, 400);
      return json(await submitOutcome(env, body.id, body));
    }
    if (pathname === "/api/outcome/dispute" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; by?: string; reason?: string };
      if (!body.id || !body.by) return json({ error: "id + by required" }, 400);
      return json(await disputeOutcome(env, body.id, body.by, body.reason ?? ""));
    }
    if (pathname === "/api/outcome/resolve" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { id?: string; resolution?: "verified" | "failed" };
      if (!body.id || !body.resolution) return json({ error: "id + resolution required" }, 400);
      return json(await resolveDispute(env, body.id, body.resolution));
    }
    if (pathname.startsWith("/api/outcome/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/outcome/".length));
      const st = await getOutcome(env, id);
      return st ? json(st) : json({ error: "not found" }, 404);
    }
    if (pathname === "/api/bounty/declare" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Parameters<typeof bountyDeclare>[1];
      return json(await bountyDeclare(env, body));
    }
    if (pathname === "/api/bounty/broadcast" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Parameters<typeof bountyBroadcast>[1];
      return json(await bountyBroadcast(env, body));
    }
    // Confidential markets: registered agents reveal the sealed spec —
    // returns crypto_box_seal'd spec to the claimant's x25519 pubkey.
    if (pathname === "/api/spec/reveal" && req.method === "POST") {
      const rl = await checkLimit(env, "specreveal", callerKey(req), 20, 100);
      if (!rl.ok) return rateLimited(rl.retryAfter);
      const body = (await req.json().catch(() => ({}))) as Parameters<typeof specReveal>[1];
      return json(await specReveal(env, body));
    }
    // Public sealing keys — funders seal specs/deliverables to the
    // bridge's x25519 key; workers do the same for adjudication copies.
    if (pathname === "/api/keys" && req.method === "GET") {
      const { bridgeX25519PublicKey } = await import("./sealed");
      return json({ bridge_x25519_pubkey: bridgeX25519PublicKey(env) });
    }
    // Trustless escrow plan: everything a funder needs to escrow from a
    // FRESH implicit account funded via Intents — we never see the key,
    // never custody funds. GET returns args; POST adds a live 1Click quote.
    const declPlan = pathname.match(/^\/api\/declarations\/([0-9a-f]{8,16})\/escrow-plan$/i);
    if (declPlan && (req.method === "GET" || req.method === "POST")) {
      const p = req.method === "POST"
        ? (await req.json().catch(() => ({}))) as Parameters<typeof declEscrowPlan>[2]
        : {
            recipient: url.searchParams.get("recipient") ?? undefined,
            origin_asset: url.searchParams.get("origin_asset") ?? undefined,
            refund_to: url.searchParams.get("refund_to") ?? undefined,
            near_amount: url.searchParams.get("near_amount") ?? undefined,
            quorum_m: url.searchParams.get("quorum_m") ? Number(url.searchParams.get("quorum_m")) : undefined,
          };
      try {
        return json(await declEscrowPlan(env, declPlan[1], p ?? {}));
      } catch (e) {
        return bad(`escrow-plan failed: ${e instanceof Error ? e.message : e}`, 500);
      }
    }
    if (pathname.startsWith("/api/declarations/") && req.method === "GET") {
      const hash = pathname.split("/").pop() ?? "";
      const [bounty, claims, sights] = await Promise.all([
        getDeclared(env, hash),
        env.CLAIMS.get(`hclaim:${hash}`, "json"),
        env.CLAIMS.get(`declsight:${hash}`, "json"),
      ]);
      if (!bounty) return json({ error: "not found" }, 404);
      // Confidential markets: the spec and every funder-identifying or
      // spec-derived field stay private — the claim-gated
      // /api/spec/reveal path is the only way in.
      const pub = bounty.confidential
        ? { ...bounty, spec: undefined, spec_redacted: true,
            target: undefined, funder_did: undefined, floor_flags: undefined,
            spec_sealed_bridge_b64: undefined }
        : bounty;
      return json({ hash, bounty: pub, reply_claims: claims ?? [], sightings: sights ?? [] });
    }
    // Decentralized discovery — watcher sightings (direct), platform
    // webhooks (push), Nostr gossip (feed-refresh backfill). The bridge
    // stores/classifies/corroborates; it does not poll these surfaces.
    if (pathname === "/api/sightings" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { sightings?: Record<string, unknown>[] } & Record<string, unknown>;
      const items = Array.isArray(body.sightings) ? body.sightings : [body];
      if (items.length > 50) return json({ error: "batch too large (max 50)" }, 400);
      const results = [];
      const republish = body.republish === true;
      for (const raw of items) {
        // Strip transport-internal auth — only gossip.ts may set it.
        const { auth: _a, republish: _r, ...s } = raw as Record<string, unknown>;
        const sighting = s as unknown as Parameters<typeof ingestSighting>[1];
        const ingested = await ingestSighting(env, sighting);
        // republish:true → also emit as a Nostr kind-30078 event so the
        // sighting propagates peer-to-peer (bridge becomes one publisher
        // among many, not a required hop). Requires NOSTR_SECRET_KEY.
        let gossip: string[] | string = "skipped";
        if (republish) {
          const sk = (env as { NOSTR_SECRET_KEY?: string }).NOSTR_SECRET_KEY;
          if (sk) gossip = await gossipPublishSighting(env, sighting, sk).catch((e) => `error: ${e instanceof Error ? e.message : e}`);
          else gossip = "unconfigured: set NOSTR_SECRET_KEY";
        }
        results.push({ ...ingested, gossip });
      }
      return json({ ok: true, results });
    }
    if (pathname === "/api/sightings" && req.method === "GET") {
      const platform = url.searchParams.get("platform") ?? undefined;
      const since = Number(url.searchParams.get("since")) || undefined;
      const minTier = url.searchParams.get("min_tier") as "lead" | "corroborated" | "disputed" | undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return json({ sightings: await listSightings(env, { platform, since, min_tier: minTier, limit }) });
    }
    if (pathname === "/api/discovery/stats" && req.method === "GET") {
      return json(await discoveryStats(env));
    }
    if (pathname.startsWith("/api/webhooks/") && req.method === "POST") {
      const platform = pathname.split("/").pop() ?? "";
      const r = await handleWebhook(env, platform, req);
      return json(r.body, r.status as 200);
    }
    // Cross-surface identity — trust-minimized bindings. A bind is a public
    // attestation re-verifiable by anyone; never inferred from similarity.
    if (pathname === "/api/identity/challenge" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { did?: string; platform?: string; handle?: string };
      if (!b.did || !b.platform || !b.handle) return json({ error: "did, platform, handle required" }, 400);
      return json({ statement: bindStatement(b.did, b.platform, b.handle), instructions: bindInstructions(b.platform) });
    }
    if (pathname === "/api/identity/bind" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Parameters<typeof registerBinding>[1];
      const r = await registerBinding(env, b);
      return r.ok ? json(r, 201) : json(r, 422);
    }
    if (pathname === "/api/identity/revoke" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Parameters<typeof revokeBinding>[1];
      const r = await revokeBinding(env, b);
      return r.ok ? json(r) : json(r, 422);
    }
    if (pathname === "/api/identity/reverify" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { did?: string; platform?: string; handle?: string };
      if (!b.did || !b.platform || !b.handle) return json({ error: "did, platform, handle required" }, 400);
      const r = await reverifyBinding(env, b.did, b.platform, b.handle);
      return r.ok ? json(r) : json(r, 422);
    }
    if (pathname === "/api/identity/resolve" && req.method === "GET") {
      const platform = url.searchParams.get("platform") ?? "";
      const handle = url.searchParams.get("handle") ?? "";
      if (!platform || !handle) return json({ error: "platform + handle params required" }, 400);
      const r = await resolveHandle(env, platform, handle);
      return r ? json({ platform, handle, ...r }) : json({ platform, handle, bound: false }, 404);
    }
    if (pathname.startsWith("/api/identity/") && req.method === "GET") {
      const did = decodeURIComponent(pathname.split("/").pop() ?? "");
      const bindings = await listBindings(env, did);
      return json({ did, bindings });
    }
    if (pathname === "/api/leaderboard" && req.method === "GET") {
      const recs = await listRecords(env);
      // Aggregate reputation across bound surfaces: every handle a DID has
      // verifiably bound collapses onto the DID's row — rep is portable.
      const bound = await env.CLAIMS.list({ prefix: "idhandle:" });
      const handleToDid = new Map<string, string>();
      for (const k of bound.keys) {
        const v = await env.CLAIMS.get(k.name, "json") as { did?: string } | null;
        if (v?.did) handleToDid.set(k.name.split(":").slice(1).join(":"), v.did);
      }
      const board: Record<string, { accepts: number; rejects: number; paid_usd: number }> = {};
      for (const r of recs) {
        let actor = String((r.claim?.payload as Record<string, unknown> | undefined)?.actor
          ?? (r.claim?.payload as Record<string, unknown> | undefined)?.agent ?? "anon");
        const platform = String((r.claim?.payload as Record<string, unknown> | undefined)?.platform
          ?? (r.domain_evidence as Record<string, unknown> | undefined)?.platform ?? "");
        if (!actor.startsWith("did:")) {
          const did = platform ? handleToDid.get(`${platform.toLowerCase()}:${actor.toLowerCase()}`) : undefined;
          if (did) actor = did;
        }
        const b = board[actor] ??= { accepts: 0, rejects: 0, paid_usd: 0 };
        if (r.status === "rejected" || r.status === "error") b.rejects++;
        else b.accepts++;
        b.paid_usd += Number((r.payout as unknown as Record<string, unknown>)?.amount_usd ?? (r.payout as unknown as Record<string, unknown>)?.amount ?? 0) || 0;
      }
      const rows = Object.entries(board).map(([actor, s]) => ({ actor, ...s, rep: s.accepts / Math.max(1, s.accepts + s.rejects) }))
        .sort((a, b) => b.accepts - a.accepts || b.paid_usd - a.paid_usd).slice(0, 100);
      return json({ generated_at: Date.now(), leaderboard: rows });
    }
    if (pathname === "/api/feed" && req.method === "GET") {
      const doc = await feedDoc(env, ctx);
      const q = {
        forge: url.searchParams.get("forge") ?? undefined,
        source: url.searchParams.get("source") ?? undefined,
        repo: url.searchParams.get("repo") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        min_usd: url.searchParams.get("min_usd") ? Number(url.searchParams.get("min_usd")) : undefined,
        currency: url.searchParams.get("currency") ?? undefined,
        escrow: url.searchParams.get("escrow") ?? undefined,
        sort: (url.searchParams.get("sort") as "reward" | "newest" | "trust" | null) ?? undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        max_competition: url.searchParams.get("max_competition") ? Number(url.searchParams.get("max_competition")) : undefined,
      };
      const page = queryFeed(doc, q);
      return json({
        generated_at: doc.generated_at,
        total: page.records.length,
        next_cursor: page.next_cursor,
        sources: doc.sources,
        records: page.records,
      });
    }
    if (pathname === "/api/feed.rss" && req.method === "GET") {
      const doc = await feedDoc(env, ctx);
      const base = env.PUBLIC_BASE ?? url.origin;
      return new Response(feedRss(doc, base), {
        headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }
    if (pathname === "/api/ops/usage" && req.method === "GET") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const [scanLast, stateDoc, marketsDoc] = await Promise.all([
        env.CLAIMS.get("scan:last").catch(() => null),
        env.CLAIMS.get("state:doc", "json").catch(() => null),
        env.CLAIMS.get("markets:cache", "json").catch(() => null),
      ]);
      return json({
        scan_last: scanLast ? new Date(Number(scanLast)).toISOString() : null,
        state_doc_age_s: (stateDoc as { generated_at?: number } | null)?.generated_at
          ? Math.round((Date.now() - (stateDoc as { generated_at: number }).generated_at) / 1000) : null,
        markets_cache_age_s: (marketsDoc as { generated_at?: number } | null)?.generated_at
          ? Math.round((Date.now() - (marketsDoc as { generated_at: number }).generated_at) / 1000) : null,
        metrics: "Analytics Engine dataset widespread — query in the CF dashboard (blobs: path, method, clientTag; doubles: status, ms)",
      });
    }
    if (pathname === "/poe" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as { type?: string; query?: Array<{ role: string; content: string }> };
      if (body.type && body.type !== "query") return new Response("{}", { headers: { "content-type": "application/json" } });
      const last = body.query?.slice(-1)[0]?.content ?? "";
      const doc = await feedDoc(env, ctx);
      let text: string;
      const low = last.toLowerCase();
      if (/bounty|bounties/.test(low)) {
        const b = await bountiesList(env);
        text = `Widespread bounty board: ${JSON.stringify(b).slice(0, 3000)}`;
      } else if (/market/.test(low)) {
        text = `Open escrowed work markets: ${JSON.stringify(await marketsList(env, {})).slice(0, 3000)}`;
      } else {
        const recs = doc.records.slice(0, 15);
        text = `Widespread — verified-work protocol (https://widespread.fyi). ${doc.records.length} funded-work records across forges. Latest: ${JSON.stringify(recs).slice(0, 2400)} — ask about "bounties", "markets", or search the feed. MCP: https://widespread-bridge.widespread.workers.dev/mcp`;
      }
      const sse = (ev: string, data: unknown) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
      const payload =
        sse("meta", { content_type: "text/markdown", suggested_replies: ["show bounties", "open markets", "how do I earn?"] }) +
        sse("text", { text }) + sse("done", {});
      return new Response(payload, { headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" } });
    }
    if (pathname === "/openapi.json" && req.method === "GET") {
      return json(OPENAPI);
    }
    if (pathname === "/llms.txt" && req.method === "GET") {
      return new Response(LLMS_TXT, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (pathname === "/skill.md" && req.method === "GET") {
      return new Response(SKILL_MD, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (pathname === "/privacy" && req.method === "GET") {
      return new Response(PRIVACY_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (pathname === "/terms" && req.method === "GET") {
      return new Response(TERMS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (pathname === "/icon.png" && req.method === "GET" && env.ASSETS) {
      return env.ASSETS.fetch(new Request(new URL("/icon.png", req.url)));
    }
    if (pathname === "/install" && req.method === "GET") {
      return new Response(INSTALL_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (pathname === "/api/feed.md" && req.method === "GET") {
      return new Response(FEED_MD, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    // MCP endpoint — official SDK Streamable HTTP transport (stateless;
    // spec 2025-11-25: POST tools, GET SSE scaffold, notifications → 202).
    if (pathname === "/mcp" && (req.method === "POST" || req.method === "GET")) {
      return handleMcpRequest(req, env, ctx);
    }
    // Push indexing — bots/relayers upsert records directly.
    if (pathname === "/api/feed/index" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const rec = (await req.json().catch(() => null)) as Partial<FeedRecord> | null;
      if (!rec?.id || !rec.source || !rec.forge || !rec.title || !rec.url) {
        return bad("need {id, source, forge, title, url}", 400);
      }
      const record: FeedRecord = { ...(rec as FeedRecord), updated_at: Date.now() };
      const doc = await feedDoc(env, ctx);
      const idx = doc.records.findIndex((r) => r.id === record.id);
      if (idx >= 0) doc.records[idx] = record; else doc.records.unshift(record);
      doc.records.sort((a, b) => (b.est_usd ?? 0) - (a.est_usd ?? 0)).splice(500);
      await putFeedDoc(env, doc);
      return json({ ok: true, id: record.id }, 201);
    }
    // Client-side execution directory — zero platform compute.
    if (pathname === "/api/runners" && req.method === "GET") {
      return json({ runners: await listRunners(env) });
    }
    if (pathname === "/api/runners" && req.method === "POST") {
      const r = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!r?.kind) return bad("need {kind, isolation, attestation, capabilities}", 400);
      await registerRunner(env, r);
      return json({ ok: true }, 201);
    }
    // Manual refresh — same opportunistic path, on demand.
    if (pathname === "/api/feed/refresh" && req.method === "POST") {
      return json(await refreshFeed(env, ctx));
    }
    // Poidh rail — live sponsor-protocol state on Base (read-only).
    if (pathname === "/api/poidh" && req.method === "GET") {
      return json(await poidhInfo(env).catch((e) => ({ error: String(e) })));
    }
    // Sovereign repo layer — resolve any locator to its verification surface.
    if (pathname === "/api/locator" && req.method === "GET") {
      const u = url.searchParams.get("u") ?? "";
      return u ? json(resolveLocator(u)) : bad("need ?u=<locator>", 400);
    }
    // Mirror board — every detected third-party bounty auto-listed at a
    // marked-up price; status flips to funded when escrow lands on-chain.
    if (pathname === "/api/mirrors" && req.method === "GET") {
      const doc = await feedDoc(env, ctx);
      const status = url.searchParams.get("status");
      let mirrors = doc.mirrors ?? [];
      // Overlay fiat pay-in state — funding records live in KV, mirrors
      // are rebuilt each refresh so state can't live on the listing.
      const escrowKeys = await env.CLAIMS.list({ prefix: "escrowstate:", limit: 100 }).catch(() => null);
      const escrowByMirror = new Map<string, { status: string; usd: string; marketId?: string }>();
      for (const k of escrowKeys?.keys ?? []) {
        const f = await env.CLAIMS.get<{ mirror_id: string; status: string; usd: string; marketId?: string }>(k.name, "json").catch(() => null);
        if (f?.status === "confirmed") escrowByMirror.set(f.mirror_id, f);
      }
      mirrors = mirrors.map((m) => {
        const f = escrowByMirror.get(m.id);
        if (f && m.status === "seeking-funder") {
          return { ...m, status: "funded" as const, funded_market_id: f.marketId ?? m.funded_market_id,
                   fiat: { amount: f.usd, currency: "USD" } };
        }
        return m;
      });
      if (status) mirrors = mirrors.filter((m) => m.status === status);
      return json({ total: mirrors.length, mirrors });
    }
    // Mirror claim lifecycle: claims → verdict → NEAR payout.
    if (pathname === "/api/mirrors/claims" && req.method === "POST") {
      return handleMirrorClaimPost(req, env, ctx);
    }
    if (pathname === "/api/mirrors/claims" && req.method === "GET") {
      return handleMirrorClaimsList(url, env, ctx);
    }
    if (pathname === "/api/mirrors/request-changes" && req.method === "POST") {
      return handleMirrorRequestChanges(req, env);
    }
    if (pathname === "/api/mirrors/claim-timeout" && req.method === "POST") {
      return handleMirrorClaimTimeout(req, env, ctx);
    }
    if (pathname === "/api/mirrors/verdict" && req.method === "POST") {
      return handleMirrorVerdict(req, env, ctx);
    }
    if (pathname === "/api/mirrors/payout" && req.method === "POST") {
      return handleMirrorPayout(req, env, ctx);
    }
    // Manual ops escrow — front NEAR for any mirror (crypto or fiat path).
    if (pathname === "/api/mirrors/escrow" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, string>;
      const mirror = (await feedDoc(env, ctx)).mirrors?.find((m) => m.id === b.mirror_id);
      if (!mirror) return bad("mirror not found", 404);
      try {
        return json({ escrow: await tryOpsEscrow(env, mirror) });
      } catch (e) {
        return bad(`escrow failed: ${e instanceof Error ? e.message : e}`, 500);
      }
    }
    // C4 blind funder: ops-pool escrow for a confidential declared
    // market — on-chain payer = NEAR_OPS_ACCOUNT, on-chain spec = stub.
    // Ops-gated: the real funder settles ops off-chain first.
    // DEPRECATED for new markets: escrow-plan is the trustless lane.
    const declEscrow = pathname.match(/^\/api\/declarations\/([0-9a-f]{8,16})\/escrow$/i);
    if (declEscrow && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      try {
        return json({ escrow: await tryDeclEscrow(env, declEscrow[1]) });
      } catch (e) {
        return bad(`escrow failed: ${e instanceof Error ? e.message : e}`, 500);
      }
    }
    // D5 event log — the signed hash-chained audit trail. Replay it to
    // rebuild state; a fork, rewrite, or bad sig is a fraud proof.
    if (pathname === "/api/events" && req.method === "GET") {
      const { listEvents } = await import("./events");
      return json(await listEvents(env,
        Number(url.searchParams.get("from") ?? 0),
        Math.min(Number(url.searchParams.get("limit") ?? 200), 1000)));
    }
    if (pathname === "/api/events/head" && req.method === "GET") {
      const { listEvents } = await import("./events");
      const { head } = await listEvents(env, 0, 0);
      return json({ head });
    }
    if (pathname === "/api/events/verify" && req.method === "GET") {
      const { verifyChain } = await import("./events");
      return json(await verifyChain(env));
    }
    // D4 dispute layer: public docket + evidence bundles + dispute plan.
    if (pathname === "/api/disputes" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as
        { market_id?: string; claim_id?: string; evidence_cid?: string };
      if (!b.market_id) return bad("market_id required", 400);
      const { disputePlan } = await import("./disputes");
      return json(await disputePlan(env, b.market_id, b.claim_id, b.evidence_cid));
    }
    const dispGet = pathname.match(/^\/api\/disputes\/(\d+)$/);
    if (dispGet && req.method === "GET") {
      const { getDisputes } = await import("./disputes");
      return json({ market_id: dispGet[1], disputes: await getDisputes(env, dispGet[1]) });
    }
    if (pathname === "/api/disputes/bundle" && req.method === "GET") {
      const marketId = url.searchParams.get("market_id");
      if (!marketId) return bad("market_id required", 400);
      const { evidenceBundle } = await import("./disputes");
      return json(await evidenceBundle(env, marketId, url.searchParams.get("claim_id") ?? undefined));
    }
    // Interim arbitrator rulings — the contract account rules until the
    // DAO rotates a Kleros-proxy arbitrator. Ops-gated.
    if (pathname === "/api/disputes/resolve" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const b = (await req.json().catch(() => ({}))) as
        { market_id?: string; claim_id?: string | null; ruling?: string };
      if (!b.market_id || !b.ruling) return bad("market_id + ruling required", 400);
      const { submitRuling } = await import("./disputes");
      return json(await submitRuling(env, b.market_id, b.claim_id ?? null, b.ruling));
    }
    // M-of-N oracle jury: the public tally surface — registered oracles,
    // and per-market verdict votes. Anyone watches a quorum form.
    if (pathname === "/api/oracles" && req.method === "GET") {
      const contract = env.NEAR_CONTRACT;
      if (!contract) return bad("NEAR_CONTRACT not configured", 404);
      const marketId = url.searchParams.get("market");
      const [oracles, verdicts] = await Promise.all([
        nearViewCall(env, contract, "listOracles", {}).catch(() => null),
        marketId
          ? nearViewCall(env, contract, "getVerdicts", { marketId }).catch(() => null)
          : Promise.resolve(null),
      ]);
      return json({ oracles, verdicts });
    }
    // Cast THIS oracle seat's on-chain vote (admin-gated — an operator's
    // own judgment, never caller-supplied verdicts). submitVerdict from
    // the registered owner account + release when quorumM accepts align.
    if (pathname === "/api/oracle/vote" && req.method === "POST") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      const v = (await req.json().catch(() => ({}))) as {
        market_id?: string; claim_id?: string; claim_hash?: string;
        verdict?: "accept" | "reject";
      };
      if (!v.market_id || !v.verdict || (!v.claim_id && !v.claim_hash)) {
        return bad("need market_id, verdict, and claim_id or claim_hash", 400);
      }
      const oc = oracleEnv(env as Parameters<typeof oracleEnv>[0]);
      if (!oc?.accountId || !oc.secretKey) return bad("oracle not configured", 503);
      const { sig } = await signVerdict(oc, v.market_id,
        v.claim_hash ?? v.claim_id ?? "", v.verdict,
        String(Date.now())).catch(() => ({ sig: "", pubkey: "" }));
      const result = await oracleVote(env, oc, {
        marketId: v.market_id, claimId: v.claim_id, claimHash: v.claim_hash,
        verdict: v.verdict, verdictSig: sig || undefined,
      });
      return json(result, result.voted ? 200 : 409);
    }
    // Mirror an external/third-party bounty into a Widespread market at
    // face value — platformBps is our percent cut at release.
    if (pathname === "/api/bounties/mirror" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { record_id?: string; spec?: string };
      return handleMirrorQuote(env, ctx, b);
    }
    // Attested real-submission claims — validate forge artifact, return
    // shipClaim args + HMAC attestation token for on-chain broadcast.
    if (pathname === "/api/claims" && req.method === "POST") {
      const rl = await checkLimit(env, "claims", callerKey(req), 30, 500);
      if (!rl.ok) return rateLimited(rl.retryAfter);
      return handleClaimPost(req, env);
    }
    if (pathname === "/api/claims/verify" && req.method === "GET") {
      return handleClaimVerify(url, env);
    }
    // Kleros dispute seam — binds claimHash+reason as arbitration evidence.
    if (pathname === "/api/dispute" && req.method === "POST") {
      const d = (await req.json().catch(() => ({}))) as {
        repo?: string; market_id?: string; claim_hash?: string; reason?: string; responder?: string;
      };
      if (!d.repo || !d.claim_hash || !d.reason) return bad("need repo, claim_hash, reason", 400);
      return json(await openDispute(env, {
        repo: d.repo, marketId: d.market_id ?? "0", claimHash: d.claim_hash,
        reason: d.reason, responder: d.responder,
      }));
    }
    // Rekor attestation for a shipped commit — permanent public proof.
    if (pathname === "/api/attest" && req.method === "POST") {
      const a = (await req.json().catch(() => ({}))) as { repo?: string; sha?: string; note?: string };
      if (!a.repo || !a.sha) return bad("need repo, sha", 400);
      return json(await attestClaim(env, { repo: a.repo, sha: a.sha, note: a.note }));
    }
    const bountyDel = pathname.match(/^\/api\/bounties\/([a-z0-9-]+\/[a-z0-9-]+)$/i);
    if (bountyDel && req.method === "DELETE") {
      if (!isAuthorized(req, env)) return bad("unauthorized", 401);
      await deleteBounty(env, bountyDel[1]);
      return json({ ok: true });
    }
    return bad("not found", 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const t0 = Date.now();
    const res = await route(req, env, ctx);
    const m = (env as { widespread?: { writeDataPoint: (d: unknown) => void } }).widespread;
    if (m) {
      const u = new URL(req.url);
      const ua = req.headers.get("user-agent") ?? "";
      const tag = ua.includes("HermesAgent") ? "hermes-plugin"
        : u.pathname === "/mcp" ? "mcp-remote" : "web";
      ctx.waitUntil(Promise.resolve(m.writeDataPoint({
        blobs: [u.pathname, req.method, tag],
        doubles: [res.status, Date.now() - t0],
        indexes: [tag],
      })));
    }
    return res;
  },

  // The "picks up the claim" lane: poll each watched repo's claim stream
  // (forge adapter) and run the pipeline on claim entries we haven't seen
  // before. Needs a cron slot —
  // when none is free the /api/state opportunistic scan covers pickup.
  async queue(batch: MessageBatch, _env: Env): Promise<void> {
    // The service has a queue consumer bound at the account level that no
    // code path produces for. Cloudflare now rejects deploys of a script
    // without a queue handler — ack rather than silently retry-loop.
    for (const m of batch.messages) m.ack();
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scan(env).catch((e) => console.error(`scan: ${String(e)}`)));
    ctx.waitUntil(scanMirrorSubmissions(env).catch((e) => console.error(`ingest: ${String(e)}`)));
    ctx.waitUntil(scanDispatchChannels(env).catch((e) => console.error(`collect: ${String(e)}`)));
  },
} satisfies ExportedHandler<Env>;

