// feed.ts — unified cross-forge bounty discovery index.
//
// Normalizes funded work items from every connected surface into one
// FeedRecord shape, merges/dedupes/trust-scores them into a single KV
// doc, and serves JSON/Atom/MCP. All upstreams are plain HTTPS with
// bounded timeouts; every source fails independently and stamps its
// own freshness so consumers can see staleness.
//
// Source cadence (per-source min-interval, all inside free-tier budget):
//   near-chain 30m · kv 30m · github 15m · tangled 30m ·
//   forge watchlists 60m · external boards 60m–6h

import { nearView } from "./near";
import { readJobs } from "./evmread";
import { scanMirrorSubmissions } from "./ingest";
import { listBounties, listRecords } from "./store";
import {
  acquireFeedLock, getFeedDoc, getSourceStamp, putFeedDoc,
  putSourceStamp, releaseFeedLock, FEED_TTL_MS, type SourceStamp,
} from "./feedstore";
import type { Env, FeedDoc, FeedRecord, MirrorListing, MirrorOffer } from "./types";

const UA = { "user-agent": "widespread-feed/1.0", accept: "application/json" };
const FETCH_TIMEOUT_MS = 8000;
const MAX_RECORDS = 500;
const DEFAULT_CUT_BPS = 1000; // 10% — platform cut of the bounty at release

/** Platform cut for mirrored third-party bounties. The bounty stays at
 * face value — the payer escrows the ORIGINAL amount and the contract
 * skims cut_bps of `locked` to CUT_SINK at release (on top of the 2% DAO
 * fee). Proportional, so no FX oracle is needed. */
export function cutBps(env: Env): number {
  const n = parseInt(env.CUT_BPS ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? n : DEFAULT_CUT_BPS;
}

export function mirrorOffer(env: Env, amount?: string, currency?: string): MirrorOffer {
  return {
    action: "mirror", endpoint: "createMarket", contract: env.NEAR_CONTRACT,
    cut_bps: cutBps(env),
    ...(amount || currency ? { original: { ...(amount ? { amount } : {}), ...(currency ? { currency } : {}) } } : {}),
    note: `Auto-listed mirror — bounty at face value, platform takes ${cutBps(env) / 100}% cut at release. See GET /api/mirrors; fund via createMarket(platformBps=${cutBps(env)}) and the listing flips to funded automatically.`,
  };
}

// Rough USD estimates for sort only — never settlement truth.
const USD_MAP: Record<string, number> = {
  USD: 1, USDC: 1, USDT: 1, PYUSD: 1, DAI: 1,
  NEAR: 5, SOL: 200, ETH: 3500,
};

function estUsd(amount?: string, currency?: string): number | undefined {
  const n = parseFloat(amount ?? "");
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * (USD_MAP[(currency ?? "").toUpperCase()] ?? 0) * 100) / 100 || undefined;
}

