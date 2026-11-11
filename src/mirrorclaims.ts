// mirrorclaims.ts — claim + settlement lifecycle for FIAT-funded mirrors.
//
// The fiat path has no NEAR escrow: the funder's USD sits in our PayPal
// (captured via /api/mirrors/capture), and settlement pays the winner in
// PYUSD on Solana (or USD via PayPal Payouts as fallback). Claims reuse the
// same forge-artifact validation as NEAR market claims — real submissions
// only, forge-native identity, unlimited competition, attestation tokens.
//
// Endpoints:
//   POST /api/mirrors/claims   {mirror_id, forgeRef, ...} → validated claim
//   GET  /api/mirrors/claims?mirror_id=…                  → list claims
//   POST /api/mirrors/verdict  {mirror_id, claim_hash, accept, reasoning?}
//                              → winner + net payout quote (PYUSD/USD)
//   POST /api/mirrors/payout   {mirror_id}                → execute payout

import type { Env, MirrorListing } from "./types";
import { validateForgeSubmission, attestationForMirror } from "./claims";
import { feedDoc } from "./feed";
import { sendPayout } from "./payouts";
import { paxosPyusdWithdraw } from "./paxos";

const claimKey = (mirrorId: string, hash: string) => `mclaim:${mirrorId}:${hash}`;
const claimsPrefix = (mirrorId: string) => `mclaim:${mirrorId}:`;
const settleKey = (mirrorId: string) => `msettle:${mirrorId}`;

async function getMirror(env: Env, ctx: ExecutionContext | undefined, mirrorId: string): Promise<MirrorListing | null> {
  const doc = await feedDoc(env, ctx);
  return doc.mirrors?.find((m) => m.id === mirrorId) ?? null;
}

async function listClaims(env: Env, mirrorId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CLAIMS.list({ prefix: claimsPrefix(mirrorId), cursor, limit: 100 });
    for (const k of page.keys) {
      const v = await env.CLAIMS.get(k.name);
      if (v) out.push(JSON.parse(v) as Record<string, unknown>);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function handleMirrorClaimPost(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ ok: false, error: "json body required" }, { status: 400 });
  const mirrorId = String(body.mirror_id ?? "");
  const forgeRef = String(body.forgeRef ?? "");
  if (!mirrorId || !forgeRef) {
    return Response.json({ ok: false, error: "mirror_id and forgeRef required" }, { status: 400 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });

  // Fiat mirrors must be funded before claims count — no escrow, no work.
  const funding = await env.CLAIMS.get(`fiatfund:${mirrorId}`).then((v) => v ? JSON.parse(v) : null);
  if (funding?.status !== "captured") {
    return Response.json({
      ok: false,
      error: `mirror not fiat-funded (status: ${funding?.status ?? "unfunded"}) — payer must complete /api/mirrors/fund + capture first`,
    }, { status: 409 });
  }

  const fv = await validateForgeSubmission(env, {
    forgeRef,
    forgeUserId: body.forgeUserId as string | undefined,
    commits: body.commits as string[] | undefined,
    evidence: body.evidence as Record<string, unknown> | undefined,
  });
  if (fv.failures.length) {
    return Response.json({ ok: false, attested: false, failures: fv.failures }, { status: 422 });
  }

  const evidence: Record<string, unknown> = { ...fv.evidence, claim_api: "mirror-v1", mirror_id: mirrorId };
  const claimHash = String(evidence.patch_fingerprint ??
    `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(evidence))))]
      .map((b) => b.toString(16).padStart(2, "0")).join("")}`);

  const token = await attestationForMirror(env, {
    mirror_id: mirrorId, forgeRef, forgeUserId: evidence.forgeUserId,
    patch_fingerprint: evidence.patch_fingerprint, claim_hash: claimHash,
  });
  if (token) evidence.attestation = token;

  const claim = {
    mirror_id: mirrorId,
    claim_hash: claimHash,
    forgeRef,
    forgeUserId: String(evidence.forgeUserId ?? ""),
    forgeLogin: evidence.forgeLogin ?? null,
    actor: body.actor ?? evidence.forgeLogin ?? "agent",
    commits: body.commits ?? [],
    evidence,
    payout: body.payout ?? null,   // {pyusd_solana_address} | {paypal_email}
    attested: !!token,
    created_at: Date.now(),
    status: "pending",
  };
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({
    ok: true, attested: !!token, claim,
    verification: { endpoint: "/api/claims/verify", token },
    next: "Claim recorded. Verdict via POST /api/mirrors/verdict selects the winner; payout in PYUSD (Solana) or USD (PayPal).",
  }, { status: 201 });
}

export async function handleMirrorClaimsList(url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const mirrorId = url.searchParams.get("mirror_id") ?? "";
  if (!mirrorId) return Response.json({ ok: false, error: "mirror_id required" }, { status: 400 });
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });
  return Response.json({ ok: true, mirror_id: mirrorId, claims: await listClaims(env, mirrorId) });
}

