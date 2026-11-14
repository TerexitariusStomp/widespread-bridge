// PR-bot verdict oracle: a review bot's public verdict on a wide:funded PR
// becomes a signed wide-verdict — same envelope the NEAR contract binds.
// The bot (widespread-bot) validates the GitHub event; this endpoint signs,
// settles if a recipient is bound, and stores the verdict for audit.

import { oracleEnv, signVerdict } from "./oracle";
import { forgeFor } from "./forges";
import type { Env, PayoutReceipt } from "./types";

export interface BotVerdictBody {
  repo?: string;
  pr?: number;
  issue?: number;
  bot?: string;
  score?: number | string;
  verdict?: string;
  head_sha?: string;
  amount?: string;
  currency?: string;
  /** Winner's NEAR claimant account — release pays it on-chain. */
  claimant?: string;
}

interface BotVerdictRecord {
  id: string;
  repo: string;
  pr: number;
  issue: number;
  bot: string;
  score: number | string;
  verdict: string;
  head_sha: string;
  oracle_verdict_sig?: string;
  payout: PayoutReceipt | null;
  writeback: { attempted: boolean; skipped_reason?: string; status_url?: string; error?: string } | null;
  reviewed_at: number;
}

const verdictKey = (repo: string, issue: number) => `botverdict:${repo}:${issue}`;

export async function handleBotVerdict(env: Env, body: BotVerdictBody): Promise<Response> {
  const repo = body.repo ?? "";
  const issue = Number(body.issue ?? body.pr ?? 0);
  const verdict = body.verdict ?? "";
  const headSha = body.head_sha ?? "";
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(repo)) return Response.json({ error: "bad repo" }, { status: 400 });
  if (!issue || !headSha || !body.bot) return Response.json({ error: "need issue, head_sha, bot" }, { status: 400 });
  if (verdict !== "accept" && verdict !== "reject") {
    return Response.json({ error: "verdict must be accept|reject" }, { status: 400 });
  }

  // Idempotent: same market + head → return the stored verdict, never re-pay.
  const prior = await env.CLAIMS.get<BotVerdictRecord>(verdictKey(repo, issue), "json").catch(() => null);
  if (prior && prior.head_sha === headSha && prior.verdict === verdict) {
    return Response.json({ status: prior.payout?.tx_hash ? "accepted_paid" : "duplicate", record: prior });
  }

  const score = body.score ?? "";
  const oracle = oracleEnv(env as unknown as Parameters<typeof oracleEnv>[0]);
  let oracleSig = "";
  if (oracle && verdict === "accept") {
    const { sig } = await signVerdict(
      oracle,
      `github:${repo}#${issue}`,
      headSha,
      "accept",
      `${body.bot}:${score}`
    ).catch(() => ({ sig: "", pubkey: "" }));
    oracleSig = sig;
  }

  // Settlement: the signed wide-verdict is the release proof the market
  // contract checks — payout records the claimant + release args; the
  // payer or a relayer broadcasts release() on-chain.
  let payout: PayoutReceipt | null = null;
  if (verdict === "accept") {
    payout = body.claimant
      ? { attempted: true, rail: "near-release", receiver: body.claimant,
          amount: body.amount, currency: body.currency ?? "NEAR",
          note: `release github:${repo}#${issue} → claimant ${body.claimant} (oracle sig bound)` }
      : { attempted: false, skipped_reason: "no claimant NEAR account in verdict body" };
  }

  const { adapter, binding } = forgeFor(env, repo);
  const writeback = verdict === "accept" && binding
    ? await adapter.writeReceipt(env, binding, {
        repo,
        sha: headSha,
        accepted: true,
        description: payout?.receiver
          ? `NEAR release → ${payout.receiver} — ${body.bot} verdict ${score}`
          : `${body.bot} verdict ${score} (adjudicated accept)`,
        claimId: `botverdict:${repo}#${issue}`,
      })
    : { attempted: false, skipped_reason: verdict === "accept" ? "no forge binding" : "verdict reject — no receipt" };

  const record: BotVerdictRecord = {
    id: `botverdict:${repo}:${issue}`,
    repo,
    pr: Number(body.pr ?? issue),
    issue,
    bot: body.bot ?? "",
    score,
    verdict,
    head_sha: headSha,
    oracle_verdict_sig: oracleSig || undefined,
    payout,
    writeback,
    reviewed_at: Date.now(),
  };
  await env.CLAIMS.put(verdictKey(repo, issue), JSON.stringify(record));

  return Response.json({
    status: verdict === "reject" ? "rejected" : payout?.attempted ? "accepted_paid" : "accepted_unpaid",
    record,
  });
}