async function fetchJson(url: string, headers: Record<string, string> = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, {
    headers: { ...UA, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const ghHeaders = (env: Env): Record<string, string> =>
  env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};

// ---------------------------------------------------------------- chain

async function pollNearChain(env: Env): Promise<FeedRecord[]> {
  const acct = env.NEAR_CONTRACT;
  if (!acct) return [];
  const markets = (await nearView(env, acct, "listOpen", {})) as
    { marketId: string; payer: string; spec: string; specHash?: string; amount: string; locked: string; deadline: string; status: string }[] | null;
  if (!markets) return [];
  const yocto = 1e24;
  // Competition signal: pending claims per market (bounded — ≤25 view calls)
  const claimsByMarket = new Map<string, { pending: number; claimants: Set<string> }>();
  await Promise.all(markets.slice(0, 25).map(async (m) => {
    const c = await nearView(env, acct, "getClaims", { marketId: m.marketId }) as
      { claims?: { claimant?: string; forgeUserId?: string; status?: string }[]; pending?: number } | null;
    const claimants = new Set<string>();
    let pending = 0;
    for (const cl of c?.claims ?? []) {
      if (cl.status && cl.status !== "pending") continue;
      if (cl.claimant || cl.forgeUserId) claimants.add(String(cl.forgeUserId ?? cl.claimant));
      pending++;
    }
    claimsByMarket.set(m.marketId, { pending: c?.pending ?? pending, claimants });
  }));
  return markets.map((m) => {
    const near = Number(m.locked) / yocto;
    const repoMatch = m.spec.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
    const comp = claimsByMarket.get(m.marketId);
    return {
      id: `near:${acct}:${m.marketId}`,
      source: "near-chain", forge: "near", kind: "bounty",
      ...(repoMatch ? { repo: repoMatch[1], locator: `https://github.com/${repoMatch[1]}` } : {}),
      title: m.spec.slice(0, 140) || `market ${m.marketId}`,
      spec: m.spec,
      amount: near.toFixed(4), currency: "NEAR", est_usd: estUsd(near.toFixed(4), "NEAR"),
      escrow: {
        state: "locked",
        proof: `near:${acct}/${m.marketId}`,
        locked: `${near.toFixed(4)} NEAR`,
        ...(m.deadline ? { deadline: m.deadline } : {}),
      },
      payout: { rails: ["near", "intents", "paypal"], note: "verdict names winningClaimId; oracle settles attested claims only" },
      verification: { required: "attested-real-submission+oracle-verdict", ...(m.specHash ? { spec_hash: m.specHash } : {}) },
      url: `https://testnet.nearblocks.io/address/${acct}`,
      claim: { how: "POST /api/claims → shipClaimArgs → shipClaim on-chain (unbounded, free)", grammar: "@widespread <amount> <spec>" },
      ...(comp && comp.pending > 0 ? { competition: {
        pending_claims: comp.pending,
        unique_claimants: comp.claimants.size,
      } } : {}),
      execution: EXEC_BROWSER,
      updated_at: Date.now(),
    } satisfies FeedRecord;
  });
}

// ------------------------------------------------------------- kv registry

async function pollKvRegistry(env: Env): Promise<FeedRecord[]> {
  const bounties = await listBounties(env);
  return bounties.map((b) => ({
    id: `kv:${b.repo}`,
    source: "kv-registry", forge: "github", kind: "bounty",
    repo: b.repo, locator: `https://github.com/${b.repo}`,
    title: b.spec ? b.spec.slice(0, 140) : `bounty on ${b.repo}`,
    spec: b.spec || undefined,
    amount: b.amount, currency: b.currency, est_usd: estUsd(b.amount, b.currency),
    escrow: { state: "locked", proof: `kv:bounty:${b.repo}` },
    payout: { rails: ["paypal"], note: b.receiver_email ? `paypal:${b.receiver_email}` : undefined },
    verification: { required: "bridge-adjudicator+paypal-payout" },
    url: `https://github.com/${b.repo}`,
    claim: { how: "PR/claim reviewed by bridge → PayPal batch payout", grammar: "@widespread <amount> <spec>" },
    execution: EXEC_BROWSER,
    created_at: b.created_at, updated_at: b.created_at,
  } satisfies FeedRecord));
}

// ----------------------------------------------------------------- github

interface GhIssue {
  number: number; title: string; html_url: string; body?: string | null;
  labels?: { name: string }[]; created_at: string; updated_at: string;
  pull_request?: unknown; user?: { login: string; id: number };
  repository_url?: string;
}

const BOUNTY_TITLE = /bounty|reward|\$\d|paid task/i;

async function ghSearch(env: Env, q: string, perPage = 30): Promise<GhIssue[]> {
  const data = await fetchJson(
    `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&sort=updated`,
    ghHeaders(env),
  ) as { items?: GhIssue[] };
  return (data.items ?? []).filter((i) => !i.pull_request);
}

async function ghRepoIssues(env: Env, repo: string): Promise<GhIssue[]> {
  const data = await fetchJson(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=30`,
    ghHeaders(env),
  ) as GhIssue[];
  return (Array.isArray(data) ? data : []).filter((i) => !i.pull_request);
}

// Third-party bounty signatures found in issue bodies/comments.
const PLATFORM_SIGS: { platform: string; re: RegExp; amountRes: RegExp[] }[] = [
  { platform: "algora", re: /algora\.io\/bounty\/[\w-]+|\/bounty\s*\$?[\d,.]+/i,
    amountRes: [/\$\s*([\d,]+(?:\.\d+)?)/, /\/bounty\s*\$?([\d,]+(?:\.\d+)?)/i,
                /algora[\s\S]{0,80}?\$\s*([\d,]+(?:\.\d+)?)/i] },
  { platform: "issuehunt", re: /issuehunt\.io\/[\w/-]+/i,
    amountRes: [/\$\s*([\d,]+(?:\.\d+)?)/, /reward[\s\S]{0,40}?\$?\s*([\d,]+(?:\.\d+)?)/i] },
  { platform: "polar", re: /polar\.sh\/[\w/-]+/i,
    amountRes: [/\$\s*([\d,]+(?:\.\d+)?)/] },
  { platform: "gitpay", re: /gitpay\.(?:me|dev)\/[\w/-]+/i,
    amountRes: [/\$\s*([\d,]+(?:\.\d+)?)/, /([\d,]+(?:\.\d+)?)\s*(?:USD|USDC|EUR)/i] },
  { platform: "opire", re: /opire\.(?:dev|app)\/[\w/-]+/i,
    amountRes: [/\$\s*([\d,]+(?:\.\d+)?)/] },
];

/** Last-resort amount scrape for generic hits — "$50", "bounty of 200",
 * "[BOUNTY $50]", "reward: $1,000". Returns undefined when nothing parses. */
const GENERIC_AMOUNT_RES = [
  /\[\s*bounty\s*\$?\s*([\d,]+(?:\.\d+)?)\s*\]/i,
  /\bbounty\s+(?:of|for|:)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  /\breward\s+(?:of|:)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i,
  /\$\s*([\d,]+(?:\.\d+)?)\s*(?:usd|usdc|usdt)?\b/i,
];

function scrapeAmount(text: string): string | undefined {
  for (const re of GENERIC_AMOUNT_RES) {
    const m = text.match(re);
    if (m) return m[1].replace(/,/g, "");
  }
  return undefined;
}

function detectPlatform(text: string): { platform: string; ref?: string; amount?: string } | null {
  for (const sig of PLATFORM_SIGS) {
    const m = text.match(sig.re);
    if (m) {
      let amt: string | undefined;
      for (const re of sig.amountRes) {
        amt = text.match(re)?.[1]?.replace(/,/g, "");
        if (amt) break;
      }
      return { platform: sig.platform, ref: m[0].slice(0, 120), amount: amt ?? scrapeAmount(text) };
    }
  }
  return null;
}

const THIRD_PARTY_QUERIES = [
  '"/bounty" in:comments is:issue is:open',
  '"algora" in:comments,is:body is:issue is:open',
  '"issuehunt.io" in:body,comments is:issue is:open',
  '"polar.sh" in:body,comments is:issue is:open',
  '"gitpay" in:body,comments is:issue is:open',
  '"opire" in:body,comments is:issue is:open',
];

// Rotating subset per refresh keeps us inside the 30 req/min search budget
// while covering every signature over successive cycles.
let ghQueryCursor = 0;

function ghIssueToRecord(env: Env, issue: GhIssue, repo: string, opts: {
  source: string; escrow: FeedRecord["escrow"]; amount?: string; currency?: string;
  spec?: string; url?: string; platform?: string;
}): FeedRecord {
  const usd = estUsd(opts.amount, opts.currency);
  const thirdParty = !!opts.platform || opts.source.startsWith("github-thirdparty");
  return {
    id: `${opts.source}:${repo}#${issue.number}`,
    source: opts.source,
    forge: "github",
    kind: "bounty",
    repo, locator: `https://github.com/${repo}`,
    title: issue.title.slice(0, 200),
    ...(opts.spec ? { spec: opts.spec } : {}),
    ...(opts.amount ? { amount: opts.amount } : {}),
    ...(opts.currency ? { currency: opts.currency } : {}),
    ...(usd ? { est_usd: usd } : {}),
    escrow: opts.escrow,
    ...(thirdParty ? { widespread_offer: mirrorOffer(env, opts.amount, opts.currency ?? "USD") } : {}),
    url: opts.url ?? issue.html_url,
    claim: thirdParty
      // Mirror-only policy: external bounties are surfaced exclusively as
      // marked-up Widespread markets — the feed never hands out the
      // source platform's direct-claim path to API consumers.
      ? { how: `mirror only — bounty at face value, platform takes ${cutBps(env) / 100}% cut. Fund via GET /api/mirrors → createMarket(platformBps); claims via POST /api/claims`,
          grammar: "@widespread <amount> <spec>" }
      : {
          how: "PR with 'closes #N' + @widespread grammar",
          grammar: "@widespread <amount> <spec>",
        },
    execution: EXEC_BROWSER,
    created_at: Date.parse(issue.created_at) || undefined,
    updated_at: Date.parse(issue.updated_at) || Date.now(),
  };
}

async function pollGithub(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  const seen = new Set<string>();

  // 1) Our canonical funded label — global search.
  const funded = await ghSearch(env, "label:wide:funded is:issue is:open", 50).catch(() => [] as GhIssue[]);
  for (const issue of funded) {
    const repo = repoFromIssue(issue);
    if (!repo || seen.has(`${repo}#${issue.number}`)) continue;
    seen.add(`${repo}#${issue.number}`);
    const amount = issue.labels?.find((l) => /^wide:funded:\$?[\d.]+/i.test(l.name))?.name
      .replace(/^wide:funded:\$?/i, "") ?? "";
    out.push(ghIssueToRecord(env, issue, repo, {
      source: "github", escrow: { state: "label-only" },
      amount: amount || undefined, currency: "USD",
    }));
  }

  // 2) Third-party signatures — global comment/body search, rotating queries.
  const slice = THIRD_PARTY_QUERIES.slice(ghQueryCursor, ghQueryCursor + 2);
  ghQueryCursor = (ghQueryCursor + 2) % THIRD_PARTY_QUERIES.length;
  for (const q of slice) {
    const hits = await ghSearch(env, q, 20).catch(() => [] as GhIssue[]);
    for (const issue of hits.slice(0, 10)) { // bound comment fetches
      const repo = repoFromIssue(issue);
      if (!repo || seen.has(`${repo}#${issue.number}`)) continue;
      seen.add(`${repo}#${issue.number}`);
      // Fetch comments to find the actual bounty command (search matched
      // somewhere in the thread — body first, then comments).
      const text = `${issue.title}\n${issue.body ?? ""}`;
      let hit = detectPlatform(text);
      let amount: string | undefined;
      if (!hit) {
        const comments = await fetchJson(
          `https://api.github.com/repos/${repo}/issues/${issue.number}/comments?per_page=50`,
          ghHeaders(env),
        ).catch(() => [] as { body?: string }[]);
        for (const c of Array.isArray(comments) ? comments : []) {
          hit = detectPlatform(c.body ?? "");
          if (hit) break;
        }
      }
      // Noise gate: "/bounty" in:comments matches prose too — only record
      // when a platform signature fired OR an amount/bounty-title signal
      // is present. Keeps the index signal-dense for agents.
      const genericAmount = scrapeAmount(`${issue.title}\n${issue.body ?? ""}`);
      if (!hit && !genericAmount && !BOUNTY_TITLE.test(issue.title)) continue;
      if (hit?.amount) amount = hit.amount;
      else if (genericAmount) amount = genericAmount;
      out.push(ghIssueToRecord(env, issue, repo, {
        source: `github-thirdparty:${hit?.platform ?? "generic"}`,
        escrow: { state: "external" }, amount,
        currency: amount ? "USD" : undefined, platform: hit?.platform,
      }));
    }
  }

  // 3) Watched repos — open issues matching bounty-ish signals.
  for (const entry of watchList(env, "github")) {
    const issues = await ghRepoIssues(env, entry).catch(() => [] as GhIssue[]);
    for (const issue of issues) {
      if (!BOUNTY_TITLE.test(issue.title) && !issue.labels?.some((l) => /bounty|reward/i.test(l.name))) continue;
      if (seen.has(`${entry}#${issue.number}`)) continue;
      seen.add(`${entry}#${issue.number}`);
      out.push(ghIssueToRecord(env, issue, entry, {
        source: "github-watch", escrow: { state: "none" },
      }));
    }
  }
  return out;
}

function repoFromIssue(issue: GhIssue): string | null {
  // search API items carry repository_url; issue payloads may not — the
  // html_url always embeds /issues/N under owner/repo.
  const m = issue.html_url?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/\d+/);
  return m ? m[1] : null;
}

// ------------------------------------------------------- tangled / radicle

async function pollTangled(env: Env): Promise<FeedRecord[]> {
  // Bobbin read-only XRPC — verified live Nov 2026: open tickets searchable
  // network-wide without auth.
  const queries = ["bounty", "reward", "paid"];
  const out: FeedRecord[] = [];
  for (const q of queries) {
    const data = await fetchJson(
      `https://api.tangled.org/xrpc/org.tangled.search.query?q=${encodeURIComponent(q)}`,
      {}, 10000,
    ).catch(() => null) as Record<string, unknown> | null;
    if (!data) continue;
    const items = (data.results ?? data.hits ?? data.issues ?? data.tickets ?? []) as Record<string, unknown>[];
    for (const it of Array.isArray(items) ? items : []) {
      const title = String(it.title ?? it.name ?? "").slice(0, 200);
      if (!title) continue;
      const repo = String(it.repo ?? it.repository ?? it.did ?? "");
      const num = it.number ?? it.id ?? it.issue_id ?? "";
      out.push({
        id: `tangled:${repo}#${num}`,
        source: "tangled", forge: "tangled", kind: "bounty",
        ...(repo ? { repo, locator: `https://tangled.org/${repo}` } : {}),
        title,
        escrow: { state: "external" },
        url: String(it.url ?? it.uri ?? `https://tangled.org/${repo}`),
        claim: { how: `mirror only — bounty at face value, platform takes ${cutBps(env) / 100}% cut. Fund via GET /api/mirrors → createMarket(platformBps); claims via POST /api/claims`,
                 grammar: "@widespread <amount> <spec>" },
        execution: EXEC_BROWSER,
        widespread_offer: mirrorOffer(env),
        updated_at: Date.now(),
      });
    }
  }
  return out.slice(0, 100);
}

async function pollForgeWatch(env: Env): Promise<FeedRecord[]> {
  const out: FeedRecord[] = [];
  for (const entry of watchList(env)) {
    const [kind, ...rest] = entry.split(":");
    const target = rest.join(":");
    try {
      if (kind === "rad" && target) {
        const data = await fetchJson(
          `https://seed.radicle.xyz/api/v1/repos/${encodeURIComponent(target)}/issues?state=open`, {}, 10000,
        ).catch(() => null) as Record<string, unknown> | null;
        const issues = ((data?.issues ?? data) as Record<string, unknown>[]);
        for (const it of Array.isArray(issues) ? issues : []) {
          const title = String(it.title ?? "").slice(0, 200);
          if (!title || !BOUNTY_TITLE.test(title)) continue;
          const iid = String(it.id ?? it.number ?? "");
          out.push({
            id: `radicle:${target}#${iid}`, source: "radicle", forge: "radicle",
            kind: "bounty", locator: `rad://${target}`,
            title, escrow: { state: "none" },
            url: `https://app.radicle.xyz/nodes/seed.radicle.xyz/rad:${target}/issues/${iid}`,
            claim: { how: "radicle patch/issue + @widespread grammar", grammar: "@widespread <amount> <spec>" },
            execution: EXEC_BROWSER, updated_at: Date.now(),
          });
        }
      } else if ((kind === "forgejo" || kind === "codeberg" || kind === "gitlab") && target) {
        const [host, path] = target.split("/");
        const api = kind === "gitlab"
          ? `https://${host}/api/v4/projects/${encodeURIComponent(path)}/issues?state=opened&per_page=30`
          : `https://${host}/api/v1/repos/${path}/issues?state=open&limit=30`;
        const data = await fetchJson(api, {}, 10000).catch(() => null);
        const issues = (Array.isArray(data) ? data : (data as Record<string, unknown>)?.data ?? []) as Record<string, unknown>[];
        for (const it of issues) {
          const title = String(it.title ?? "").slice(0, 200);
          if (!title || !BOUNTY_TITLE.test(title)) continue;
          const num = String(it.number ?? it.index ?? "");
          out.push({
            id: `${kind}:${target}#${num}`, source: kind, forge: kind === "gitlab" ? "gitlab" : "forgejo",
            kind: "bounty", locator: `https://${host}/${path}`,
            title, escrow: { state: "none" },
            url: String(it.html_url ?? it.url ?? `https://${host}/${path}/issues/${num}`),
            claim: { how: "forge issue/PR + @widespread grammar", grammar: "@widespread <amount> <spec>" },
            execution: EXEC_BROWSER, updated_at: Date.now(),
          });
        }
      }
    } catch { /* per-repo failure isolated */ }
  }
  return out;
}

// ------------------------------------------------------------- externals

async function pollImmunefi(env: Env): Promise<FeedRecord[]> {
  if (env.FEED_IMMUNEFI !== "1") return [];
  // ~6MB payload — CPU-risky on free tier; opt-in only, 6h cadence.
  const data = await fetchJson("https://immunefi.com/public-api/bounties.json", {}, 20000)
    .catch(() => null) as Record<string, unknown> | null;
  const items = ((data?.bounties ?? data) as Record<string, unknown>[]);
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map((b) => {
    const title = String(b.title ?? b.name ?? "").slice(0, 200);
    const reward = b.reward ?? b.max_reward ?? b.amount;
    const cur = String(b.currency ?? "USD");
    return {
      id: `external:immunefi:${String(b.id ?? b.slug ?? title).slice(0, 60)}`,
      source: "external:immunefi", forge: "generic", kind: "bounty",
      title,
      ...(reward ? { amount: String(reward), currency: cur, est_usd: estUsd(String(reward), cur) } : {}),
      escrow: { state: "external" },
      payout: { rails: ["near", "intents"], note: "mirror market escrow — verdict releases to claimant; source-platform payout is outside this feed" },
      url: String(b.url ?? b.link ?? "https://immunefi.com"),
      widespread_offer: mirrorOffer(env, reward ? String(reward) : undefined, cur),
      updated_at: Date.now(),
    } satisfies FeedRecord;
  }).filter((r) => r.title);
}

async function pollTermix(env: Env): Promise<FeedRecord[]> {
  // TermiX AACP bounty campaigns — public read on per-chain API bases
  // (docs.termix.ai/aacp/network.md). BNB backend is the reachable default;
  // TERMIX_API overrides for the Base/Robinhood deployments.
  const base = env.TERMIX_API ?? "https://platform-backend.prod.termix.live";
  const data = await fetchJson(`${base}/api/v1/campaigns?status=LIVE`)
    .catch(() => null) as Record<string, unknown> | null;
  const items = (Array.isArray(data) ? data
    : (data?.items ?? data?.campaigns ?? data?.data)) as Record<string, unknown>[];
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map((c) => {
    const reward = String(c.rewardPerSlot ?? "");
    const cur = String(c.currency ?? "USDT");
    const slots = Number(c.totalSlots ?? 0) - Number(c.claimedCount ?? 0);
    return {
      id: `termix:${String(c.id).slice(0, 40)}`,
      source: "termix", forge: "generic", kind: "bounty",
      title: String(c.title ?? c.summary ?? "TermiX campaign").slice(0, 200),
      ...(reward ? { amount: reward, currency: cur, est_usd: estUsd(reward, cur) } : {}),
      escrow: { state: "external" },
      payout: { rails: ["usdc", "usdt"], note: `${slots > 0 ? slots : "?"} slots open — face-value rewardPerSlot ${reward} ${cur}; source-platform payout is outside this feed` },
      url: `https://www.termix.ai/`,
      widespread_offer: mirrorOffer(env, reward || undefined, cur),
      updated_at: Date.now(),
    } satisfies FeedRecord;
  }).filter((r) => r.title);
}

async function pollWurk(env: Env): Promise<FeedRecord[]> {
  // WURK job catalog is account-gated (402 without a registered agent key).
  // Activates once WURK_API_KEY is set — see scripts/wurk-register.mjs.
  if (!env.WURK_API_KEY) return [];
  const data = await fetchJson(`${env.WURK_API ?? "https://api.wurk.fun"}/api/agent/jobs`,
    { "x-api-key": env.WURK_API_KEY }).catch(() => null) as Record<string, unknown> | null;
  const items = (Array.isArray(data) ? data
    : (data?.items ?? data?.jobs ?? data?.data)) as Record<string, unknown>[];
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, 100).map((j) => {
    const rw = (j.reward ?? {}) as Record<string, unknown>;
    const perWinner = rw.amount && rw.winnerCount
      ? (parseFloat(String(rw.amount)) / Number(rw.winnerCount)).toFixed(4) : "";
    const cur = String(rw.assetId ?? "USDC");
    return {
      id: `wurk:${String(j.id ?? j.jobId ?? j.description).slice(0, 40)}`,
      source: "wurk", forge: "generic", kind: "bounty",
      title: String(j.title ?? j.description ?? "WURK job").slice(0, 200),
      ...(perWinner ? { amount: perWinner, currency: cur, est_usd: estUsd(perWinner, cur) } : {}),
      escrow: { state: "external" },
      payout: { rails: ["usdc"], note: `${rw.winnerCount ?? "?"} winner draw, ${rw.amount ?? "?"} ${cur} gross pool on ${rw.network ?? "solana"} — source-platform payout is outside this feed` },
      url: String(j.url ?? "https://wurk.fun/"),
      widespread_offer: mirrorOffer(env, perWinner || undefined, cur),
      updated_at: Date.now(),
    } satisfies FeedRecord;
  }).filter((r) => r.title);
}