export async function handleMirrorVerdict(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ ok: false, error: "json body required" }, { status: 400 });
  const mirrorId = String(body.mirror_id ?? "");
  const claimHash = String(body.claim_hash ?? "");
  const accept = body.accept !== false;
  if (!mirrorId || !claimHash) {
    return Response.json({ ok: false, error: "mirror_id and claim_hash required" }, { status: 400 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  if (!mirror) return Response.json({ ok: false, error: "mirror not found" }, { status: 404 });

  // Verdict is one-shot: any recorded settlement (won or rejected) is
  // final. The old check looked for status==="settled" which is never
  // written — a second verdict could overwrite the winner and re-open
  // the payout path for a double-spend.
  const prior = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (prior) {
    return Response.json({ ok: true, status: "already_decided", settlement: prior });
  }

  const claim = await env.CLAIMS.get(claimKey(mirrorId, claimHash)).then((v) => v ? JSON.parse(v) : null);
  if (!claim) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
  if (!claim.attested) {
    return Response.json({ ok: false, error: "claim is unattested — ineligible for verdict" }, { status: 409 });
  }

  const usd = mirror.original?.est_usd ?? 0;
  const cutBps = mirror.cut_bps ?? 1000;
  const netUsd = +(usd * (1 - cutBps / 10000)).toFixed(2);
  // Auto-ingested claims carry payout:null — the verdict caller (payer or
  // ops) supplies the winner's payout address here.
  const payoutIn = (body.payout ?? claim.payout ?? {}) as {
    pyusd_solana_address?: string; paypal_email?: string;
    beneficiary?: Record<string, unknown>;
  };
  const settlement = {
    mirror_id: mirrorId,
    winning_claim_hash: claimHash,
    winner: { forgeUserId: claim.forgeUserId, forgeLogin: claim.forgeLogin, actor: claim.actor },
    face_usd: usd,
    platform_cut_usd: +(usd * cutBps / 10000).toFixed(2),
    net_usd: netUsd,
    // PYUSD is $1-pegged, 6 decimals on Solana (Token-2022).
    pyusd: payoutIn.pyusd_solana_address
      ? { asset: "PYUSD", network: "solana", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
          amount: netUsd.toFixed(6), decimals: 6, to: payoutIn.pyusd_solana_address }
      : null,
    paypal_usd: payoutIn.paypal_email
      ? { asset: "USD", rail: "paypal-payouts", amount: netUsd.toFixed(2), to: payoutIn.paypal_email }
      : null,
    verdict: accept ? "accept" : "reject",
    reasoning: String(body?.reasoning ?? ""),
    payout_input: payoutIn,
    decided_at: Date.now(),
    status: accept ? "won" : "rejected",
  };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
  claim.status = accept ? "won" : "rejected";
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));

  return Response.json({ ok: true, settlement,
    next: accept ? "POST /api/mirrors/payout {mirror_id} to send PYUSD/USD to the winner." : null });
}

/** Payer asks for revisions instead of a verdict — TermiX's
 * CHANGES_REQUESTED, capped at 2 rounds. Costs the claimant nothing;
 * the claim goes back to pending on resubmission. */
