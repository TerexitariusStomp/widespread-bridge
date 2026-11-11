// evaluator.ts — independent evaluator-as-a-service for external jobs.
// The ecosystem's gap (0.02% of live ERC-8183 jobs use an independent
// evaluator) is this service's niche: any platform can name our oracle
// as `evaluator`, or a client can POST a job+deliverable for a signed,
// calibrated verdict. Reuses the existing adjudicator — no new judge.
import { adjudicate, adjudicatePanel } from "./adjudicator";
import { evmCall, decodeJob } from "./evmread";
import { oracleEnv, signVerdict } from "./oracle";
import type { Env } from "./types";

const te = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", te.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleEvaluate(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "json body required" }, { status: 400 });

  // Resolve the job: inline description, or on-chain ERC-8183 reference.
  let description = String(body.description ?? "");
  let jobRef = String(body.ref ?? "");
  let expiredAt = "";
  if (!description && body.rpc && body.contract && body.jobId !== undefined) {
    const sel = "0xbf22c457" + Number(body.jobId).toString(16).padStart(64, "0");
    const raw = await evmCall(String(body.rpc), String(body.contract), sel);
    const job = raw && decodeJob(raw);
    if (!job) return Response.json({ error: "job not readable on-chain" }, { status: 404 });
    description = job.description;
    jobRef = jobRef || `evm:${body.contract}:${body.jobId}`;
    expiredAt = String(job.expiredAt);
  }
  const deliverable = String(body.deliverable ?? body.deliverableUrl ?? "");
  if (!description || !deliverable) {
    return Response.json({ error: "need {description, deliverable} or {rpc, contract, jobId, deliverable}" }, { status: 400 });
  }

  // Panel for non-code/external work — blind evidence, minority veto.
  const adj = await adjudicatePanel(env, {
    repo: jobRef || "external",
    entry: {
      seq: 0, hash: "", prev_hash: "", kind: "external-evaluation",
      actor: "external-client",
      payload: {
        evaluation_mode: "spec-vs-deliverable",
        note: "The deliverable below IS the complete submitted work product — judge whether it satisfies the spec. There are no commits or diffs to recompute; absence of code artifacts is not a reject reason.",
        spec: description,
        deliverable,
      },
      created_at: Date.now(),
    },
    chain: { valid: true, checked: 0, tip_hash: null, tip_seq: 0, broken_at_seq: null },
    bounty: null,
    commits: [{ sha: "", source: "unavailable", message: "submitted deliverable",
      files: [], lines_added: 0, lines_removed: 0, diff_excerpt: deliverable.slice(0, 8000),
      evidence_url: null, patch_fingerprint: null }],
    check: { claimed_files: null, recomputed_files: 0, files_consistent: null,
      claimed_lines: null, recomputed_lines: 0, lines_consistent: null,
      commits_verified: 0, commits_total: 0, partial: false },
  });

  const evidenceHash = await sha256Hex(JSON.stringify({ description, deliverable, verdict: adj.verdict }));
  let oracle = null;
  const cfg = oracleEnv(env as unknown as Parameters<typeof oracleEnv>[0]);
  if (cfg) {
    oracle = await signVerdict(cfg, jobRef || "external", evidenceHash,
      adj.verdict === "accept" ? "accept" : "reject", expiredAt || "0").catch(() => null);
  }

  return Response.json({
    schema: "wide-eval/1",
    verdict: adj.verdict === "accept" ? "complete" : "reject", // ERC-8183 vocabulary
    confidence: adj.confidence,
    reasoning: adj.reasoning,
    ...(adj.panel ? { panel: adj.panel } : {}),
    evidenceHash,
    erc8183: { action: adj.verdict === "accept" ? "complete" : "reject" },
    oracle,
    evaluator: "widespread-bridge",
  });
}