// AgentLedger (ERC-8183, Celo Sepolia) — on-chain read, no API. Mirrors
// Open/Funded jobs at face value; payout settles on the source chain.
async function pollAgentLedger(env: Env): Promise<FeedRecord[]> {
  const rpc = env.AGENTLEDGER_RPC ?? "https://forno.celo-sepolia.celo-testnet.org";
  const contract = env.AGENTLEDGER_CONTRACT ?? "0x6262a72674F824a2c67fEDE85b56e096eD72B543";
  const jobs = await readJobs(rpc, contract, 50).catch(() => []);
  return jobs
    .filter(({ job }) => job.status <= 1) // Open or Funded — earnable
    .map(({ id, job }) => {
      const usdc = (Number(job.budget) / 1e6).toFixed(2);
      return {
        id: `agentledger:${id}`,
        source: "agentledger", forge: "generic", kind: "bounty",
        title: job.description.slice(0, 200) || `AgentLedger job #${id}`,
        amount: usdc, currency: "USDC", est_usd: Number(usdc),
        escrow: { state: "external" },
        payout: { rails: ["usdc"], note: `ERC-8183 job #${id} on Celo Sepolia (status ${job.status}, expires ${new Date(Number(job.expiredAt) * 1000).toISOString().slice(0, 10)}) — source-platform payout is outside this feed` },
        url: "https://agentledger.paracausal.tech",
        widespread_offer: mirrorOffer(env, usdc, "USDC"),
        updated_at: Date.now(),
      } satisfies FeedRecord;
    });
}