export async function handleMirrorRequestChanges(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  const claimHash = String(body?.claim_hash ?? "");
  const note = String(body?.note ?? "");
  if (!mirrorId || !claimHash) {
    return Response.json({ ok: false, error: "mirror_id and claim_hash required" }, { status: 400 });
  }
  const raw = await env.CLAIMS.get(claimKey(mirrorId, claimHash));
  const claim = raw ? JSON.parse(raw) : null;
  if (!claim) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
  if (claim.status !== "pending" && claim.status !== "changes_requested") {
    return Response.json({ ok: false, error: `claim is ${claim.status} — changes only on open claims` }, { status: 409 });
  }
  const rounds = Number(claim.change_rounds ?? 0) + 1;
  if (rounds > 2) {
    return Response.json({ ok: false, error: "revision limit reached (2 rounds) — issue a verdict instead" }, { status: 409 });
  }
  claim.status = "changes_requested";
  claim.change_rounds = rounds;
  claim.change_notes = [...(claim.change_notes ?? []), { note, at: Date.now() }];
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));
  return Response.json({ ok: true, claim_hash: claimHash, status: "changes_requested", round: rounds,
    next: "Resubmit via POST /api/mirrors/claims — the new claim supersedes this round." });
}

/** Provider-favorable timeout — TermiX's claim-after-timeout. If a
 * submitted claim sits past CLAIM_TIMEOUT_MS (default 7d) with no
 * verdict, the provider can settle in their own favor. Protects workers
 * from dead payers at zero cost to the claimant. */
export async function handleMirrorClaimTimeout(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  const claimHash = String(body?.claim_hash ?? "");
  if (!mirrorId || !claimHash) {
    return Response.json({ ok: false, error: "mirror_id and claim_hash required" }, { status: 400 });
  }
  const prior = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (prior) return Response.json({ ok: true, status: "already_decided", settlement: prior });
  const raw = await env.CLAIMS.get(claimKey(mirrorId, claimHash));
  const claim = raw ? JSON.parse(raw) : null;
  if (!claim) return Response.json({ ok: false, error: "claim not found" }, { status: 404 });
  const timeoutMs = Number(env.CLAIM_TIMEOUT_MS ?? 7 * 24 * 60 * 60 * 1000);
  const age = Date.now() - Number(claim.created_at ?? 0);
  if (claim.status !== "pending" && claim.status !== "changes_requested") {
    return Response.json({ ok: false, error: `claim is ${claim.status} — not open` }, { status: 409 });
  }
  if (age < timeoutMs) {
    return Response.json({ ok: false, error: `verdict window still open (${Math.round((timeoutMs - age) / 3600000)}h left)` }, { status: 409 });
  }
  const mirror = await getMirror(env, ctx, mirrorId);
  const usd = mirror?.original?.est_usd ?? 0;
  const cutBps = mirror?.cut_bps ?? 1000;
  const settlement = {
    mirror_id: mirrorId, winning_claim_hash: claimHash,
    winner: { forgeUserId: claim.forgeUserId, forgeLogin: claim.forgeLogin, actor: claim.actor },
    face_usd: usd, platform_cut_usd: +(usd * cutBps / 10000).toFixed(2),
    net_usd: +(usd * (1 - cutBps / 10000)).toFixed(2),
    verdict: "accept", reasoning: "claim-after-timeout — verdict window elapsed without decision",
    decided_at: Date.now(), status: "won", timeout: true,
  };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
  claim.status = "won";
  await env.CLAIMS.put(claimKey(mirrorId, claimHash), JSON.stringify(claim));
  return Response.json({ ok: true, settlement, next: "POST /api/mirrors/payout {mirror_id} to send PYUSD/USD to the winner." });
}

