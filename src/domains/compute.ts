// compute.ts — machine-work domain packs: content-addressed artifacts,
// coordinator job records, and metered resource receipts. These are the
// verification surfaces for the absorbed runner/coordinator network —
// a market for any deliverable that resolves to a CID or a receipt, no
// forge account required.

import type { DomainPack, ValidateFn } from "./types";
import {
  parseArtifactRef, validateCidArtifact, validateReceipt, loadJobRecord,
  verifyJobRecordSig,
} from "../artifacts";
import type { Env } from "../types";

const cidPack = (scheme: "btfs" | "ipfs"): ValidateFn => async ({ claim }, { env }) => {
  const art = parseArtifactRef(claim.ref);
  if (!art || art.kind !== "cid" || art.scheme !== scheme) {
    return { failures: [`ref must be ${scheme}://cid or a ${scheme} gateway URL`], evidence: {} };
  }
  return validateCidArtifact(env as unknown as Env, art, claim.evidence ?? {});
};

const jobPack: ValidateFn = async ({ claim }, { env }) => {
  const art = parseArtifactRef(claim.ref);
  if (!art || art.kind !== "job") {
    return { failures: ["ref must be job:<id>, widespread://job/<id>, or a /api/jobs/<id> URL"], evidence: {} };
  }
  const job = await loadJobRecord(env as unknown as Env, art.jobId);
  if (!job) return { failures: [`job ${art.jobId} not found or coordinator unreachable`], evidence: { job_id: art.jobId } };
  const failures: string[] = [];
  if (!(await verifyJobRecordSig(env as unknown as Env, job))) failures.push("job record sig invalid");
  if (job.status !== "done") failures.push(`job status ${job.status}`);
  if (job.flag === "challenge-failed") failures.push("job failed a verification challenge");
  if ((job.results ?? []).length < (job.tally?.required ?? 1)) failures.push("replica quorum unmet");
  const evidence: Record<string, unknown> = {
    artifact: "coordinator-job", job_id: art.jobId, forge: "coordinator",
    taskType: job.taskType, results: job.results?.length ?? 0,
    required: job.tally?.required ?? 1,
    replica_comparison: job.tally?.comparison ?? "exact",
    device_dids: [...new Set((job.results ?? []).map((r) => r.did).filter(Boolean))],
  };
  return { failures, evidence };
};

const receiptPack: ValidateFn = async ({ market, claim }, { env }) => {
  const art = parseArtifactRef(claim.ref);
  if (!art || art.kind !== "receipt") {
    return { failures: ["ref must be rcpt://<receiptId> with evidence.receipt"], evidence: {} };
  }
  return validateReceipt(
    env as unknown as Env, art,
    market as { spec?: string; verification?: { params?: Record<string, unknown> } },
    claim.evidence ?? {},
  );
};

export const computePacks: DomainPack[] = [
  {
    name: "btfs-artifact", evidence_class: "cid-artifact",
    display: "BTFS content-addressed artifact",
    validate: cidPack("btfs"),
  },
  {
    name: "ipfs-artifact", evidence_class: "cid-artifact",
    display: "IPFS content-addressed artifact",
    validate: cidPack("ipfs"),
  },
  {
    name: "runner-job", evidence_class: "coordinator-job",
    display: "Coordinator-dispatched job record",
    validate: jobPack,
  },
  {
    name: "resource-receipt", evidence_class: "metered-receipt",
    display: "Signed metered resource receipt",
    validate: receiptPack,
  },
];
