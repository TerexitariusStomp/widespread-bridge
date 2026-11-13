// The pipeline: claim → evidence → AI verdict → PayPal payout → receipt.

import { adjudicate, adjudicatePanel } from "./adjudicator";
import { rep8004For } from "./rep8004";
import { crosscheck, findDerivative, gatherCommitEvidence, laterUpstreamFingerprints, upstreamFor } from "./evidence";
import { oracleEnv, signVerdict } from "./oracle";
import { fetchOpLog, verifyChain } from "./oplog";
import { refreshBatch, sendPayout } from "./payouts";
import { attestClaim } from "./ecosystem";
import { getBounty, getRecord, putRecord } from "./store";
import { getDeclared } from "./declare";
import { writebackReceipt } from "./writeback";
import type {
  Bounty,
  Env,
  PayoutReceipt,
  ReviewRecord,
  ShipClaim,
} from "./types";

function receiverFor(claim: ShipClaim, bounty: Bounty | null, actor: string): string | null {
  if (bounty?.recipients?.[actor]) return bounty.recipients[actor];
  if (bounty?.receiver_email) return bounty.receiver_email;
  if (claim.paypal_email) return claim.paypal_email;
  return null;
}

/**
 * Review one op-log entry end to end. Returns the persisted record;
 * throws only on malformed requests (unknown repo / missing seq).
 */