export async function handleMirrorPayout(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mirrorId = String(body?.mirror_id ?? "");
  if (!mirrorId) return Response.json({ ok: false, error: "mirror_id required" }, { status: 400 });
  const settlement = await env.CLAIMS.get(settleKey(mirrorId)).then((v) => v ? JSON.parse(v) : null);
  if (!settlement || settlement.status !== "won") {
    return Response.json({ ok: false, error: "no winning settlement for this mirror" }, { status: 409 });
  }
  // Terminal markers differ per rail: PayPal batch_id, Paxos transfer_id.
  if (settlement.payout?.batch_id || settlement.payout?.transfer_id) {
    return Response.json({ ok: true, status: "already_paid", settlement });
  }
  // In-flight guard: mark "sending" before touching the rail so a
  // concurrent retry can't double-pay during the KV propagation window.
  if (settlement.payout?.status === "sending"
      && Date.now() - Number(settlement.payout.attempted_at ?? 0) < 10 * 60 * 1000) {
    return Response.json({ ok: true, status: "payout_in_progress", settlement });
  }
  settlement.payout = { status: "sending", attempted_at: Date.now() };
  await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));

  try {
    // Payout rail priority: PYUSD on Solana via Paxos (licensed transmitter
    // of record — sanctions screening + Travel Rule enforced by them) when
    // the winner gave a Solana address; USD via PayPal Payouts otherwise.
    const paxosReady = !!(env.PAXOS_CLIENT_ID && env.PAXOS_CLIENT_SECRET && env.PAXOS_PROFILE_ID);
    if (settlement.pyusd) {
      const payoutSpec = ((settlement.payout_input ?? {}) as {
        beneficiary?: { first_name?: string; last_name?: string; physical_address?: { country?: string } };
      });
      if (paxosReady) {
        const refId = `wide-mirror-${mirrorId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
        const result = await paxosPyusdWithdraw(env, {
          refId,
          amount: settlement.pyusd.amount,
          destinationAddress: settlement.pyusd.to,
          beneficiary: payoutSpec.beneficiary,
        });
        settlement.payout = result.ok
          ? { rail: "pyusd-solana", provider: "paxos", status: result.status,
              transfer_id: result.transfer_id, ref_id: refId,
              ...(result.error ? { note: result.error } : {}) }
          : { rail: "pyusd-solana", provider: "paxos", status: "failed",
              error: result.error, travel_rule_required: !!result.travel_rule_required,
              ...(result.travel_rule_required
                ? { next: "Resubmit claim payout with beneficiary {first_name,last_name,physical_address.country} or save Travel Rule metadata on the Paxos destination address." }
                : {}) };
      } else {
        // No Paxos creds — queue the exact send for ops (PayPal app / Paxos
        // dashboard) rather than lose the settlement.
        settlement.payout = {
          rail: "pyusd-solana", status: "pending_ops",
          note: `Send ${settlement.pyusd.amount} PYUSD on Solana to ${settlement.pyusd.to} ` +
                `(mint ${settlement.pyusd.mint}).`,
        };
      }
      await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
      return Response.json({ ok: settlement.payout.status !== "failed", settlement });
    }

    // USD fallback: PayPal Payouts to the winner's PayPal email — live today,
    // PayPal is the licensed transmitter on this rail.
    if (settlement.paypal_usd) {
      const receipt = await sendPayout(env, {
        repo: mirrorId, seq: 0, claimHash: settlement.winning_claim_hash,
        receiver: settlement.paypal_usd.to, amount: settlement.paypal_usd.amount,
        currency: "USD", note: `Widespread mirror bounty ${mirrorId} — verified winning claim`,
      });
      settlement.payout = { rail: "paypal-payouts", ...receipt };
      await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
      return Response.json({ ok: true, settlement });
    }

    return Response.json({ ok: false, error: "winner provided no payout address (pyusd_solana_address or paypal_email)" }, { status: 409 });
  } catch (e) {
    // A thrown rail call must not leave the settlement stuck in "sending".
    settlement.payout = { status: "failed",
      error: e instanceof Error ? e.message : String(e) };
    await env.CLAIMS.put(settleKey(mirrorId), JSON.stringify(settlement));
    return Response.json({ ok: false, error: settlement.payout.error, settlement }, { status: 500 });
  }
}