// ----------------------------------------------------------------- merge

const SOURCE_INTERVALS: Record<string, number> = {
  "near-chain": FEED_TTL_MS, "kv-registry": FEED_TTL_MS,
  github: 15 * 60 * 1000, tangled: FEED_TTL_MS,
  forgejo: 60 * 60 * 1000, codeberg: 60 * 60 * 1000, gitlab: 60 * 60 * 1000,
  radicle: 60 * 60 * 1000, "external:immunefi": 6 * 60 * 60 * 1000,
  termix: 30 * 60 * 1000, wurk: 30 * 60 * 1000,
  agentledger: 30 * 60 * 1000,
};

async function runSource(env: Env, name: string, fn: () => Promise<FeedRecord[]>): Promise<{ stamp: SourceStamp; records: FeedRecord[] }> {
  const minInterval = SOURCE_INTERVALS[name] ?? FEED_TTL_MS;
  const prev = await getSourceStamp(env, name);
  if (prev && Date.now() - prev.fetched_at < minInterval) {
    return { stamp: prev, records: [] };
  }
  try {
    const records = await fn();
    const stamp: SourceStamp = { ok: true, count: records.length, fetched_at: Date.now() };
    await putSourceStamp(env, name, stamp);
    return { stamp, records };
  } catch (e) {
    const stamp: SourceStamp = { ok: false, count: 0, error: String(e).slice(0, 200), fetched_at: Date.now() };
    await putSourceStamp(env, name, stamp);
    return { stamp, records: [] };
  }
}

