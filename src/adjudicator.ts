// The adjudicator seat: a Workers AI LLM makes the accept/reject call.
// This is the hackathon's "AI" half — a model weighs spec-fit and evidence
// integrity and returns a structured verdict. No rules engine decides.

import type {
  Adjudication,
  Bounty,
  ChainVerification,
  CommitEvidence,
  Crosscheck,
  Env,
  OpLogEntry,
} from "./types";

const SYSTEM = `You are the adjudicator for Widespread, a contributor reward pool.
An AI agent claims it shipped work to a git forge; the forge issued a signed,
hash-chained attestation (kind "dg-ship-1"). You are shown the claim, the
independently recomputed evidence, and the bounty spec it was claimed against.

Decide whether the contributor's bounty should be released.

Weigh:
- spec-fit: does the actual diff plausibly deliver what the bounty spec asks?
- evidence integrity: does recomputed work match the claim (files, line counts)?
- substance: is the diff real work, not a no-op, whitespace shuffle, or gibberish?
- provenance: the op-log hash chain result is given; a broken chain is disqualifying.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"verdict":"accept"|"reject","reasoning":"<2-4 sentences citing concrete evidence>","confidence":<0..1>}
confidence is your own calibrated certainty in the verdict.

When the bounty carries a capacity declaration, also include:
"capacity_delta":{"C_e":<−1..1>,"C_h":<−1..1>,"C_k":<−1..1>,"C_inst":<−1..1>,"C_m":<−1..1>} — your estimate of the work's effect on each declared dimension (0 = none, negative = harm);
"floor_violation":true|false — true if the work plausibly pushes any declared dimension BELOW its floor (paid astroturfing, engagement farming, scraping, harassment, covert promo). A floor violation is disqualifying regardless of spec-fit — a perfect spam campaign still fails.`;

interface AdjudicatorInput {
  repo: string;
  entry: OpLogEntry;
  chain: ChainVerification;
  bounty: Bounty | null;
  commits: CommitEvidence[];
  check: Crosscheck;
  /** Derivative-use proof: a later upstream commit landed the same patch
   *  fingerprint — the payer may have used the work without merging. */
  derivative?: { sha: string; matched: boolean } | null;
  /** Confidential deliverable plaintext, opened in-request by the bridge
   *  (C3). Judges read it here; it is never written to any record. */
  sealed_text?: string;
}

function buildPrompt(input: AdjudicatorInput): string {
  const commits = input.commits.map((c) => ({
    sha: c.sha,
    source: c.source,
    message: c.message,
    files: c.files,
    lines_added: c.lines_added,
    lines_removed: c.lines_removed,
    diff_excerpt: c.diff_excerpt,
  }));
  return JSON.stringify(
    {
      repo: input.repo,
      claim: {
        seq: input.entry.seq,
        kind: input.entry.kind,
        actor: input.entry.actor,
        hash: input.entry.hash,
        payload: input.entry.payload,
      },
      hash_chain: {
        valid: input.chain.valid,
        checked_entries: input.chain.checked,
        tip_hash: input.chain.tip_hash,
        broken_at_seq: input.chain.broken_at_seq,
      },
      bounty_spec: input.bounty?.spec ?? null,
      bounty_amount: input.bounty ? `${input.bounty.amount} ${input.bounty.currency}` : null,
      capacity: input.bounty?.capacity ?? null,
      crosscheck: input.check,
      derivative_use: input.derivative ?? null,
      sealed_deliverable: input.sealed_text ?? null,
      commits,
    },
    null,
    2
  );
}

/** Tolerant JSON-object extraction: find the first balanced {...}. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Run the adjudicator. A model failure is NOT an abstain — unparseable or
 * missing output fails closed to reject so money never moves without a
 * verdict the service can show.
 */
/** NEAR AI Cloud signed inference — OpenAI-compatible chat with
 * `signature_kind: "provider_tee"`: the model's TEE signs the exact
 * request+response bytes; GET /v1/signature/<chat_id> returns the proof.
 * Verifying that signature ties the verdict to TEE-executed inference —
 * an operator can't fake which model ran or what it said. */
