import { encodeFunctionData, parseAbi } from "viem";
import { nearView } from "./near";
import type { DispatchRecord, Env, SpendAuth } from "./types";

// Upstream ERC-8183 (MIT, erc-8183/base-contracts) — verified on-chain ABI.
const ABI8183 = parseAbi([
  "function createJob(address provider, address evaluator, uint48 expiredAt, string description, address hook, uint256 providerAgentId) returns (uint256)",
  "function fund(uint256 jobId, address expectedToken, uint256 expectedBudget, bytes optParams)",
  "function complete(uint256 jobId, bytes32 reason, bytes optParams)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/** Platforms we can encode a real posting tx for. Everything else gets a
 * descriptor — never a pretend posting. Bond-gated platforms (termix,
 * claudelance) stay descriptor-only so no performer needs capital. */
const EVM8183_PLATFORMS = new Set(["agentledger", "escroue", "agenthire", "evm8183"]);
const DESCRIPTOR_ONLY = new Set(["termix", "claudelance", "olas", "wurk",
  "virtuals", "fetchai", "agenthansa", "payman", "gokuna",
  "rentahuman", "humanping", "dework", "bountycaster",
  "a2a", "mcp", "rss", "nanda", "x402-bazaar"]);

const PREFIX = "dispatch:";
const PLATFORMS = new Set([...EVM8183_PLATFORMS, ...DESCRIPTOR_ONLY]);

/** AP2-Intent-Mandate-shaped check: a native channel may only be created
 * when a matching, unexpired spend authorization covers its cost. */
export function spendAuthCovers(auth: SpendAuth | undefined, platform: string, cost: number): boolean {
  if (!auth) return false;
  return auth.platform === platform
    && cost <= auth.ceiling
    && auth.expiry > Date.now() / 1000
    && !!auth.authorized_by;
}

export interface DispatchInput {
  market_id: string;
  platforms: string[];
  spend_auth?: SpendAuth[];
  /** Native-platform contract/config overrides: platform → {rpc, contract}. */
  targets?: Record<string, { rpc?: string; contract?: string }>;
  description?: string;
  expired_at?: number; // seconds
}

function safeId(s: string): boolean {
  return /^\d{1,20}$/.test(s);
}

async function hashSpec(spec: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spec));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createDispatch(
  env: Env,
  input: DispatchInput,
  base: string,
): Promise<{ records?: DispatchRecord[]; skipped_no_auth?: string[]; error?: string; status?: number }> {
  if (!safeId(input.market_id)) return { error: "market_id must be a decimal market id", status: 400 };
  if (!Array.isArray(input.platforms) || input.platforms.length < 1 || input.platforms.length > 20) {
    return { error: "platforms must contain 1–20 platform ids", status: 400 };
  }
  const platforms = [...new Set(input.platforms.map((p) => p.toLowerCase()))];
  const unsupported = platforms.filter((p) => !PLATFORMS.has(p));
  if (unsupported.length) {
    return { error: `unsupported platform(s): ${unsupported.join(", ")}`, status: 400 };
  }
  const contract = env.NEAR_CONTRACT;
  if (!contract) return { error: "no NEAR_CONTRACT configured", status: 503 };

  let market: { status?: string; spec?: string; specHash?: string } | null;
  try {
    market = await nearView(env, contract, "getMarket", { marketId: input.market_id }) as typeof market;
  } catch {
    return { error: "market lookup failed", status: 502 };
  }
  if (!market) return { error: "market not found", status: 404 };
  if (market.status !== "open") {
    return { error: `market is not open for claims (status: ${market.status ?? "unknown"})`, status: 409 };
  }
  if (!market.spec?.trim()) return { error: "market has no immutable specification", status: 422 };

  const specHash = market.specHash || await hashSpec(market.spec);
  const description = input.description ?? `Widespread market ${input.market_id} — see ${base}/api/markets?market_id=${input.market_id}`;
  const now = Date.now();
  const skipped: string[] = [];
  const records = await Promise.all(platforms.map(async (platform) => {
    const key = `${PREFIX}${input.market_id}:${platform}`;
    const old = await env.CLAIMS.get<DispatchRecord>(key, "json").catch(() => null);
    if (old) return old;
    const native = EVM8183_PLATFORMS.has(platform);
    const record: DispatchRecord = {
      id: `${input.market_id}:${platform}`,
      market_id: input.market_id,
      platform,
      kind: native ? "native" : "descriptor",
      state: "prepared",
      rail: native ? "platform" : "widespread",
      spec_hash: specHash,
      market_url: `${base}/api/markets?market_id=${input.market_id}`,
      claim_url: `${base}/api/claims`,
      created_at: now,
      updated_at: now,
    };
    if (native) {
      const auth = input.spend_auth?.find((a) => a.platform === platform);
      const target = platform === "agentledger"
        ? { contract: env.AGENTLEDGER_CONTRACT }
        : platform === "evm8183"
          ? { contract: env.EVM8183_CONTRACT }
          : input.targets?.[platform];
      if (!target?.contract || !spendAuthCovers(auth, platform, 0)) {
        skipped.push(platform);
        return null;
      }
      record.spend_auth = auth;
      record.prepared_tx = {
        to: target.contract,
        data: encodeFunctionData({
          abi: ABI8183, functionName: "createJob",
          args: [ZERO, (env.ORACLE_EVM_ADDRESS ?? ZERO) as `0x${string}`,
                 Math.floor(input.expired_at ?? now / 1000 + 14 * 86400),
                 description, ZERO, 0n],
        }),
        chain: platform === "agentledger" ? "celo-sepolia" : platform,
        note: "Funder signs createJob → then fund(jobId, expectedToken, expectedBudget, optParams) with the returned id. The platform's escrow is this job's canonical escrow (rail=platform).",
      };
    }
    await env.CLAIMS.put(key, JSON.stringify(record));
    return record;
  }));
  return { records: records.filter((r): r is DispatchRecord => !!r),
    ...(skipped.length ? { skipped_no_auth: skipped } : {}) };
}

export async function listDispatches(env: Env, marketId?: string): Promise<DispatchRecord[]> {
  const prefix = marketId ? `${PREFIX}${marketId}:` : PREFIX;
  const listed = await env.CLAIMS.list({ prefix, limit: 100 });
  const rows = await Promise.all(listed.keys.map((k) =>
    env.CLAIMS.get<DispatchRecord>(k.name, "json").catch(() => null)));
  return rows.filter((r): r is DispatchRecord => !!r)
    .sort((a, b) => b.created_at - a.created_at);
}

export function agentCard(base: string) {
  return {
    name: "Widespread",
    description: "Permissionless work markets with escrow-bound claims and independent evaluation.",
    url: `${base}/a2a`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    skills: [
      {
        id: "discover-funded-work",
        name: "Discover funded work",
        description: "Discover canonical Widespread markets and read their acceptance specifications through A2A message/send.",
        tags: ["work", "bounties", "discovery"],
        examples: ["Find open funded markets for a capability"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    supportsAuthenticatedExtendedCard: false,
    endpoints: {
      markets: `${base}/api/markets`,
      claims: `${base}/api/claims`,
      evaluator: `${base}/api/evaluate`,
      feed: `${base}/api/feed`,
      rss: `${base}/api/feed.rss`,
      mcp: `${base}/mcp`,
    },
  };
}

export async function handleA2a(
  req: Request,
  discover: () => Promise<unknown>,
): Promise<Response> {
  const body = await req.json().catch(() => null) as {
    jsonrpc?: string; id?: string | number | null; method?: string;
    params?: { message?: { parts?: { kind?: string; text?: string }[] } };
  } | null;
  const fail = (code: number, message: string) => Response.json({
    jsonrpc: "2.0", id: body?.id ?? null, error: { code, message },
  });
  if (!body || body.jsonrpc !== "2.0" || !body.method) return fail(-32600, "invalid JSON-RPC request");
  if (body.method !== "message/send") return fail(-32601, "unsupported A2A method");
  const text = body.params?.message?.parts
    ?.filter((part) => part.kind === "text")
    .map((part) => part.text ?? "")
    .join(" ")
    .trim() ?? "";
  if (!text || text.length > 2000) return fail(-32602, "message must contain 1–2000 characters of text");

  const markets = await discover();
  const data = Array.isArray(markets) ? { markets, total: markets.length } : markets;
  const content = JSON.stringify({ operation: "discover-funded-work", data });
  return Response.json({
    jsonrpc: "2.0",
    id: body.id ?? null,
    result: {
      id: crypto.randomUUID(),
      contextId: crypto.randomUUID(),
      status: { state: "completed" },
      artifacts: [{
        artifactId: "funded-markets",
        parts: [{ kind: "text", text: content }],
      }],
    },
  });
}

/** Confirm a posting — caller reports the platform-side ref (job id / tx
 * hash); the channel flips to active so the collector starts watching. */
export async function markDispatch(
  env: Env,
  marketId: string,
  platform: string,
  ref: string,
  state?: DispatchRecord["state"],
): Promise<DispatchRecord | null> {
  const key = `${PREFIX}${marketId}:${platform}`;
  const rec = await env.CLAIMS.get<DispatchRecord>(key, "json").catch(() => null);
  if (!rec) return null;
  const updated: DispatchRecord = { ...rec, ref, state: state ?? "active", updated_at: Date.now() };
  await env.CLAIMS.put(key, JSON.stringify(updated));
  return updated;
}

/** ERC-8183 complete() calldata — the platform-rail settlement call our
 * evaluator seat signs after adjudication accepts a deliverable. */
export function settleCalldata(jobId: number, reason: `0x${string}`, optParams: `0x${string}` = "0x"): string {
  return encodeFunctionData({
    abi: ABI8183, functionName: "complete",
    args: [BigInt(jobId), reason, optParams],
  });
}