export async function runReview(
  env: Env,
  repo: string,
  seq: number,
  opts: { force?: boolean } = {}
): Promise<ReviewRecord> {
  const id = `${repo}:${seq}`;
  const entries = await fetchOpLog(env.FORGE_BASE, repo);
  const entry = entries.find((e) => e.seq === seq);
  if (!entry) throw new Error(`no op-log entry seq=${seq} in ${repo}`);
  if (entry.kind !== "ship" || entry.payload?.ship !== true) {
    throw new Error(`entry ${seq} is not an accepted ship claim (kind=${entry.kind})`);
  }

  // delta-git op-logs are reset periodically — a wiped repo restarts at
  // genesis and reuses seq numbers. Only a stored record for THIS exact
  // entry (same hash) counts as already-reviewed; a same-seq entry under a
  // different hash is a new claim and earns a fresh review + payout.
  const stored = await getRecord(env, repo, seq);
  if (stored && !opts.force && stored.claim.hash === entry.hash) return stored;
  // Same-claim prior → refresh its batch rather than re-POST (PayPal rejects
  // a second send under the same sender_batch_id). Different-hash prior →
  // a new claim; its payout gets a hash-keyed batch id.
  const prior = stored?.claim.hash === entry.hash ? stored : null;

  const claim = entry.payload as unknown as ShipClaim;
  const [chain, repoBounty] = await Promise.all([verifyChain(entries), getBounty(env, repo)]);
  // Declared markets: per-repo bounty may not exist — resolve by work_id.
  const bounty = repoBounty ?? (claim.work_id ? await getDeclared(env, claim.work_id) : null);

  // Recompute each claimed commit's diff independently of the forge verdict.
  const commits = await Promise.all(
    (claim.commits ?? []).map((sha) =>
      gatherCommitEvidence(env, repo, sha, bounty?.upstream)
    )
  );
  const check = crosscheck(claim, commits);

  // Derivative-use scan: fingerprint the upstream repo's recent commits and
  // check whether a later one landed this claim's exact patch — the
  // "used my code, never merged the PR" proof, recorded on every review.
  const upstream = upstreamFor(repo, env, bounty?.upstream);
  const fp = commits.find((c) => c.patch_fingerprint)?.patch_fingerprint;
  const derivative = upstream && fp
    ? await findDerivative({
        claimFingerprint: fp,
        laterCommits: await laterUpstreamFingerprints(upstream),
      }).catch(() => null)
    : null;

  // Non-recomputable work (no code evidence, or the bounty declares typed
  // proof requirements) goes to the bias-corrected evaluator panel —
  // blind presentation, minority-veto escalation. Code claims stay on the
  // cheaper single recompute judge.
  // Domain seam: non-code markets route through a domain pack first —
  // hard failures (unresolvable artifact, wrong author) reject outright;
  // pass → evidence feeds the judge.
  let domainEvidence: Record<string, unknown> | null = null;
  if (bounty?.domain && bounty.domain !== "code") {
    const { validateDomain } = await import("./domains/index");
    const claimRef = (claim as unknown as Record<string, unknown>).ref as string | undefined
      ?? ((claim as unknown as Record<string, unknown>).evidence as Record<string, unknown> | undefined)?.url as string | undefined
    if (!claimRef) {
      domainEvidence = { failures: ["no artifact ref on claim"], pack: "none" };
    } else {
      const v = await validateDomain(
        { id: repo, spec: bounty.spec, domain: bounty.domain, verification: { class: "platform-url" }, created_at: bounty.created_at },
        { ref: claimRef, actor: (claim as unknown as Record<string, unknown>).actor as string | undefined },
        env as unknown as Record<string, string | undefined>,
      );
      domainEvidence = v as unknown as Record<string, unknown>;
      if (v.failures.length) {
        const record: ReviewRecord = {
          id, repo, seq, status: "rejected",
          claim: entry, chain, commits, crosscheck: check, bounty,
          adjudication: { verdict: "reject", reasoning: `domain ${v.pack}: ${v.failures.join("; ")}`, confidence: 1, model: `domain(${v.pack})` },
          domain_evidence: v as unknown as Record<string, unknown>,
          payout: null, writeback: null, reviewed_at: Date.now(),
        };
        await putRecord(env, record);
        return record;
      }
    }
  }
  const adjudicatorInput = { repo, entry, chain, bounty, commits, check, derivative, domain_evidence: domainEvidence };
  const adjudication = (!claim.commits?.length || bounty?.proof_requirements?.length)
    ? await adjudicatePanel(env, adjudicatorInput)
    : await adjudicate(env, adjudicatorInput);

  // Money moves only on: model says accept + confidence floor + intact chain.
  const minConfidence = Number(env.MIN_CONFIDENCE ?? "0.6");
  const accepted =
    adjudication.verdict === "accept" &&
    adjudication.confidence >= minConfidence &&
    chain.valid;

  // When the market lives on-chain (NEAR_CONTRACT set), the adjudicator's
  // verdict is signed as an oracle proof — release() on the contract binds
  // this sig to the registered oracle instead of trusting a payer click.
  const oracle = oracleEnv(env as unknown as {
    NEAR_CONTRACT?: string; NEAR_RPC_URL?: string;
    ORACLE_ACCOUNT?: string; ORACLE_SECRET_KEY?: string;
    ORACLE_SEED_HEX?: string; ORACLE_PUBKEY_HEX?: string;
  });
  if (oracle && accepted && claim.commits?.length) {
    const { sig } = await signVerdict(
      oracle,
      claim.work_id ?? String(seq),
      entry.hash ?? "",
      "accept",
      String(bounty?.work_id ?? ""),
    ).catch(() => ({ sig: "", pubkey: "" }));
    if (sig) adjudication.oracle_verdict_sig = sig;
  }

  // Sigstore/Rekor: pin the claimed commit into the public transparency log.
  // Env-gated — skipped with a reason when no ATTEST_* key is provisioned.
  const attestation = claim.commits?.[0]
    ? await attestClaim(env, { repo, sha: claim.commits[0], note: `ship-claim seq=${seq}` })
        .catch(() => null)
    : null;

  let payout: PayoutReceipt | null = null;
  if (accepted) {
    const receiver = receiverFor(claim, bounty, entry.actor);
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
      payout = { attempted: false, skipped_reason: "PAYPAL_CLIENT_ID/SECRET not set", sandbox: true };
    } else if (!receiver) {
      payout = {
        attempted: false,
        skipped_reason: "no recipient — seed a bounty for this repo or set claim.paypal_email",
        sandbox: true,
      };
    } else if (prior?.payout?.batch_id) {
      payout = await refreshBatch(env, prior.payout);
    } else {
      payout = await sendPayout(env, {
        repo,
        seq,
        claimHash: entry.hash,
        receiver,
        amount: bounty?.amount ?? "1.00",
        currency: bounty?.currency ?? "USD",
        note: `Slop.cash bounty for ${repo} ship claim #${seq}`,
      });
    }
  }

  // Receipt back to the forge as a signed commit status (bidirectional audit).
  const firstSha = claim.commits?.[0];
  const writeback = firstSha
    ? await writebackReceipt(env, {
        repo,
        sha: firstSha,
        accepted,
        description: payout?.batch_id
          ? `PayPal Payouts batch ${payout.batch_id} (${payout.transaction_status ?? payout.batch_status ?? "sent"})`
          : `adjudicated ${adjudication.verdict} (confidence ${adjudication.confidence})`,
        claimId: id,
      })
    : { attempted: false, skipped_reason: "no commits in claim" };

  const record: ReviewRecord = {
    id,
    repo,
    seq,
    status: adjudication.error
      ? "error"
      : !accepted
        ? "rejected"
        : payout?.batch_id
          ? "accepted_paid"
          : "accepted_unpaid",
    claim: entry,
    chain,
    commits,
    crosscheck: check,
    bounty,
    adjudication,
    derivative,
    attestation,
    payout,
    writeback,
    reviewed_at: Date.now(),
  };
  // ERC-8004-shaped reputation record — settled verdicts become portable
  // trust signals in the emerging standard's schema.
  const origin = (record.claim?.payload as Record<string, unknown> | undefined)?.origin_platform;
  record.reputation_8004 = rep8004For(record, typeof origin === "string" ? origin : undefined);
  await putRecord(env, record);
  return record;
}

/** Review every unprocessed ship claim in a repo (cron + bulk /review). */
export async function reviewOutstanding(
  env: Env,
  repo: string,
  limit = 5
): Promise<ReviewRecord[]> {
  const entries = await fetchOpLog(env.FORGE_BASE, repo);
  const shipEntries = entries.filter((e) => e.kind === "ship" && e.payload?.ship === true);
  const out: ReviewRecord[] = [];
  for (const entry of shipEntries.slice(-limit)) {
    const stored = await getRecord(env, repo, entry.seq);
    if (stored && stored.claim.hash === entry.hash) continue;
    out.push(await runReview(env, repo, entry.seq));
  }
  return out;
}
