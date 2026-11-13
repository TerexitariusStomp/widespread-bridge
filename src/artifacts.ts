// artifacts.ts — universal artifact references for claims.
//
// The GitHub PR-shaped forgeRef is one kind of evidence, not the only one.
// Task markets settle by content-addressed artifacts (btfs:// or ipfs://
// CID — any deliverable, no forge account needed) and resource markets by
// signed metered receipts (rcpt://<id> + evidence.receipt). Coordinator-
// dispatched jobs reference the signed job record (job:<id> or a
// /api/jobs/<id> URL).
//
// Three guarantees, never conflated:
//   CID                → the content existed (addressed, resolvable)
//   device signature   → who produced it (did:key on the receipt/result)
//   upstream refs /
//   challenge log      → that metered service was actually delivered

import type { Env } from "./types";
import { verifyDidKey } from "./coordinator/didkey";
import { verifyUpstreamRef, UPSTREAM_NETWORKS } from "./upstream";

export type ArtifactRef =
  | { kind: "github"; owner: string; repo: string; issueKind: "issue" | "pr"; number: number }
  | { kind: "cid"; scheme: "btfs" | "ipfs"; cid: string }
  | { kind: "job"; jobId: string }
  | { kind: "receipt"; receiptId: string };

/** CIDv0 (Qm… base58) or CIDv1 (b… base32 / z… base58) shape check —
 *  structural validation only; resolvability is checked separately. */
export function isCid(s: string): boolean {
  return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)
    || /^b[a-z2-7]{20,120}$/.test(s)
    || /^z[1-9A-HJ-NP-Za-km-z]{20,120}$/.test(s);
}

/** Parse a forgeRef string into a tagged artifact ref, or null when it
 * matches no known scheme. GitHub refs keep the parseForgeRef shape. */