async function nearAiCall(env: Env, input: AdjudicatorInput, prompt?: string): Promise<{
  raw: string; model: string; signature_id?: string; tee_signature?: unknown;
}> {
  const base = env.NEAR_AI_BASE || "https://cloud-api.near.ai/v1";
  const model = env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.NEAR_AI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt ?? buildPrompt(input) },
      ],
      // Reasoning models (DeepSeek-V4.x) spend part of the budget on
      // reasoning_content before emitting content — 1024 starves the
      // answer entirely (content:null → unparseable verdict).
      max_tokens: 4096,
      temperature: 0,
      // Ask the model TEE to sign the exact in/out bytes.
      signature_kind: "provider_tee",
    }),
  });
  if (!res.ok) throw new Error(`near-ai ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.json()) as {
    id?: string;
    choices?: { message?: { content?: string } }[];
    signature_kind?: string;
  };
  const raw = out?.choices?.[0]?.message?.content ?? JSON.stringify(out);
  // Fetch the TEE signature over this exact completion (records expire
  // ~60min — grab it now).
  let tee_signature: unknown;
  if (out.id) {
    tee_signature = await fetch(`${base}/signature/${out.id}`, {
      headers: { authorization: `Bearer ${env.NEAR_AI_API_KEY}` },
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return { raw, model, signature_id: out.id, tee_signature };
}

/** One judge call. `model` lets a panel override the env default;
 * `blind` strips claimant identity from the prompt so the judge weighs
 * the work, not the worker. */
async function callJudge(env: Env, input: AdjudicatorInput, model: string, blind: boolean): Promise<Adjudication> {
  const useNearAi = !!(env as { NEAR_AI_API_KEY?: string }).NEAR_AI_API_KEY;
  const eff = blind ? blindInput(input) : input;
  let raw = "";
  let sig: { signature_id?: string; tee_signature?: unknown } = {};
  try {
    if (useNearAi) {
      const r = await nearAiCall(env, input, buildPrompt(eff));
      raw = r.raw; sig = { signature_id: r.signature_id, tee_signature: r.tee_signature };
    } else {
      // Ai.run may return {response} or an OpenAI-style chat.completion
      // envelope — unwrap whichever we get.
      const out = (await env.AI.run(model as keyof AiModels, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: buildPrompt(eff) },
        ],
        max_tokens: 1024,
        temperature: 0,
      })) as {
        response?: string;
        choices?: { message?: { content?: string } }[];
      };
      raw =
        (typeof out?.response === "string" && out.response) ||
        out?.choices?.[0]?.message?.content ||
        JSON.stringify(out);
    }
  } catch (e) {
    return {
      verdict: "reject",
      reasoning: `adjudicator unavailable: ${String(e)}`,
      confidence: 0,
      model,
      error: "model-call-failed",
    };
  }

  const parsed = extractJson(raw);
  let verdict: "accept" | "reject" = parsed?.verdict === "accept" ? "accept" : "reject";
  // MORE floor axis: a declared floor violation is disqualifying
  // regardless of the model's spec-fit verdict (feasibility tier).
  const floorViolation = parsed?.floor_violation === true;
  if (floorViolation) verdict = "reject";
  // capacity_delta: model estimate, clamped to [-1,1] per dim, labeled.
  const rawDelta = parsed?.capacity_delta;
  const capacityDelta = rawDelta && typeof rawDelta === "object" && !Array.isArray(rawDelta)
    ? Object.fromEntries(Object.entries(rawDelta as Record<string, unknown>)
        .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
        .map(([k, v]) => [k, Math.max(-1, Math.min(1, v as number))]))
    : null;
  const hasCapacity = !!input.bounty?.capacity?.dims?.length;
  const confidence =
    typeof parsed?.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  const reasoning =
    typeof parsed?.reasoning === "string" && parsed.reasoning.trim().length > 0
      ? parsed.reasoning.trim()
      : "adjudicator returned no parseable verdict";
  return {
    verdict,
    reasoning: floorViolation
      ? `floor violation: ${reasoning}`
      : reasoning,
    confidence,
    model,
    raw_excerpt: raw.slice(0, 500),
    ...(hasCapacity ? {
      capacity_delta: capacityDelta,
      floors_respected: !floorViolation,
    } : {}),
    ...(sig.signature_id ? { signature_id: sig.signature_id } : {}),
    ...(sig.tee_signature ? { tee_signature: sig.tee_signature } : {}),
    ...(parsed ? {} : { error: "unparseable-output" }),
  };
}

/** Strip anything that identifies the claimant so panel judges weigh
 * the work, not the worker — lineage/identity cues are the documented
 * self-preference leak in LLM panels (Verdict-Bench 2025). */
function blindInput(input: AdjudicatorInput): AdjudicatorInput {
  const { entry, ...rest } = input;
  const { agent: _a, actor: _b, claimant: _c, ...e } = entry as unknown as Record<string, unknown>;
  return { ...rest, entry: e as unknown as OpLogEntry };
}

export async function adjudicate(env: Env, input: AdjudicatorInput): Promise<Adjudication> {
  const useNearAi = !!(env as { NEAR_AI_API_KEY?: string }).NEAR_AI_API_KEY;
  const model = useNearAi
    ? (env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017")
    : (env.LLM_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  return callJudge(env, input, model, false);
}

/** Bias-corrected evaluator panel for non-recomputable verticals.
 * Verdict-Bench/Jury (Divi 2025, IJISAE): naive panels amplify shared
 * bias; single judges hit ~88% ground truth. Correlated-error research
 * ("Nine Judges, Two Effective Votes", 2025) shows N judges collapse to
 * ~2 effective votes when errors correlate — so diversity of model
 * FAMILY beats seat count, which is why the roster rotates families.
 * Judges are strong on TPR but weak on TNR — they approve slop.
 * Policy: odd-N diverse-family judges on BLINDED evidence;
 * minority-veto — any "reject" escalates instead of letting a majority
 * rubber-stamp; per-judge verdicts are recorded for calibration against
 * human-labeled outcomes. PANEL_MODELS overrides the default seat list;
 * PANEL_SEATS caps the draw. */
export async function adjudicatePanel(env: Env, input: AdjudicatorInput): Promise<Adjudication> {
  const seats = Math.max(3, Math.min(7, parseInt(env.PANEL_SEATS ?? "3", 10) || 3));
  const roster = (env.PANEL_MODELS ??
    `${env.NEAR_AI_MODEL || "deepseek-ai/DeepSeek-V4.1-Flash-1017"},${env.LLM_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast"}`)
    .split(",").map((m: string) => m.trim()).filter(Boolean);
  const judges = await Promise.all(
    Array.from({ length: seats }, (_, i) =>
      callJudge(env, input, roster[i % roster.length], true)),
  );
  const dissent = judges.filter((j) => j.verdict === "reject");
  const accepts = judges.length - dissent.length;
  // Minority-veto: one dissent blocks an accept — the claim stays
  // disputable to the on-chain oracle quorum (and ultimately Kleros),
  // NOT a human review tier. Machines judge; disputes are economic.
  const verdict = dissent.length === 0 ? "accept" : "reject";
  const confidence = accepts / judges.length;
  return {
    verdict,
    reasoning: dissent.length === 0
      ? `panel ${accepts}/${judges.length} accept — ${judges[0]?.reasoning ?? ""}`
      : `minority-veto: ${dissent.length}/${judges.length} dissent → escalate. ${dissent[0]?.reasoning ?? ""}`,
    confidence,
    model: `panel(${roster.join("|")})`,
    panel: judges.map((j) => ({
      model: j.model, verdict: j.verdict, confidence: j.confidence,
      ...(j.signature_id ? { signature_id: j.signature_id } : {}),
    })),
    panel_escalated: dissent.length > 0,
  };
}
