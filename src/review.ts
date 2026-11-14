// The pipeline: claim → evidence → AI verdict → NEAR release → receipt.

import { adjudicate, adjudicatePanel } from "./adjudicator";
import { rep8004For } from "./rep8004";
import { crosscheck, findDerivative, gatherCommitEvidence, laterUpstreamFingerprints, upstreamFor } from "./evidence";
import { oracleEnv, signVerdict } from "./oracle";
import { forgeFor } from "./forges";
import { attestClaim } from "./ecosystem";
import { getBounty, getRecord, putRecord } from "./store";
import { getDeclared } from "./declare";
import type {
  Bounty,
  Env,
  PayoutReceipt,
  ReviewRecord,
  ShipClaim,
} from "./types";

/** Stored-record copy of a bounty — confidential markets keep the real
 *  spec in private KV only; the public record carries a redacted stub. */
function redactBounty(bounty: Bounty | null): Bounty | null {
  if (!bounty?.confidential) return bounty;
  return { ...bounty, spec: `[confidential:${bounty.domain ?? "other"}]` };
}

/** Domain packs echo artifact text into evidence — strip every plaintext
 *  field before the evidence can reach a stored record (confidential). */
function stripDomainText(v: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!v) return v;
  const { text: _t, draft: _d, artifact_inline: _i, ...clean } = v;
  return clean;
}