/** Per-repo trust stats from the review-record index — computed once per
 * refresh, attached to records by repo key. */
async function trustIndex(env: Env): Promise<Map<string, NonNullable<FeedRecord["trust"]>>> {
  const records = await listRecords(env).catch(() => []);
  const map = new Map<string, { claims: number; paid: number }>();
  for (const r of records) {
    const cur = map.get(r.repo) ?? { claims: 0, paid: 0 };
    cur.claims++;
    if (r.status === "accepted_paid") cur.paid++;
    map.set(r.repo, cur);
  }
  const out = new Map<string, NonNullable<FeedRecord["trust"]>>();
  for (const [repo, s] of map) {
    out.set(repo, {
      repo_claims: s.claims, repo_paid: s.paid,
      repo_pass_rate: s.claims ? Math.round((s.paid / s.claims) * 100) / 100 : 0,
    });
  }
  return out;
}

function watchList(env: Env, kind?: string): string[] {
  return (env.FORGE_WATCH ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .filter((e) => !kind || e.startsWith(`${kind}:`))
    .map((e) => e.slice(e.indexOf(":") + 1));
}

const EXEC_BROWSER = {
  recommended: "browser-tab (Pyodide/isomorphic-git)",
  isolation: "wasm-sandbox",
  alternatives: ["self-hosted sealed runner", "community runner"],
  note: "run repo code client-side in a browser sandbox or your own sealed runner — never on a bare host; see /api/runners",
};

/** Refresh the materialized feed doc. Single-flight via KV lock; each
 * source honors its own min-interval so a 30-min doc TTL doesn't mean
 * 30-min upstream polling for every source. */
export async function refreshFeed(env: Env, ctx?: ExecutionContext): Promise<FeedDoc> {
  const locked = await acquireFeedLock(env);
  if (!locked) {
    const existing = await getFeedDoc(env);
    if (existing) return existing;
  }
  try {
    const [nearR, kvR, ghR, tgR, fwR, imR, txR, wkR, alR, trust] = await Promise.all([
      runSource(env, "near-chain", () => pollNearChain(env)),
      runSource(env, "kv-registry", () => pollKvRegistry(env)),
      runSource(env, "github", () => pollGithub(env)),
      runSource(env, "tangled", () => pollTangled(env)),
      runSource(env, "forgejo", () => pollForgeWatch(env)),
      runSource(env, "external:immunefi", () => pollImmunefi(env)),
      runSource(env, "termix", () => pollTermix(env)),
      runSource(env, "wurk", () => pollWurk(env)),
      runSource(env, "agentledger", () => pollAgentLedger(env)),
      trustIndex(env),
    ]);
    const sources: FeedDoc["sources"] = {};
    for (const [name, r] of Object.entries({
      "near-chain": nearR, "kv-registry": kvR, github: ghR, tangled: tgR,
      forgejo: fwR, "external:immunefi": imR, termix: txR, wurk: wkR,
      agentledger: alR,
    })) sources[name] = r.stamp;

    // Merge: fresh records replace stale ones by id; records from
    // interval-skipped sources aren't re-fetched — keep prior doc's copies.
    const prior = await getFeedDoc(env);
    const byId = new Map<string, FeedRecord>();
    for (const r of prior?.records ?? []) byId.set(r.id, r);
    for (const r of [...nearR.records, ...kvR.records, ...ghR.records, ...tgR.records, ...fwR.records, ...imR.records, ...txR.records, ...wkR.records, ...alR.records]) {
      const t = r.repo ? trust.get(r.repo) : undefined;
      byId.set(r.id, { ...r, ...(t ? { trust: t } : {}) });
    }

    const records = [...byId.values()]
      .sort((a, b) => (b.est_usd ?? 0) - (a.est_usd ?? 0) || b.updated_at - a.updated_at)
      .slice(0, MAX_RECORDS);

    // Automatic mirror monetization: every external/third-party record
    // gets a marked-up market listing; funded ones are detected by
    // specHash match against on-chain markets — no manual step.
    const mirrors = await buildMirrors(env, records, prior?.mirrors);

    const doc: FeedDoc = { generated_at: Date.now(), sources, records, mirrors };
    await putFeedDoc(env, doc);
    // Auto-ingest submissions on funded mirrors — agents keep using the
    // original forge flow (PRs on the issue); we file attested claims.
    if (ctx) ctx.waitUntil(scanMirrorSubmissions(env).catch((e) => console.error(`ingest: ${String(e)}`)));
    return doc;
  } finally {
    if (locked) await releaseFeedLock(env);
  }
}

/** Read path: serve the doc; if stale/missing, refresh opportunistically
 * in the background (ctx.waitUntil) — never blocks the request on upstreams. */
export async function feedDoc(env: Env, ctx?: ExecutionContext): Promise<FeedDoc> {
  const doc = await getFeedDoc(env);
  const stale = !doc || Date.now() - doc.generated_at > FEED_TTL_MS;
  if (stale) {
    const p = refreshFeed(env, ctx).catch((e) => {
      console.error(`feed refresh: ${String(e)}`);
      return null;
    });
    if (ctx) ctx.waitUntil(p);
    else if (!doc) {
      // cold start with no request ctx: wait once and serve the fresh doc
      const fresh = await p;
      return fresh ?? { generated_at: 0, sources: {}, records: [] };
    } else void p; // stale doc: serve last-good, refresh behind
  }
  return doc ?? { generated_at: 0, sources: {}, records: [] };
}

// ------------------------------------------------------------ mirror offer

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The spec text a mirror market commits to — shared by auto-listings and
 * the manual mirror endpoint so specHash matching is exact. */
function mirrorSpec(rec: FeedRecord, override?: string): string {
  return override ?? rec.spec ?? `${rec.title}\n\nSource: ${rec.url}`;
}

function isMirrorable(rec: FeedRecord): boolean {
  return rec.escrow.state === "external"
    || rec.source.startsWith("github-thirdparty")
    || rec.source.startsWith("external:");
}

function mirrorArgs(env: Env, rec: FeedRecord, spec: string, specHash: string): Record<string, unknown> {
  const bps = cutBps(env);
  const sink = env.CUT_SINK ?? "widespread-dao.near";
  return {
    specHash, spec,
    deadline: String(BigInt(Date.now()) * 1000000n + 14n * 24n * 3600n * 1000000000n),
    acceptanceRule: "best verified claim wins (attested submissions only)",
    platformBps: bps, platformTo: sink,
  };
}

function claimantShare(rec: FeedRecord, bps: number): MirrorListing["claimant_share"] {
  const n = parseFloat(rec.amount ?? "");
  if (!Number.isFinite(n) || !rec.currency) return undefined;
  // what the winning claimant nets after the platform cut (before the
  // 2% DAO fee, which is protocol-wide)
  const amt = (n * (10000 - bps) / 10000).toFixed(2).replace(/\.?0+$/, "");
  const usd = estUsd(amt, rec.currency);
  return { amount: amt, currency: rec.currency, ...(usd ? { est_usd: usd } : {}) };
}

/** Auto-mirror pass: every external record gets a MirrorListing with
 * ready createMarketArgs. Status flips to "funded" when an on-chain
 * market commits the same specHash — detection is automatic each refresh. */
async function buildMirrors(env: Env, records: FeedRecord[], prior: MirrorListing[] | undefined): Promise<MirrorListing[]> {
  const bps = cutBps(env);
  const priorById = new Map((prior ?? []).map((m) => [m.record_id, m]));
  // specHash → near-chain market, for funded detection
  const fundedBySpec = new Map<string, string>();
  for (const r of records) {
    if (r.source === "near-chain" && r.verification?.spec_hash) {
      const mid = r.escrow.proof?.match(/near:[^/]+\/(\d+)/)?.[1];
      if (mid) fundedBySpec.set(r.verification.spec_hash, mid);
    }
  }
  const out: MirrorListing[] = [];
  for (const rec of records) {
    if (!isMirrorable(rec)) continue;
    const spec = mirrorSpec(rec);
    const specHash = "sha256:" + await sha256Hex(spec);
    const prev = priorById.get(rec.id);
    const fundedMid = fundedBySpec.get(specHash);
    out.push({
      id: `mirror:${rec.id}`,
      record_id: rec.id,
      title: rec.title, url: rec.url,
      ...(rec.repo ? { repo: rec.repo } : {}),
      ...(rec.amount || rec.currency || rec.est_usd
        ? { original: { ...(rec.amount ? { amount: rec.amount } : {}), ...(rec.currency ? { currency: rec.currency } : {}), ...(rec.est_usd ? { est_usd: rec.est_usd } : {}) } }
        : {}),
      cut_bps: bps,
      ...(() => { const mu = claimantShare(rec, bps); return mu ? { claimant_share: mu } : {}; })(),
      spec, spec_hash: specHash,
      createMarketArgs: mirrorArgs(env, rec, spec, specHash),
      status: fundedMid ? "funded" : "seeking-funder",
      ...(fundedMid ? { funded_market_id: fundedMid } : {}),
      created_at: prev?.created_at ?? Date.now(),
      updated_at: Date.now(),
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** POST /api/bounties/mirror {record_id} — turn an external/third-party feed
 * record into a concrete Widespread market quote at FACE VALUE. Stateless:
 * the payer signs createMarket themselves (bridge holds no NEAR key);
 * platformBps is our percent cut skimmed from the escrow at release. */
export async function handleMirrorQuote(env: Env, ctx: ExecutionContext | undefined, body: { record_id?: string; spec?: string }): Promise<Response> {
  if (!body.record_id) return Response.json({ ok: false, error: "record_id required" }, { status: 400 });
  const doc = await feedDoc(env, ctx);
  const rec = doc.records.find((r) => r.id === body.record_id);
  if (!rec) return Response.json({ ok: false, error: "record not found", record_id: body.record_id }, { status: 404 });
  if (!isMirrorable(rec)) {
    return Response.json({ ok: false, error: "only external/third-party records can be mirrored — Widespread-native markets are already ours" }, { status: 422 });
  }
  const spec = mirrorSpec(rec, body.spec);
  const specHash = "sha256:" + await sha256Hex(spec);
  const bps = cutBps(env);
  const sink = env.CUT_SINK ?? "widespread-dao.near";
  const auto = doc.mirrors?.find((m) => m.record_id === rec.id);
  return Response.json({
    ok: true,
    mirror_id: auto?.id ?? `mirror:${rec.id}`,
    ...(auto?.status === "funded" ? { already_funded: { market_id: auto.funded_market_id } } : {}),
    record: { id: rec.id, title: rec.title, url: rec.url, amount: rec.amount, currency: rec.currency, est_usd: rec.est_usd },
    mirror: {
      cut_bps: bps,
      platformTo: sink,
      status: auto?.status ?? "seeking-funder",
      note: `Bounty escrowed at face value; on verdict release the contract skims ${bps / 100}% to ${sink} (plus the 2% protocol fee) and pays the claimant the rest.`,
    },
    createMarketArgs: mirrorArgs(env, rec, spec, specHash),
    mirroredFrom: rec.id,
    next: `Sign createMarket on ${env.NEAR_CONTRACT} attaching the face-value NEAR deposit — the mirror flips to "funded" automatically on the next feed refresh. Agents then claim via POST /api/claims.`,
  }, { status: 201 });
}

// ------------------------------------------------------------ api shaping

export interface FeedQuery {
  forge?: string; source?: string; repo?: string; q?: string;
  min_usd?: number; currency?: string; escrow?: string;
  sort?: "reward" | "newest" | "trust"; limit?: number; cursor?: string;
  max_competition?: number;
}

export function queryFeed(doc: FeedDoc, q: FeedQuery): { records: FeedRecord[]; next_cursor: string | null } {
  let recs = doc.records;
  if (q.forge) recs = recs.filter((r) => r.forge === q.forge || r.source === q.forge);
  if (q.source) recs = recs.filter((r) => r.source === q.source || r.source.startsWith(`${q.source}:`));
  if (q.repo) { const needle = q.repo.toLowerCase(); recs = recs.filter((r) => r.repo?.toLowerCase() === needle || r.locator?.toLowerCase().includes(needle)); }
  if (q.q) { const needle = q.q.toLowerCase(); recs = recs.filter((r) => `${r.title} ${r.spec ?? ""}`.toLowerCase().includes(needle)); }
  if (q.min_usd !== undefined) recs = recs.filter((r) => (r.est_usd ?? 0) >= q.min_usd!);
  if (q.currency) recs = recs.filter((r) => (r.currency ?? "").toUpperCase() === q.currency!.toUpperCase());
  if (q.escrow) recs = recs.filter((r) => r.escrow.state === q.escrow);
  if (q.max_competition !== undefined) recs = recs.filter((r) => (r.competition?.pending_claims ?? 0) <= q.max_competition!);

  const sort = q.sort ?? "reward";
  recs = [...recs].sort((a, b) => {
    if (sort === "newest") return b.updated_at - a.updated_at;
    if (sort === "trust") {
      const ta = (a.est_usd ?? 0) * (a.escrow.state === "locked" ? 1 : a.escrow.state === "external" ? 0.4 : 0.2) * (a.trust?.repo_pass_rate ?? 0.5);
      const tb = (b.est_usd ?? 0) * (b.escrow.state === "locked" ? 1 : b.escrow.state === "external" ? 0.4 : 0.2) * (b.trust?.repo_pass_rate ?? 0.5);
      return tb - ta;
    }
    return (b.est_usd ?? 0) - (a.est_usd ?? 0) || b.updated_at - a.updated_at;
  });

  // Cursor = offset into the sorted list (stable while doc is stable).
  const offset = q.cursor ? Math.max(0, parseInt(q.cursor, 10) || 0) : 0;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const page = recs.slice(offset, offset + limit);
  const next = offset + limit < recs.length ? String(offset + limit) : null;
  return { records: page, next_cursor: next };
}

// -------------------------------------------------------------------- rss

export function feedRss(doc: FeedDoc, base: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const items = doc.records.slice(0, 50).map((r) => `  <entry>
    <title>${esc(r.title)}</title>
    <link href="${esc(r.url)}"/>
    <id>${esc(r.id)}</id>
    <updated>${new Date(r.updated_at).toISOString()}</updated>
    <summary>${esc(`${r.forge} · ${r.amount ?? "?"} ${r.currency ?? ""} · escrow:${r.escrow.state}${r.competition?.pending_claims ? ` · ${r.competition.pending_claims} claims` : ""}`)}</summary>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Widespread Forge Bounty Feed</title>
  <link href="${esc(base)}/api/feed"/>
  <updated>${new Date(doc.generated_at || Date.now()).toISOString()}</updated>
  <id>${esc(base)}/api/feed</id>
${items}
</feed>`;
}

// -------------------------------------------------------------------- mcp

const MCP_TOOLS = [
  {
    name: "feed_search",
    description: "Search the unified cross-forge bounty feed. Filter by forge, source, repo, min USD, currency, escrow state, max competition; sort by reward|newest|trust.",
    inputSchema: {
      type: "object",
      properties: {
        forge: { type: "string" }, source: { type: "string" }, repo: { type: "string" },
        q: { type: "string" }, min_usd: { type: "number" }, currency: { type: "string" },
        escrow: { type: "string", enum: ["locked", "label-only", "external", "none"] },
        sort: { type: "string", enum: ["reward", "newest", "trust"] },
        limit: { type: "number" }, cursor: { type: "string" }, max_competition: { type: "number" },
      },
    },
  },
  {
    name: "feed_get",
    description: "Get one feed record by id (e.g. 'gh:owner/repo#12', 'near:acct:7').",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "feed_stats",
    description: "Feed health: record count, per-source status/freshness, generated_at.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "runners_list",
    description: "List client-side sealed execution environments agents can run bounty work in (browser sandbox, self-hosted sealed runners). Zero platform compute — the client is the sandbox.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleMcp(env: Env, body: Record<string, unknown>, ctx?: ExecutionContext): Promise<Response | null> {
  const method = String(body.method ?? "");
  const id = body.id;
  const reply = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
      headers: { "content-type": "application/json" },
    });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "widespread-feed", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const doc = await feedDoc(env, ctx);
      const args = params?.arguments ?? {};
      let result: unknown;
      switch (params?.name) {
        case "feed_search": {
          const page = queryFeed(doc, args as FeedQuery);
          result = { ...page, total_matched: page.records.length, generated_at: doc.generated_at };
          break;
        }
        case "feed_get": {
          const rec = doc.records.find((r) => r.id === args.id);
          result = rec ?? { error: "not found" };
          break;
        }
        case "feed_stats": {
          result = {
            generated_at: doc.generated_at,
            total: doc.records.length,
            sources: doc.sources,
          };
          break;
        }
        case "runners_list": {
          result = { runners: RUNNERS };
          break;
        }
        default:
          return reply({ content: [{ type: "text", text: `unknown tool: ${params?.name}` }], isError: true });
      }
      return reply({
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }
    default:
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: id ?? null,
        error: { code: -32601, message: `method not found: ${method}` },
      }), { headers: { "content-type": "application/json" } });
  }
}

// --------------------------------------------------------------- runners

export const RUNNERS = [
  {
    id: "browser-tab", kind: "browser-tab",
    isolation: "wasm-sandbox (Pyodide + isomorphic-git)",
    attestation: "wasm-isolation-marker",
    capabilities: ["clone", "diff", "build(py)", "test(py)", "push"],
    endpoint: null,
    note: "default — the Hermes browser tab or any Pyodide/WebContainer-style sandbox; zero platform resources",
  },
  {
    id: "self-hosted-compartment", kind: "self-hosted",
    isolation: "microvm + vTPM PCR + DLP egress",
    attestation: "vtpm-pcr",
    capabilities: ["clone", "build", "test", "push", "attest"],
    endpoint: null,
    note: "agent's own omarchy-compartment / gVisor / E2B instance — register via POST /api/runners",
  },
] as const;

export async function listRunners(env: Env): Promise<unknown[]> {
  const custom = await env.CLAIMS.get<unknown[]>("feed:runners", "json").catch(() => null);
  return [...RUNNERS, ...(custom ?? [])];
}

export async function registerRunner(env: Env, runner: Record<string, unknown>): Promise<void> {
  const list = (await env.CLAIMS.get<unknown[]>("feed:runners", "json").catch(() => null)) ?? [];
  list.push({ ...runner, registered_at: Date.now() });
  await env.CLAIMS.put("feed:runners", JSON.stringify(list.slice(-100)));
}

// ---------------------------------------------------------------- feed.md

export const FEED_MD = `# Widespread Forge Bounty Feed

One normalized, machine-readable index of funded work across every forge
surface Widespread touches — so agents never build their own scanners.

## Endpoints

- \`GET /api/feed\` — JSON. Filters: \`forge\`, \`source\`, \`repo\`, \`q\`,
  \`min_usd\`, \`currency\`, \`escrow\` (locked|label-only|external|none),
  \`sort\` (reward|newest|trust), \`max_competition\`, \`limit\` (≤500),
  \`cursor\`.
- \`GET /api/feed.rss\` — Atom 1.0.
- \`POST /mcp\` — MCP JSON-RPC: \`initialize\`, \`tools/list\`,
  \`tools/call\` (\`feed_search\`, \`feed_get\`, \`feed_stats\`, \`runners_list\`).
- \`GET /api/runners\` — client-side sealed execution environments.
- \`POST /api/feed/index\` — push indexing (bot/relayer).

## Record schema

\`{id, source, forge, kind, repo, locator, title, spec, amount, currency,
est_usd, escrow{state,proof,locked,deadline}, payout{rails},
verification{required,spec_hash}, url, claim{how,grammar},
execution{recommended,isolation}, trust{repo_claims,repo_paid,
repo_pass_rate}, competition{pending_claims,unique_claimants},
widespread_offer?, created_at, updated_at}\`

## Trust model

- \`escrow.state:"locked"\` = funds verifiably escrowed (NEAR chain or KV pool)
- \`"label-only"\` = forge label claims funding, unverified
- \`"external"\` = third-party board listing — **mirror-only**: surfaced
  exclusively as marked-up Widespread markets (\`GET /api/mirrors\`).
  API consumers get no direct-claim path to the source platform; work
  routes through our escrow + verification or not at all.
- \`sort=trust\` = est_usd × escrow confidence × repo pass rate
- \`competition\` shows claim pressure — agents can skip crowded bounties
  (\`max_competition=N\` filter); the market itself never caps submissions.

## Claiming

Widespread markets: \`@widespread <amount> <spec>\` grammar or
\`POST /api/claims\`:

\`\`\`json
POST /api/claims
{ "marketId": "7", "forgeRef": "https://github.com/o/r/pull/12",
  "claimant": "<near-account>", "actor": "<agent-did>" }
→ { "ok": true, "attested": true,
    "verification": { "endpoint": "/api/claims/verify", "token": "…" },
    "shipClaimArgs": { … } }
\`\`\`

The bridge validates the real submission (market open, forge artifact
resolves, author = numeric forge ID — GitHub user ID is the anti-sybil
key, NEAR account is payout-only, non-empty patch fingerprint, spec-hash
binding) and returns \`shipClaimArgs\` + an HMAC \`attestation\` token.
Broadcast \`shipClaim\` on the market contract from any NEAR account —
claims are **unbounded** (no cap, no bond, no deposit). The verdict names
\`winningClaimId\`; losers stay on-chain as \`outcompeted\` reputation
records. \`GET /api/claims/verify?token=\` re-checks any attestation;
oracle verdicts only settle \`attested:true\` claims — direct contract
calls without a token are ineligible for reward.

External listings are **auto-mirrored**: every detected third-party
bounty gets a \`MirrorListing\` on \`GET /api/mirrors\` at **face value** —
the bounty price is never marked up. Instead the platform takes a
percent cut (\`CUT_BPS\`, default 10%) skimmed from the escrow at
release. Each listing carries ready \`createMarketArgs\`; a payer funds
the face-value escrow, the contract pays the claimant minus our cut,
and the listing flips \`seeking-funder → funded\` automatically when
the specHash lands on-chain. \`POST /api/bounties/mirror {record_id}\`
returns the same args for a specific record. Agents then discover the
market via this feed (\`source:"near-chain"\`) and claim via
\`POST /api/claims\`.

**Fiat pay-in:** mirrors with a USD price accept card/PayPal payment at
the face-value amount — \`POST /api/mirrors/fund {mirror_id}\` creates
a PayPal order and returns an \`approve_url\`; after the payer approves,
\`POST /api/mirrors/capture {mirror_id, order_id}\` captures it and the
mirror flips to \`fiat-funded\`. Ops then fronts NEAR escrow at face
value (\`platformBps\` = the same cut) or settles the winner via PayPal
Payouts at the post-cut amount.

## Execution safety

Run repo code client-side (browser sandbox) or in your own sealed runner —
see \`/api/runners\`. Never on a bare host.

## Sources & freshness

near-chain · kv-registry · github (label + third-party signatures +
watchlist) · tangled · radicle/forgejo/gitlab watchlists ·
external:immunefi (opt-in). Per-source status in \`GET /api/feed\` →
\`sources\`. Doc refreshes ≤ every 30 min; sources have individual
min-intervals. Stale source = last-good data + \`sources[name].error\`.
`;
