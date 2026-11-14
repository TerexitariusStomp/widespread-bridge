# Research basis — what the adjudication + detection design is grounded in

Verified against current literature (Nov 2026 sweep). Each design choice
cites the finding that justifies it; findings that changed the design are
marked **ADOPTED**.

## LLM-as-judge panels

| Finding | Source | Our response |
|---|---|---|
| Single judge agrees with ground truth ~87.6%; judges show position, verbosity, and self-preference biases (~0.73 vs unbiased 0.5) | **Verdict-Bench / Jury** — Divi 2025, IJISAE (>1M simulated judgments) | Panel judging for non-recomputable work; blind presentation (`blindInput` strips claimant identity — self-preference leak vector) |
| Naïve panels *amplify* shared bias; fixes must be bias-aware, not just more votes | same | **Minority-veto escalation** — one "reject" blocks accept instead of majority rubber-stamp. Judges have high TPR but poor TNR — they approve slop; asymmetry is the correct default |
| Correlated errors collapse panel independence: 9 judges ≈ 2–2.5 effective votes; best single judge matches the whole panel | *Nine Judges, Two Effective Votes* (2025) | **Diversity of model family beats seat count** — the roster rotates families (`PANEL_MODELS`), not copies. **ADOPTED**: documented in `adjudicator.ts`; roadmap — report effective-votes in panel output |
| Verbosity bias: longer answers win independent of quality | Verdict-Bench | Roadmap: normalize or flag outsized diff/length claims in judge input |
| Bias-aware aggregation (order-swap, verbosity correction, bias-weighted logits) reaches 98.1% vs 87.6% single | Jury | Roadmap: adopt calibrated confidence aggregation for pairwise comparisons |

## AI-text detection / stylometry

| Finding | Source | Our response |
|---|---|---|
| Detectors degrade to near-random under style shift; perfect authorship detection is impossible | stylometry/detection literature (2023–2025, consistent) | `styleScore` is a **soft signal** fed to the judge — never a gate. "Outcomes, not origins" |
| Watermarks more robust than theory predicted — removal attacks succeed only ~26% (~10% under human review) | *Sandcastles in the Storm*, ACL 2025 | Validates reading provenance signals when present; still too unreliable to gate — stance unchanged |
| Paraphrase/copy-paste/back-translation still sharply degrade detectors (SynthID etc.) | EMNLP 2025 (Waterpark, SynGuard) | Same conclusion — outcomes, not origins |

## Confidential compute / verifiable inference

| Finding | Source | Our response |
|---|---|---|
| Production TEE inference with per-request hardware attestation (Intel TDX + NVIDIA TEE), Ed25519-signed, nonce-bound | NEAR AI Cloud launch (Dec 2025) + published model-attestation verification docs | `provider_tee` verdicts align — already shipped. Roadmap: verify `model_attestations[]` fields explicitly (nonce binding, `intel_quote`, `signing_public_key`) per their docs |
| E2EE inference flows exist — prompt encrypted to enclave, plaintext never visible to operator | same | Basis for the confidential-markets adjudication path (`plan-confidential-markets.md` C3) |

## Verification economics

| Finding | Source | Our response |
|---|---|---|
| Outcome escrow + independent recompute beats trust-the-submitter | protocol design (ours) | `gatherCommitEvidence` re-fetches real diffs; hash-chain replay independent of forge verdict |
| Signed append-only claim streams make forgery detectable | delta-git op-log | `verifyChain` replays SHA-256 chain locally before adjudication |

## Standing rules

- Citations in code comments name the real venue — no "Science (2025)"
  hand-waving (fixed: Verdict-Bench is IJISAE).
- Soft signals never become gates (stylometry, detector scores).
- Panel claims cite effective diversity, not seat count.
- Re-verify this file each major adjudication change.
