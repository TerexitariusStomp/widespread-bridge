// claims.ts — POST /api/claims: validate a REAL forge submission, then hand
// back attested shipClaim args the agent broadcasts on-chain themselves.
//
// The bridge can't sign NEAR txs (no relayer key on the Worker), so the
// flow is: validate here → return an HMAC attestation token + ready
// shipClaim args → agent calls shipClaim from their own NEAR account.
// `attested:true` on-chain is therefore an *assertion*; the authoritative
// check is GET /api/claims/verify?token=… which adjudicators/oracles call
// during stage-1 recompute. Contract stores the token in evidence so the
// verdict can re-verify later even if this endpoint is down.
//
// Validation (all must pass for attested:true):
//   1. market exists on-chain and is OPEN; specHash (if given) matches.
//   2. forgeRef resolves on the forge (GitHub PR/issue today).
//   3. artifact author == claimed forgeUserId (numeric GitHub ID — the
//      anti-sybil key; NEAR account is payout-only).
//   4. submission carries real work: non-empty diff/patch fingerprint or
//      caller-supplied commits that resolve.
//   5. spec binding: evidence.specHash or market specHash match.

import { nearView } from "./near";
import type { Env } from "./types";
import {
  parseArtifactRef, validateCidArtifact, validateReceipt, validateSealedArtifact,
  loadJobRecord, verifyJobRecordSig, type ArtifactRef,
} from "./artifacts";

const GH_API = "https://api.github.com";
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export interface ClaimBody {
  marketId?: string;
  /** Artifact locator — github PR/issue URL, btfs://cid, ipfs://cid,
   *  rcpt://<receiptId> (+ evidence.receipt), or a coordinator job ref. */
  forgeRef?: string;
  claimant?: string;          // NEAR account that receives payout
  actor?: string;             // agent/did label
  commits?: string[];
  specHash?: string;
  forgeUserId?: string;       // claimed github numeric id — verified vs author
  evidence?: Record<string, unknown>;
}

interface GhAuthor { id: number; login: string }
interface GhIssue {
  number: number; state: string; title: string;
  user: GhAuthor; pull_request?: unknown;
}
interface GhPull extends GhIssue {
  head: { sha: string }; merged_at?: string | null;
  additions: number; deletions: number; changed_files: number;
}
interface GhFile { filename: string; patch?: string; status: string }

function ghHeaders(env: Env): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "widespread-bridge",
    ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

async function gh<T>(env: Env, path: string): Promise<{ data: T | null; error?: string }> {
  const res = await fetch(`${GH_API}${path}`, { headers: ghHeaders(env) });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    return { data: null, error: `github rate limited${reset ? ` (resets ${new Date(Number(reset) * 1000).toISOString()})` : ""} — set GITHUB_TOKEN secret` };
  }
  if (!res.ok) return { data: null, error: `github ${res.status} for ${path}` };
  return { data: (await res.json()) as T };
}

/** Parse owner/repo + kind + number from a forge ref. Returns null when the
 * ref isn't a recognized GitHub issue/PR locator. */