function claimantFor(claim: ShipClaim, bounty: Bounty | null, actor: string): string | null {
  // Worker's own signed instruction wins — then a funder-named recipient
  // for this actor, then the bounty default.
  if (claim.claimant) return claim.claimant;
  if (bounty?.recipients?.[actor]) return bounty.recipients[actor];
  if (bounty?.receiver_account) return bounty.receiver_account;
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
  const { adapter, binding } = forgeFor(env, repo);
  const entries = binding ? await adapter.fetchClaims(binding, repo) : [];
  const entry = entries.find((e) => e.seq === seq);
  if (!entry) throw new Error(`no claim entry seq=${seq} in ${repo}`);
  if (!adapter.isClaim(entry)) {
    throw new Error(`entry ${seq} is not an accepted work claim (kind=${entry.kind})`);
  }

  // delta-git op-logs are reset periodically — a wiped repo restarts at
  // genesis and reuses seq numbers. Only a stored record for THIS exact
  // entry (same hash) counts as already-reviewed; a same-seq entry under a
  // different hash is a new claim and earns a fresh review + payout.
  const stored = await getRecord(env, repo, seq);
  if (stored && !opts.force && stored.claim.hash === entry.hash) return stored;
  // Same-claim prior → reuse its settlement record rather than re-queue
  // (idempotent release). Different-hash prior → a new claim; its payout
  // record is keyed to the new entry hash.
  const prior = stored?.claim.hash === entry.hash ? stored : null;

  const claim = adapter.toClaim(entry);
  const [chain, repoBounty] = await Promise.all([adapter.verifyChain(entries), getBounty(env, repo)]);
  // Declared markets: per-repo bounty may not exist — resolve by work_id.
  const bounty = repoBounty ?? (claim.work_id ? await getDeclared(env, claim.work_id) : null);

  // Confidential markets: the deliverable must arrive as crypto_box_seal
  // ciphertext (sealed:// ref + evidence.artifact_sealed). Plaintext lanes
  // (evidence.text / artifact_inline) are forbidden. The bridge opens its
  // adjudication copy inside this request only — plaintext reaches the
  // judge via adjudicatorInput.sealed_text and is NEVER stored.
  const claimEvidence0 = ((claim as unknown as Record<string, unknown>).evidence ?? {}) as Record<string, unknown>;
  let sealedPlaintext: string | null = null;
  if (bounty?.confidential) {
    const earlyRef = (claim as unknown as Record<string, unknown>).ref as string | undefined
      ?? claimEvidence0.url as string | undefined;
    const sealM = String(earlyRef ?? "").match(/^sealed:\/\/([0-9a-f]{64})/i);
    const { parseSealedArtifact, decryptSealedForBridge } = await import("./sealed");
    const { sealed, failures } = parseSealedArtifact(claimEvidence0, sealM?.[1]);
    if (claimEvidence0.text ?? claimEvidence0.draft ?? claimEvidence0.artifact_inline) {
      failures.push("confidential markets forbid inline plaintext — seal the deliverable");
    }
    if (!earlyRef || !sealM) {
      failures.push("confidential claims need a sealed://<sha256> artifact ref");
    }
    if (!failures.length && sealed) {
      const dec = await decryptSealedForBridge(env, sealed);
      if (dec.error) failures.push(dec.error);
      else sealedPlaintext = new TextDecoder().decode(dec.plaintext);
    }
    if (failures.length) {
      const record: ReviewRecord = {
        id, repo, seq, status: "rejected",
        claim: entry, chain, commits: [], crosscheck: crosscheck(claim, []),
        bounty: redactBounty(bounty),
        adjudication: { verdict: "reject", reasoning: `confidential: ${failures.join("; ")}`, confidence: 1, model: "domain(sealed-shape)" },
        payout: null, writeback: null, reviewed_at: Date.now(),
      };
      await putRecord(env, record);
      return record;
    }
  }

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
    const claimEvidence = claimEvidence0;
    // Sealed plaintext plays the draftText role — the judge reads it,
    // the record doesn't.
    const draftText = (sealedPlaintext ?? claimEvidence.text ?? claimEvidence.draft) as string | undefined;
    const claimRef = (claim as unknown as Record<string, unknown>).ref as string | undefined
      ?? claimEvidence.url as string | undefined;
    // draft-class deliverables ride evidence.text — no URL needed
    const domain = draftText && bounty.deliverable_class !== "publish" ? "text-draft" : bounty.domain;
    let packFailures: string[] = [];
    if (!claimRef && !draftText) {
      domainEvidence = { failures: ["no artifact ref or draft text on claim"], pack: "none" };
      packFailures = ["no artifact ref or draft text on claim"];
    } else {
      const v = await validateDomain(
        { id: repo, spec: bounty.spec, domain, verification: { class: "platform-url", params: undefined }, created_at: bounty.created_at },
        { ref: sealedPlaintext ? "draft:sealed" : (claimRef ?? "draft:inline"), actor: (claim as unknown as Record<string, unknown>).actor as string | undefined, evidence: { text: draftText } },
        env as unknown as Record<string, string | undefined>,
      );
      domainEvidence = v as unknown as Record<string, unknown>;
      packFailures = v.failures;
      if (v.failures.length) {
        const record: ReviewRecord = {
          id, repo, seq, status: "rejected",
          claim: entry, chain, commits, crosscheck: check, bounty: redactBounty(bounty),
          adjudication: { verdict: "reject", reasoning: `domain ${v.pack}: ${v.failures.join("; ")}`, confidence: 1, model: `domain(${v.pack})` },
          domain_evidence: bounty?.confidential ? stripDomainText(v as unknown as Record<string, unknown>) : v as unknown as Record<string, unknown>,
          payout: null, writeback: null, reviewed_at: Date.now(),
        };
        await putRecord(env, record);
        return record;
      }
    }
    // Cross-surface target checks (bound profile the work is FOR):
    //   publish class → artifact MUST be authored by the target handle
    //     (anti-impersonation: you can't publish "for my profile" on an
    //      account you don't control — hard reject)
    //   any class    → style/theme similarity vs the target's public
    //     history — a SOFT scoring signal for the judge, never a gate.
    if (bounty.target && !packFailures.length) {
      const author = String((domainEvidence?.author ?? domainEvidence?.channel ?? "") as string).replace(/^@/, "");
      if (bounty.deliverable_class === "publish" && author
          && author.toLowerCase() !== bounty.target.handle.toLowerCase()) {
        const record: ReviewRecord = {
          id, repo, seq, status: "rejected",
          claim: entry, chain, commits, crosscheck: check, bounty: redactBounty(bounty),
          adjudication: { verdict: "reject", reasoning: `bind-identity: publish-class artifact authored by @${author}, not target @${bounty.target.handle}`, confidence: 1, model: "domain(bind-target)" },
          domain_evidence: bounty?.confidential ? stripDomainText(domainEvidence) : domainEvidence,
          payout: null, writeback: null, reviewed_at: Date.now(),
        };
        await putRecord(env, record);
        return record;
      }
      const { fetchTimeline, styleScore } = await import("./domains/history");
      const tl = await fetchTimeline(env, bounty.target.platform, bounty.target.handle, 25).catch(() => null);
      if (tl) {
        const artifactText = draftText ?? String((domainEvidence as Record<string, unknown>).text ?? "");
        domainEvidence = { ...(domainEvidence ?? {}), style: styleScore(artifactText, tl.samples, tl.gated), target: bounty.target };
      }
    }
  }
  // Record hygiene for confidential markets: domain packs may echo the
  // artifact text into their evidence — strip every plaintext field.
  if (bounty?.confidential) domainEvidence = stripDomainText(domainEvidence);
  const adjudicatorInput = {
    repo, entry, chain, bounty, commits, check, derivative,
    domain_evidence: domainEvidence,
    ...(sealedPlaintext ? { sealed_text: sealedPlaintext } : {}),
  };
  // Confidential claims have no recomputable evidence — always panel.
  const adjudication = (bounty?.confidential || !claim.commits?.length || bounty?.proof_requirements?.length)
    ? await adjudicatePanel(env, adjudicatorInput)
    : await adjudicate(env, adjudicatorInput);

  // Money moves only on: model says accept + confidence floor + intact chain.
  // Confidential markets get a stricter floor — a hidden spec means weaker
  // community screening, so the protocol compensates on adjudication.
  const minConfidence = Math.min(0.95,
    Number(env.MIN_CONFIDENCE ?? "0.6") + (bounty?.confidential ? 0.1 : 0));
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

  // Settlement is on-chain: the market contract releases locked funds to
  // the winner's claimant account. For label-only bounties (no escrow
  // yet) the payout record carries the claimant + exact release args so
  // ops can execute or the payer can release directly.
  let payout: PayoutReceipt | null = null;
  if (accepted) {
    const claimant = claimantFor(claim, bounty, entry.actor);
    payout = claimant
      ? { attempted: true, rail: "near-release", receiver: claimant,
          amount: bounty?.amount, currency: bounty?.currency ?? "NEAR",
          note: `release locked market funds to claimant ${claimant} — marketId from work_id ${claim.work_id ?? repo}` }
      : { attempted: false, skipped_reason: "no claimant — the winner needs a NEAR account (claim.claimant or a bound near: handle)" };
  }

  // Receipt back to the forge when it has a receipt surface (the bridge
  // feed is the receipt otherwise).
  const firstSha = claim.commits?.[0];
  const writeback = firstSha && binding
    ? await adapter.writeReceipt(env, binding, {
        repo,
        sha: firstSha,
        accepted,
        description: payout?.receiver
          ? `NEAR release → claimant ${payout.receiver} (${payout.tx_hash ?? "queued"})`
          : `adjudicated ${adjudication.verdict} (confidence ${adjudication.confidence})`,
        claimId: id,
      })
    : { attempted: false, skipped_reason: firstSha ? "no forge binding" : "no commits in claim" };

  const record: ReviewRecord = {
    id,
    repo,
    seq,
    status: adjudication.error
      ? "error"
      : !accepted
        ? "rejected"
        : payout?.tx_hash
          ? "accepted_paid"
          : "accepted_unpaid",
    claim: entry,
    chain,
    commits,
    crosscheck: check,
    bounty: redactBounty(bounty),
    adjudication,
    derivative,
    attestation,
    payout,
    writeback,
    forge_base: binding?.base ?? null,
    reviewed_at: Date.now(),
  };
  // C5 receipt lint — defense in depth: a confidential record must never
  // serialize the spec text or the decrypted deliverable. If any future
  // code path leaks them, the record is stored as an error, not a leak.
  if (bounty?.confidential) {
    const blob = JSON.stringify(record);
    const leaked =
      (bounty.spec.length > 8 && blob.includes(bounty.spec)) ||
      (sealedPlaintext && sealedPlaintext.length > 8 && blob.includes(sealedPlaintext));
    if (leaked) {
      record.status = "error";
      record.adjudication = { verdict: "reject", reasoning: "confidential lint: record attempted to store spec or deliverable plaintext — sanitized", confidence: 1, model: "lint(confidential)" };
      record.domain_evidence = null;
      record.payout = null;
    }
  }
  // ERC-8004-shaped reputation record — settled verdicts become portable
  // trust signals in the emerging standard's schema.
  const origin = (record.claim?.payload as Record<string, unknown> | undefined)?.origin_platform;
  record.reputation_8004 = rep8004For(record, typeof origin === "string" ? origin : undefined);
  await putRecord(env, record);
  // MORE two-stage escrow: accepted + capacity-tagged → schedule the
  // outcome bonus for watcher re-verification post-horizon.
  if (accepted && record.status !== "error") {
    const { scheduleOutcome } = await import("./outcome");
    await scheduleOutcome(env, record).catch(() => null);
  }
  return record;
}

/** Review every unprocessed ship claim in a repo (cron + bulk /review). */
export async function reviewOutstanding(
  env: Env,
  repo: string,
  limit = 5
): Promise<ReviewRecord[]> {
  const { adapter, binding } = forgeFor(env, repo);
  const entries = binding ? await adapter.fetchClaims(binding, repo) : [];
  const shipEntries = entries.filter((e) => adapter.isClaim(e));
  const out: ReviewRecord[] = [];
  for (const entry of shipEntries.slice(-limit)) {
    const stored = await getRecord(env, repo, entry.seq);
    if (stored && stored.claim.hash === entry.hash) continue;
    out.push(await runReview(env, repo, entry.seq));
  }
  return out;
}