export function parseArtifactRef(ref: string): ArtifactRef | null {
  const r = ref.trim();
  let m = r.match(/^(btfs|ipfs):\/\/([A-Za-z0-9]+)$/i);
  if (m) {
    const cid = m[2];
    return isCid(cid) ? { kind: "cid", scheme: m[1].toLowerCase() as "btfs" | "ipfs", cid } : null;
  }
  // gateway URLs: …/ipfs/<cid> | …/btfs/<cid>
  m = r.match(/^https?:\/\/[^/]+\/(ipfs|btfs)\/([A-Za-z0-9]+)/i);
  if (m && isCid(m[2])) {
    return { kind: "cid", scheme: m[1].toLowerCase() as "btfs" | "ipfs", cid: m[2] };
  }
  m = r.match(/^rcpt:\/\/([A-Za-z0-9._:-]{4,128})$/i);
  if (m) return { kind: "receipt", receiptId: m[1] };
  m = r.match(/^(?:widespread:\/\/job\/|job:)([A-Za-z0-9._:-]{4,128})$/i)
    ?? r.match(/^https?:\/\/[^/]+\/api\/jobs\/([A-Za-z0-9._:-]{4,128})/i);
  if (m) return { kind: "job", jobId: m[1] };
  const gh = r.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i)
    ?? r.match(/^([\w.-]+)\/([\w.-]+)[#/](\d+)$/);
  if (gh) {
    if (gh.length === 5) {
      return { kind: "github", owner: gh[1], repo: gh[2], issueKind: gh[3].toLowerCase() === "pull" ? "pr" : "issue", number: Number(gh[4]) };
    }
    return { kind: "github", owner: gh[1], repo: gh[2], issueKind: "issue", number: Number(gh[3]) };
  }
  return null;
}

// ------------------------------------------------------------------ CID

const CID_GATEWAYS: Record<"btfs" | "ipfs", string[]> = {
  btfs: ["https://gateway.btfs.io/btfs/", "https://dweb.link/ipfs/"],
  ipfs: ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"],
};

async function sha256HexBuf(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate a CID artifact: shape + (a) inline content hash when the claim
 * embeds the payload (≤256KB, proof without network) or (b) resolvability
 * through a public gateway. Hard-fails malformed CIDs and content whose
 * hash mismatches; gateway-unresolvable CIDs fail too — a deliverable that
 * doesn't resolve isn't a deliverable. */
export async function validateCidArtifact(
  env: Env, ref: Extract<ArtifactRef, { kind: "cid" }>, evidence: Record<string, unknown>,
): Promise<{ failures: string[]; evidence: Record<string, unknown> }> {
  const failures: string[] = [];
  const out: Record<string, unknown> = {
    ...evidence, artifact: "cid", artifact_scheme: ref.scheme, cid: ref.cid, forge: ref.scheme,
  };

  const inline = typeof evidence.artifact_inline === "string" ? evidence.artifact_inline : null;
  if (inline) {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(inline), (c) => c.charCodeAt(0)); }
    catch { return { failures: ["artifact_inline is not valid base64"], evidence: out }; }
    if (bytes.length > 256 * 1024) failures.push("artifact_inline exceeds 256KB — pin and submit the CID instead");
    const hash = await sha256HexBuf(bytes);
    out.artifact_sha256 = `sha256:${hash}`;
    if (evidence.artifact_sha256 && evidence.artifact_sha256 !== `sha256:${hash}`) {
      failures.push("artifact_inline hash does not match declared artifact_sha256");
    } else {
      out.inline_verified = true;
    }
    return { failures, evidence: out };
  }

  const gateways = (env.ARTIFACT_GATEWAY ? [env.ARTIFACT_GATEWAY] : [])
    .concat(CID_GATEWAYS[ref.scheme])
    .map((g) => (g.endsWith("/") ? g : `${g}/`));
  let resolved = false;
  let lastErr = "";
  for (const gw of gateways.slice(0, 3)) {
    try {
      const res = await fetch(`${gw}${ref.cid}`, {
        method: "HEAD", signal: AbortSignal.timeout(7000),
      });
      if (res.ok || res.status === 405) {
        resolved = true;
        out.gateway = gw;
        const len = res.headers.get("content-length");
        if (len) out.bytes = Number(len);
        // 405 = gateway has the object but no HEAD — resolved either way.
        break;
      }
      lastErr = `${gw} → ${res.status}`;
    } catch (e) {
      lastErr = `${gw} → ${e instanceof Error ? e.name : "fetch error"}`;
    }
  }
  out.resolved = resolved;
  if (!resolved) failures.push(`cid not resolvable via public gateways (${lastErr || "none tried"}) — pin the artifact before claiming`);
  return { failures, evidence: out };
}

// -------------------------------------------------------------- receipts

export interface MeteredReceipt {
  id: string;
  node_did: string;              // did:key:z… — signs the receipt
  meter_kind: string;            // bandwidth_gb | storage_gb_mo | compute_hrs | tokens | …
  units: Record<string, number>;
  period_secs: number;
  upstream_refs?: string[];      // net:opaque-id — see upstream.ts
  coordinator_job?: string;      // jobId when issued inside a coordinator job
  issued_at: number;
  sig_hex: string;               // ed25519 over canonical receipt
}

/** Canonical receipt payload: `widespread-receipt\n<id>\n<sha256(payloadJson)>`
 * where payloadJson is the receipt minus sig_hex (insertion-order JSON). */
export async function receiptCanonical(receipt: MeteredReceipt): Promise<string> {
  const { sig_hex: _sig, ...payload } = receipt;
  const digest = await sha256HexBuf(new TextEncoder().encode(JSON.stringify(payload)));
  return `widespread-receipt\n${receipt.id}\n${digest}`;
}

export async function verifyReceiptSig(receipt: MeteredReceipt): Promise<boolean> {
  if (!receipt?.sig_hex || !/^[0-9a-fA-F]{128}$/.test(receipt.sig_hex)) return false;
  const sig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) sig[i] = parseInt(receipt.sig_hex.slice(i * 2, i * 2 + 2), 16);
  return verifyDidKey(receipt.node_did, await receiptCanonical(receipt), sig);
}

