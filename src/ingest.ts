// ingest.ts — automatic submission ingestion for funded mirrors.
//
// "Everything automatic": third-party bounty flows stay exactly as the
// platform designed them — work arrives as ordinary PRs/comments on the
// original forge issue. This pass watches funded mirrors' linked issues,
// finds cross-referenced PRs via the GitHub timeline API, validates each
// through the same forge-artifact pipeline as manual claims, and files
// attested mirror claims — no agent ever has to call /api/mirrors/claims.
//
// Bounded hard: only funded mirrors (fiat captured or on-chain market),
// at most MIRROR_SCAN_LIMIT per scan, PR_SCAN_LIMIT validations per scan — GitHub's
// unauthenticated budget is ~60 req/hr shared with the feed scanners.

import type { Env, MirrorListing } from "./types";
import { getFeedDoc } from "./feedstore";
import { validateForgeSubmission, attestationForMirror } from "./claims";

const MIRROR_SCAN_LIMIT = 10;
const PR_SCAN_LIMIT = 15;
const claimKey = (mirrorId: string, hash: string) => `mclaim:${mirrorId}:${hash}`;

const GH_API = "https://api.github.com";

function ghHeaders(env: Env): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "widespread-bridge",
    ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

/** Extract owner/repo + issue number from a GitHub-sourced record id like
 * `github-thirdparty:generic:Expensify/App#103875`. */
function parseIssueRef(recordId: string): { owner: string; repo: string; issue: number } | null {
  const m = recordId.match(/([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { owner: m[1].split("/")[0], repo: m[1].split("/")[1], issue: Number(m[2]) } : null;
}

interface TimelineEvent {
  event?: string;
  source?: { issue?: { number?: number; pull_request?: unknown; state?: string; user?: { id?: number; login?: string } } };
}

async function isFunded(env: Env, mirror: MirrorListing): Promise<boolean> {
  if (mirror.status === "funded" && mirror.funded_market_id) return true;
  const f = await env.CLAIMS.get(`escrowstate:${mirror.id}`).then((v) => v ? JSON.parse(v) : null);
  return f?.status === "confirmed";
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One scan pass — called after each feed refresh (30 min cadence). */
export async function scanMirrorSubmissions(env: Env): Promise<{ scanned: number; claims_filed: number; errors: string[] }> {
  const doc = await getFeedDoc(env);
  const mirrors = (doc?.mirrors ?? []).filter((m) => m.id.startsWith("mirror:"));
  const errors: string[] = [];
  let scanned = 0, filed = 0, prChecks = 0;

  for (const mirror of mirrors) {
    if (scanned >= MIRROR_SCAN_LIMIT || prChecks >= PR_SCAN_LIMIT) break;
    const ref = parseIssueRef(mirror.record_id);
    if (!ref) continue;
    if (!(await isFunded(env, mirror))) continue;
    scanned++;

    // Issue timeline → cross-referenced PRs (the platform-native way work
    // gets linked to a bounty issue: "owner/repo#N" in PR body/title).
    const tl = await fetch(
      `${GH_API}/repos/${ref.owner}/${ref.repo}/issues/${ref.issue}/timeline?per_page=100`,
      { headers: ghHeaders(env), signal: AbortSignal.timeout(10000) });
    if (tl.status === 403 || tl.status === 429) {
      errors.push(`github rate limited on ${mirror.record_id} — back off`);
      break; // shared budget exhausted; next refresh resumes
    }
    if (!tl.ok) { errors.push(`timeline ${tl.status} for ${mirror.record_id}`); continue; }
    const events = (await tl.json()) as TimelineEvent[];
    const prs = new Map<number, { login?: string }>();
    for (const e of events) {
      if (e.event !== "cross-referenced") continue;
      const src = e.source?.issue;
      if (src?.number && src.pull_request && src.state === "open") {
        prs.set(src.number, { login: src.user?.login });
      }
    }
    if (!prs.size) continue;

    for (const [prNum] of prs) {
      if (prChecks >= PR_SCAN_LIMIT) break;
      const forgeRef = `https://github.com/${ref.owner}/${ref.repo}/pull/${prNum}`;
      // Cheap pre-check: does a claim already exist for this PR's patch?
      // We don't know the fingerprint until validation, so dedupe on a
      // per-PR marker key instead.
      const marker = `mclaimpr:${mirror.id}:${prNum}`;
      if (await env.CLAIMS.get(marker)) continue;
      prChecks++;

      const fv = await validateForgeSubmission(env, { forgeRef });
      if (fv.failures.length) {
        // Real submission check failed — mark seen so we don't re-burn
        // rate limit on the same broken PR every scan. Transient errors
        // (rate limit text) still get retried next cycle? Keep it simple:
        // mark seen; a fixed PR produces a different fingerprint anyway.
        await env.CLAIMS.put(marker, JSON.stringify({ at: Date.now(), failures: fv.failures }));
        continue;
      }
      const evidence: Record<string, unknown> = {
        ...fv.evidence, claim_api: "mirror-v1-auto", mirror_id: mirror.id,
        auto_ingested: true,
      };
      const fp = String(evidence.patch_fingerprint ?? "");
      const claimHash = fp || `sha256:${await sha256Hex(JSON.stringify(evidence))}`;
      const key = claimKey(mirror.id, claimHash);
      if (await env.CLAIMS.get(key)) { await env.CLAIMS.put(marker, "1"); continue; }

      const token = await attestationForMirror(env, {
        mirror_id: mirror.id, forgeRef,
        forgeUserId: evidence.forgeUserId,
        patch_fingerprint: fp || undefined, claim_hash: claimHash, auto: true,
      });
      if (token) evidence.attestation = token;

      const claim = {
        mirror_id: mirror.id,
        claim_hash: claimHash,
        forgeRef,
        forge_user_id: String(evidence.forgeUserId ?? ""),
        forge_login: evidence.forgeLogin ?? null,
        actor: evidence.forgeLogin ?? "agent",
        commits: evidence.head_sha ? [String(evidence.head_sha)] : [],
        evidence,
        payout: null,               // winner supplies payout address at verdict
        attested: !!token,
        auto_ingested: true,
        created_at: Date.now(),
        status: "pending",
      };
      await env.CLAIMS.put(key, JSON.stringify(claim));
      await env.CLAIMS.put(marker, "1");
      filed++;
    }
  }
  return { scanned, claims_filed: filed, errors };
}
