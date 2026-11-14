// KV persistence: review records keyed by claim id, a recency index, and
// the bounty registry keyed by repo.

import type { Bounty, Env, ReviewRecord } from "./types";

const INDEX_KEY = "index";
const INDEX_CAP = 500;

export const recordKey = (repo: string, seq: number) => `claim:${repo}:${seq}`;
export const bountyKey = (repo: string) => `bounty:${repo}`;

export async function getRecord(env: Env, repo: string, seq: number): Promise<ReviewRecord | null> {
  return env.CLAIMS.get<ReviewRecord>(recordKey(repo, seq), "json");
}

export async function putRecord(env: Env, record: ReviewRecord): Promise<void> {
  await env.CLAIMS.put(recordKey(record.repo, record.seq), JSON.stringify(record));
  // D5: signed hash-chained audit — the record is already redacted for
  // confidential markets, so the commitment is always public-safe.
  const { emitEvent } = await import("./events");
  await emitEvent(env, "review", record.id, record);
  const ids = (await env.CLAIMS.get<string[]>(INDEX_KEY, "json")) ?? [];
  if (!ids.includes(record.id)) {
    ids.push(record.id);
    await env.CLAIMS.put(INDEX_KEY, JSON.stringify(ids.slice(-INDEX_CAP)));
  }
}

export async function listRecords(env: Env): Promise<ReviewRecord[]> {
  const ids = (await env.CLAIMS.get<string[]>(INDEX_KEY, "json")) ?? [];
  const records = await Promise.all(
    ids.map((id) => env.CLAIMS.get<ReviewRecord>(`claim:${id}`, "json").catch(() => null))
  );
  return records.filter((r): r is ReviewRecord => r !== null);
}

/** Last `limit` reviewed claims only — for surfaces (home page) that need
 * recent receipts without paying for a full index scan. */
export async function listRecentRecords(env: Env, limit = 12): Promise<ReviewRecord[]> {
  const ids = (await env.CLAIMS.get<string[]>(INDEX_KEY, "json")) ?? [];
  const records = await Promise.all(
    ids.slice(-limit).map((id) => env.CLAIMS.get<ReviewRecord>(`claim:${id}`, "json").catch(() => null))
  );
  return records.filter((r): r is ReviewRecord => r !== null);
}

export async function getBounty(env: Env, repo: string): Promise<Bounty | null> {
  return env.CLAIMS.get<Bounty>(bountyKey(repo), "json");
}

export async function putBounty(env: Env, bounty: Bounty): Promise<void> {
  await env.CLAIMS.put(bountyKey(bounty.repo), JSON.stringify(bounty));
  const ids = (await env.CLAIMS.get<string[]>("bounty-index", "json")) ?? [];
  if (!ids.includes(bounty.repo)) {
    ids.push(bounty.repo);
    await env.CLAIMS.put("bounty-index", JSON.stringify(ids));
  }
}

export async function deleteBounty(env: Env, repo: string): Promise<void> {
  await env.CLAIMS.delete(bountyKey(repo));
  const ids = ((await env.CLAIMS.get<string[]>("bounty-index", "json")) ?? []).filter(
    (r) => r !== repo
  );
  await env.CLAIMS.put("bounty-index", JSON.stringify(ids));
}

export async function listBounties(env: Env): Promise<Bounty[]> {
  const repos = (await env.CLAIMS.get<string[]>("bounty-index", "json")) ?? [];
  const bounties = await Promise.all(repos.map((r) => getBounty(env, r)));
  return bounties.filter((b): b is Bounty => b !== null);
}