/** Parse `meter:<kind> threshold:<n> window:<dur>` tokens from a market spec —
 * funders declare measurable acceptance in-spec; claimants never set their
 * own threshold. Also honors market.verification.params when present. */
export function meterSpec(market: { spec?: string; verification?: { params?: Record<string, unknown> } }):
  { meter: string | null; threshold: number | null; window_secs: number | null } {
  const params = market.verification?.params ?? {};
  const spec = market.spec ?? "";
  const meter = (params.meter as string | undefined)
    ?? spec.match(/\bmeter:([a-z_][a-z0-9_]*)/i)?.[1]?.toLowerCase() ?? null;
  const threshold = params.threshold !== undefined ? Number(params.threshold)
    : spec.match(/\bthreshold:([0-9.]+)/i)?.[1] !== undefined
      ? Number(spec.match(/\bthreshold:([0-9.]+)/i)![1]) : null;
  const winRaw = (params.window as string | undefined) ?? spec.match(/\bwindow:([0-9]+[smhd])/i)?.[1] ?? null;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const window_secs = winRaw
    ? Number(winRaw.slice(0, -1)) * (mult[winRaw.slice(-1).toLowerCase()] ?? 1)
    : null;
  return { meter, threshold: Number.isFinite(threshold) ? threshold : null, window_secs };
}

// -------------------------------------------------------- coordinator job

export interface JobRecord {
  jobId: string; taskType: number; status: string;
  market_id?: string; results?: { volunteer: string; did?: string; result: string; result_sig?: string }[];
  tally?: { required?: number; agreement?: boolean; comparison?: string };
  challenges?: { nonce: string; ok: boolean }[];
  flag?: string; sig?: string;
  [k: string]: unknown;
}

/** Load a coordinator job record — DO stub fast path when bound, else the
 * public /api/jobs/<id> endpoint. Returns null when unreachable. */
