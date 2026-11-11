// collect.ts — watch dispatched channels for deliverables.
// Mirrors ingest.ts: bounded scan, KV dedupe, failures per-channel.
// rail=widespread channels point workers at /api/claims — nothing to poll
// there. Native channels (rail=platform) get their on-chain/API state read
// here; the canonical escrow still settles exactly once.
import { evmCall, decodeJob } from "./evmread";
import type { DispatchRecord, Env } from "./types";

const SEL_GETJOB = "0xbf22c457"; // getJob(uint256)
const MAX_CHANNELS = 25;

export interface DispatchSubmission {
  channel_id: string;
  platform: string;
  ref: string;
  submission_id: string;
  deliverable_ref?: string;
  note?: string;
  received_at: number;
}

const pad64 = (n: bigint) => n.toString(16).padStart(64, "0");

async function collectEvm(env: Env, rec: DispatchRecord, rpc: string, contract: string): Promise<DispatchSubmission[]> {
  const jobId = BigInt(rec.ref!);
  const hex = await evmCall(rpc, contract, SEL_GETJOB + pad64(jobId));
  const job = hex ? decodeJob(hex) : null;
  if (!job) return [];
  // 8183 statuses: 0 Open 1 Funded 2 Submitted 3 Completed 4 Rejected 5 Expired
  if (job.status === 2) {
    const sid = `submitted-${jobId}`;
    return [{
      channel_id: rec.id, platform: rec.platform, ref: rec.ref!,
      submission_id: sid,
      note: "job submitted on platform escrow — deliverable hash bound on-chain via Submitted; evaluator verdict calls complete()/reject()",
      received_at: Date.now(),
    }];
  }
  return [];
}

async function collectWurk(env: Env, rec: DispatchRecord): Promise<DispatchSubmission[]> {
  const base = (env.WURK_API ?? "https://api.wurk.fun").replace(/\/$/, "");
  const res = await fetch(`${base}/api/agent/jobs/${rec.ref}/submissions`, {
    headers: { authorization: `Bearer ${env.WURK_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as { data?: { submissions?: unknown[] } } | null;
  const subs = body?.data?.submissions;
  if (!Array.isArray(subs)) return [];
  return subs.slice(0, 50).map((sub, i) => {
    const o = (sub ?? {}) as Record<string, unknown>;
    return {
      channel_id: rec.id, platform: "wurk", ref: rec.ref!,
      submission_id: String(o.id ?? o.submission_id ?? i),
      deliverable_ref: typeof o.content === "string" ? o.content.slice(0, 500) : undefined,
      received_at: Date.now(),
    };
  });
}

/** Poll every active native/tracked channel once; dedupe submissions by
 * `dispatch-sub:{market}:{platform}:{sid}` — the same deliverable arriving
 * on two channels files once, first-submission timestamp wins. */
export async function scanDispatchChannels(env: Env): Promise<{ scanned: number; submissions: number }> {
  const listed = await env.CLAIMS.list({ prefix: "dispatch:", limit: 100 }).catch(() => null);
  const channels = (await Promise.all((listed?.keys ?? []).map((k) =>
    env.CLAIMS.get<DispatchRecord>(k.name, "json").catch(() => null))))
    .filter((r): r is DispatchRecord => !!r && r.state === "active" && !!r.ref)
    .slice(0, MAX_CHANNELS);

  let count = 0;
  for (const rec of channels) {
    const subs: DispatchSubmission[] = [];
    try {
      if (rec.platform === "agentledger" && env.AGENTLEDGER_RPC && env.AGENTLEDGER_CONTRACT) {
        subs.push(...await collectEvm(env, rec, env.AGENTLEDGER_RPC, env.AGENTLEDGER_CONTRACT));
      } else if ((rec.platform === "evm8183" || rec.platform === "escroue" || rec.platform === "agenthire") && env.EVM8183_RPC && env.EVM8183_CONTRACT) {
        subs.push(...await collectEvm(env, rec, env.EVM8183_RPC, env.EVM8183_CONTRACT));
      } else if (rec.platform === "wurk" && env.WURK_API_KEY) {
        subs.push(...await collectWurk(env, rec));
      }
    } catch (e) {
      console.error(`collect ${rec.id}: ${String(e)}`);
    }
    for (const sub of subs) {
      const key = `dispatch-sub:${rec.market_id}:${rec.platform}:${sub.submission_id}`;
      const seen = await env.CLAIMS.get(key).catch(() => null);
      if (seen) continue;
      await env.CLAIMS.put(key, JSON.stringify(sub));
      count++;
    }
    if (subs.length && rec.state === "active") {
      await env.CLAIMS.put(`dispatch:${rec.market_id}:${rec.platform}`,
        JSON.stringify({ ...rec, state: "collecting", updated_at: Date.now() }));
    }
  }
  return { scanned: channels.length, submissions: count };
}

export async function listDispatchSubmissions(env: Env, marketId?: string): Promise<DispatchSubmission[]> {
  const prefix = marketId ? `dispatch-sub:${marketId}:` : "dispatch-sub:";
  const listed = await env.CLAIMS.list({ prefix, limit: 100 }).catch(() => null);
  const rows = await Promise.all((listed?.keys ?? []).map((k) =>
    env.CLAIMS.get<DispatchSubmission>(k.name, "json").catch(() => null)));
  return rows.filter((r): r is DispatchSubmission => !!r)
    .sort((a, b) => a.received_at - b.received_at);
}