export function parseForgeRef(ref: string):
  { owner: string; repo: string; kind: "issue" | "pr"; number: number } | null {
  const m = ref.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i)
    ?? ref.match(/^([\w.-]+)\/([\w.-]+)[#\/](\d+)$/);
  if (!m) return null;
  if (m.length === 5) {
    return { owner: m[1], repo: m[2], kind: m[3].toLowerCase() === "pull" ? "pr" : "issue", number: Number(m[4]) };
  }
  return { owner: m[1], repo: m[2], kind: "issue", number: Number(m[3]) };
}

/** Deterministic fingerprint over a PR's file patches — the cheap
 * "is this real work" signal (non-empty diff) without a git binary. */
async function patchFingerprint(files: GhFile[]): Promise<string | null> {
  const material = files
    .filter((f) => f.patch)
    .map((f) => `${f.filename}${f.status}${f.patch}`)
    .join("\n---\n");
  if (!material) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function attestationToken(env: Env, payload: Record<string, unknown>): Promise<string | null> {
  const secret = env.ATTEST_SECRET ?? env.ADMIN_TOKEN;
  if (!secret) return null;
  const body = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  return `${body}.${await hmac(secret, body)}`;
}

/** Attestation for fiat-mirror claims — same HMAC scheme, mirror-scoped
 * payload so a token can't be replayed against a NEAR market claim. */
export async function attestationForMirror(env: Env, payload: Record<string, unknown>): Promise<string | null> {
  return attestationToken(env, { ...payload, scope: "mirror" });
}

export async function verifyAttestation(env: Env, token: string): Promise<
  { valid: boolean; payload?: Record<string, unknown>; reason?: string }> {
  const secret = env.ATTEST_SECRET ?? env.ADMIN_TOKEN;
  if (!secret) return { valid: false, reason: "no attestation secret configured" };
  const dot = token.lastIndexOf(".");
  if (dot < 1) return { valid: false, reason: "malformed token" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  // constant-time compare
  let diff = sig.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.min(sig.length, expected.length); i++) {
    diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff) return { valid: false, reason: "bad signature" };
  try {
    const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp < Date.now()) {
      return { valid: false, reason: "expired", payload };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "bad payload" };
  }
}

/** Shared artifact validation — used by both NEAR market claims and
 * fiat mirror claims. Dispatches on the artifact ref kind: github PR/issue
 * (original path), content-addressed CID, coordinator job record, or a
 * signed metered receipt. Returns failures[] plus enriched evidence. */
export async function validateForgeSubmission(
  env: Env,
  body: {
    forgeRef: string; forgeUserId?: string; commits?: string[];
    evidence?: Record<string, unknown>;
    market?: { spec?: string; specHash?: string; verification?: { params?: Record<string, unknown> } };
    sealOpts?: { requireBridgeCopy?: boolean; adjudicatorPubkeys?: string[] };
  },
): Promise<{ failures: string[]; evidence: Record<string, unknown> }> {
  const failures: string[] = [];
  const evidence = { ...(body.evidence ?? {}) };
  const art = parseArtifactRef(body.forgeRef);
  if (!art) {
    return { failures: ["forgeRef must be a github.com owner/repo/(issues|pull)/N, owner/repo#N, btfs://cid, ipfs://cid, sealed://<sha256>, rcpt://id, or a /api/jobs/ ref"], evidence };
  }
  evidence.artifact_kind = art.kind;

  if (art.kind === "cid") {
    return validateCidArtifact(env, art, evidence);
  }
  if (art.kind === "receipt") {
    if (!body.market) {
      return { failures: ["rcpt:// claims require the market spec (meter/threshold) in context"], evidence };
    }
    return validateReceipt(env, art, body.market, evidence);
  }
  if (art.kind === "job") {
    return validateJobArtifact(env, art, evidence);
  }
  if (art.kind === "sealed") {
    return validateSealedArtifact(env, art, evidence, body.sealOpts);
  }

  // github kind — original forge path
  const ref = { owner: art.owner, repo: art.repo, kind: art.issueKind, number: art.number };
  const issueRes = await gh<GhIssue>(env, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
  const issue = issueRes.data;
  if (!issue) {
    failures.push(issueRes.error ?? "forge artifact not found");
  } else {
    if (issue.state !== "open" && ref.kind === "issue") failures.push(`issue is ${issue.state}`);
    const authorId = String(issue.user?.id ?? "");
    if (body.forgeUserId && body.forgeUserId !== authorId) {
      failures.push(`forgeUserId mismatch: artifact author is ${authorId} (${issue.user?.login})`);
    }
    if (ref.kind === "pr") {
      const pr = issue as GhPull;
      const filesRes = await gh<GhFile[]>(env,
        `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`);
      const files = filesRes.data;
      const fp = files?.length ? await patchFingerprint(files) : null;
      if (filesRes.error) failures.push(filesRes.error);
      if (!fp) failures.push("PR has no computable patch (empty or >100-file diff)");
      else {
        evidence.patch_fingerprint = fp;
        evidence.forge = "github";
        evidence.forgeRef = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
        evidence.forgeUserId = authorId;
        evidence.forgeLogin = issue.user?.login;
        evidence.head_sha = pr.head?.sha;
      }
      if (!body.commits?.length && pr.head?.sha) body.commits = [pr.head.sha];
    } else {
      evidence.forge = "github";
      evidence.forgeRef = `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`;
      evidence.forgeUserId = authorId;
      evidence.forgeLogin = issue.user?.login;
    }
  }
  return { failures, evidence };
}

/** Coordinator-dispatched job artifacts — the signed public job record is
 * the evidence: who ran it (device did), what it returned, replica tally,
 * and challenge log. Record sig proves coordinator provenance. */
async function validateJobArtifact(
  env: Env, art: Extract<ArtifactRef, { kind: "job" }>, evidence: Record<string, unknown>,
): Promise<{ failures: string[]; evidence: Record<string, unknown> }> {
  const failures: string[] = [];
  const out: Record<string, unknown> = { ...evidence, artifact: "coordinator-job", job_id: art.jobId, forge: "coordinator" };
  const job = await loadJobRecord(env, art.jobId);
  if (!job) return { failures: [`job ${art.jobId} not found or coordinator unreachable`], evidence: out };
  const sigOk = await verifyJobRecordSig(env, job);
  out.job_sig_verified = sigOk;
  if (!sigOk) failures.push("job record signature does not verify — provenance unknown");
  if (job.status !== "done") failures.push(`job status is ${job.status}, not done`);
  if (job.flag === "challenge-failed") failures.push("job has a failed verification challenge");
  const results = job.results ?? [];
  if (!results.length) failures.push("job has no results");
  const required = job.tally?.required ?? 1;
  if (results.length < required) failures.push(`replica tally ${results.length}/${required} — verification quorum unmet`);
  if (required > 1) {
    if (job.tally?.comparison === "similarity") {
      out.replica_comparison = "similarity"; // nondeterministic (GPU/inference) — judge compares, not byte-exact
    } else if (job.tally && job.tally.agreement === false) {
      failures.push("replica results disagree — deterministic work must byte-match");
    }
  }
  const dids = [...new Set(results.map((r) => r.did).filter(Boolean))];
  if (dids.length) out.device_dids = dids;
  out.job = { taskType: job.taskType, results: results.length, required, market_id: job.market_id ?? null };
  return { failures, evidence: out };
}

export async function handleClaimPost(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as ClaimBody | null;
  if (!body?.marketId || !body.forgeRef) {
    return Response.json({ ok: false, error: "marketId and forgeRef required" }, { status: 400 });
  }
  const acct = env.NEAR_CONTRACT;
  if (!acct) return Response.json({ ok: false, error: "no NEAR_CONTRACT configured" }, { status: 503 });

  const failures: string[] = [];

  // 1. market open + spec binding
  const market = await nearView(env, acct, "getMarket", { marketId: String(body.marketId) }) as
    { status?: string; specHash?: string; spec?: string } | null;
  if (!market) return Response.json({ ok: false, error: "market not found" }, { status: 404 });
  if (market.status !== "open") failures.push(`market status is ${market.status}, not open`);
  if (body.specHash && market.specHash && body.specHash !== market.specHash) {
    failures.push("specHash does not match market specHash");
  }

  // Collective-sealed / full-blind markets: the on-chain spec stub carries
  // `decl=<hash>` → resolve the declaration for its adjudicator keys so
  // sealed deliverables must cover every declared juror (and don't get
  // wrongly asked for a bridge copy on bridge-blind markets).
  let sealOpts: { requireBridgeCopy?: boolean; adjudicatorPubkeys?: string[] } | undefined;
  const declHash = String(market.spec ?? "").match(/decl=([0-9a-f]+)/i)?.[1];
  if (declHash) {
    const { getDeclared } = await import("./declare");
    const bounty = await getDeclared(env, declHash).catch(() => null);
    if (bounty) {
      const bridgeBlind = !!bounty.spec_sealed && !bounty.spec_sealed_bridge_b64;
      sealOpts = { requireBridgeCopy: !bridgeBlind, adjudicatorPubkeys: bounty.adjudicator_x25519_pubkeys };
    }
  }

  // 2-4. artifact validation (shared with fiat mirror claims) — github PRs,
  // content-addressed CIDs, coordinator job records, or metered receipts.
  const fv = await validateForgeSubmission(env, {
    forgeRef: body.forgeRef,
    forgeUserId: body.forgeUserId,
    commits: body.commits,
    evidence: body.evidence,
    market: market as { spec?: string; specHash?: string },
    sealOpts,
  });
  failures.push(...fv.failures);
  const evidence = fv.evidence;
  if (fv.failures.length) {
    return Response.json({ ok: false, attested: false, failures }, { status: 422 });
  }

  // 5. attestation token + ready-to-broadcast shipClaim args
  const fullEvidence: Record<string, unknown> = { ...evidence, claim_api: "v1" };
  const token = await attestationToken(env, {
    marketId: String(body.marketId),
    forgeRef: body.forgeRef,
    forgeUserId: evidence.forgeUserId,
    patch_fingerprint: evidence.patch_fingerprint,
    specHash: body.specHash ?? market.specHash,
  });
  if (token) fullEvidence.attestation = token;

  const shipClaimArgs = {
    marketId: String(body.marketId),
    claimHash: fullEvidence.patch_fingerprint ?? `sha256:${await sha256Hex(JSON.stringify(fullEvidence))}`,
    actor: body.actor ?? fullEvidence.forgeLogin ?? "agent",
    commits: body.commits ?? [],
    evidence: fullEvidence,
    claimant: body.claimant ?? "",
    forgeId: String(evidence.artifact_kind ?? "github"),
    forgeUserId: String(evidence.forgeUserId ?? evidence.device_did ?? ""),
    relayer: "widespread-bridge",
    attested: !!token,
  };

  return Response.json({
    ok: true,
    attested: !!token,
    ...(token ? {} : { warning: "no ATTEST_SECRET configured — claim ships unattested (ineligible for oracle verdict)" }),
    verification: { endpoint: "/api/claims/verify", token },
    shipClaimArgs,
    next: `Sign + broadcast shipClaim(${acct}) with shipClaimArgs from any NEAR account.`,
  }, { status: 201 });
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleClaimVerify(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!token) return Response.json({ ok: false, error: "token required" }, { status: 400 });
  return Response.json(await verifyAttestation(env, token));
}