export async function loadJobRecord(env: Env, jobId: string): Promise<JobRecord | null> {
  const enc = encodeURIComponent(jobId);
  if (env.COORDINATOR) {
    try {
      const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
      const res = await stub.fetch(`https://coordinator.internal/api/jobs/${enc}`);
      if (res.ok) return (await res.json()) as JobRecord;
    } catch { /* fall through to public URL */ }
  }
  const base = env.PUBLIC_BASE?.replace(/\/$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/jobs/${enc}`, { signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as JobRecord) : null;
  } catch {
    return null;
  }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a coordinator job record's provenance sig — HMAC over the record
 * minus `sig` (insertion-order JSON; the coordinator emits fields in stable
 * order). Unsigned records pass only when no secret is configured (dev). */
export async function verifyJobRecordSig(env: Env, record: JobRecord): Promise<boolean> {
  const secret = env.COORDINATOR_SECRET ?? env.ATTEST_SECRET ?? env.ADMIN_TOKEN;
  if (!record.sig) return !secret; // unsigned record acceptable only in dev
  if (!secret) return false;       // signed record but we can't check
  const { sig: _s, ...payload } = record;
  const expected = await hmacHex(secret, JSON.stringify(payload));
  return expected === record.sig;
}

/** Validate a rcpt:// claim: device signature, threshold vs the market's
 * declared meter spec, and corroboration — upstream refs (format + live
 * verify where the network supports it) or a clean coordinator challenge
 * log. Self-reported metering alone never attests. */
export async function validateReceipt(
  env: Env, ref: Extract<ArtifactRef, { kind: "receipt" }>,
  market: { spec?: string; verification?: { params?: Record<string, unknown> } },
  evidence: Record<string, unknown>,
): Promise<{ failures: string[]; evidence: Record<string, unknown> }> {
  const failures: string[] = [];
  const out: Record<string, unknown> = { ...evidence, artifact: "receipt", receipt_id: ref.receiptId, forge: "receipt" };

  const receipt = (evidence.receipt ?? null) as MeteredReceipt | null;
  if (!receipt || typeof receipt !== "object") {
    return { failures: ["rcpt:// claims require evidence.receipt — the signed metered receipt"], evidence: out };
  }
  if (receipt.id !== ref.receiptId) failures.push(`receipt id ${receipt.id} does not match ref ${ref.receiptId}`);
  if (!receipt.node_did?.startsWith("did:key:")) failures.push("receipt.node_did must be a did:key");
  if (typeof receipt.units !== "object" || !receipt.units) failures.push("receipt.units missing");
  if (typeof receipt.period_secs !== "number" || receipt.period_secs <= 0) failures.push("receipt.period_secs invalid");
  if (receipt.issued_at && Math.abs(Date.now() - receipt.issued_at) > 35 * 86400_000) {
    failures.push("receipt is stale (>35 days old)");
  }
  if (failures.length) return { failures, evidence: out };

  // device signature — who produced it
  const sigOk = await verifyReceiptSig(receipt);
  out.sig_verified = sigOk;
  if (!sigOk) {
    failures.push("receipt signature does not verify against node_did");
    return { failures, evidence: out };
  }
  out.device_did = receipt.node_did;

  // threshold vs market-declared meter spec
  const ms = meterSpec(market);
  const meter = ms.meter ?? receipt.meter_kind;
  if (!meter || !ms.threshold) {
    failures.push("market spec declares no measurable threshold (meter:<kind> threshold:<n>) — resource claims need an objective acceptance rule");
    return { failures, evidence: out };
  }
  const delivered = Number(receipt.units[meter] ?? NaN);
  out.meter = meter;
  out.threshold = ms.threshold;
  out.delivered = delivered;
  if (!Number.isFinite(delivered)) {
    failures.push(`receipt has no units['${meter}'] reading`);
    return { failures, evidence: out };
  }
  if (delivered < ms.threshold) {
    failures.push(`metered ${delivered} ${meter} below market threshold ${ms.threshold}`);
    return { failures, evidence: out };
  }
  if (ms.window_secs && receipt.period_secs > ms.window_secs * 1.1) {
    failures.push(`receipt window ${receipt.period_secs}s exceeds market window ${ms.window_secs}s — split the service period`);
    return { failures, evidence: out };
  }

  // corroboration — upstream proofs or coordinator challenges, never self-report
  const refs = receipt.upstream_refs ?? [];
  const upstream: { ref: string; network: string; verified: boolean; detail: string }[] = [];
  for (const r of refs.slice(0, 10)) {
    upstream.push(await verifyUpstreamRef(env, r));
  }
  out.upstream = upstream;
  const upstreamOk = upstream.length > 0 && upstream.every((u) => u.network !== "unknown");
  const upstreamVerified = upstream.some((u) => u.verified);

  let challengeOk = false;
  const jobId = receipt.coordinator_job ?? (typeof evidence.coordinator_job === "string" ? evidence.coordinator_job : null);
  if (jobId) {
    const job = await loadJobRecord(env, jobId);
    if (job) {
      out.coordinator_job = { jobId, status: job.status, flag: job.flag ?? null };
      if (job.flag === "challenge-failed") {
        failures.push("coordinator challenge log shows a failed proof — service delivery unverifiable");
      } else if (job.challenges?.length) {
        challengeOk = job.challenges.every((c) => c.ok);
        out.challenge_log = { total: job.challenges.length, passed: job.challenges.filter((c) => c.ok).length };
      }
    }
  }
  if (typeof evidence.challenge_ok === "boolean") challengeOk = challengeOk || evidence.challenge_ok === true;

  if (!upstreamOk && !challengeOk) {
    failures.push("unverifiable metering — provide upstream_refs (network proofs) or a coordinator job with a clean challenge log");
  } else {
    out.metering_confidence = upstreamVerified ? "upstream-verified"
      : upstreamOk ? "upstream-referenced" : "challenge-verified";
  }
  return { failures, evidence: out };
}

export { UPSTREAM_NETWORKS };
