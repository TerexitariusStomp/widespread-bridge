# Science — finding → mechanism

Current research the verifier encodes (sources cited):

| Finding | Mechanism | Where |
|---|---|---|
| LLM judges: TPR>96% but TNR<25% — approve slop (arXiv 2510.11822) | minority-veto: any "reject" escalates, no majority rubber-stamp | `src/adjudicator.ts` adjudicatePanel |
| Naive random-N panels amplify shared bias (Verdict-Bench/Jury, IJISAE 2025) | diverse-family roster + per-judge records for calibration | adjudicator.ts, `jcal:` KV |
| Pairwise prefs flip ~35% on distractor features; absolute scores ~9% (arXiv 2504.14716) | best-of-N ranked by absolute 0–100 rubric, never pairwise | `src/judge/` ABSOLUTE_RUBRIC |
| Position bias survives most panels | order-swapped comparisons when unavoidable | `src/judge/orderSwapped` |
| Verbosity bias — length ≠ quality | observable length-vs-spec penalty | `src/judge/verbosityAdjust` |
| Judge confidence uncalibrated (ECE ~0.10 → 0.01 w/ calibration) | per-model rolling accuracy → calibrated confidence before payout | `src/judge/calibratedConfidence`, `recordJudgeOutcome` |
| Rep/identity cues bias judges | blind presentation strips claimant identity | `adjudicator.ts blindInput` |
| Slop economics: free garbage floods queues (HackerOne Hai Triage lesson) | rolling last-10 FP-rate claim cost, refunded on accept — no blanket bond, reinsertion via window | `src/judge/claimCost`, `recordOutcome` |
| Dedupe before judges consume attention (Hai Triage) | content-hash + n-gram jaccard pre-check per market | `src/judge/dedupe` |
| Payers can hold work hostage | timeout auto-release (design: contract) | escrow contract |
| Style/format bias is the dominant judge bias (0.76–0.92 across 4 families; position ≤0.04) (arXiv 2604.23178) | format-normalize presentation alongside `blindInput` — strip prose-style features, not just identity | `src/judge/` (planned) |
| Capability-dependent leniency: stronger examinees get more lenient verdicts (r≥0.83); label-free FP/FN-weighted voting tracks oracle within 0.5pp (arXiv 2609.12002) | weight panel votes by online error rates, not just `jcal:` rolling accuracy | `src/judge/` (planned) |
| Exact-match overstates judge reliability; headline = Cohen's κ; test–retest >0.95 can coexist with position bias >0.10 (arXiv 2606.19544 MVVP) | adjudicator-change gate: report κ + AB/BA position-swap + ≥3 replications | dev-time protocol |
| Round-robin judge assignment cancels additive judge offsets at single-judge cost (CyclicJudge, EMNLP 2026) | rotate judges across markets when panel budget is fixed | `src/judge/` (planned) |
| Multicalibration bounds all bias groups incl. unknown (CaLLM, arXiv 2610.18108); self-preference bias quantified across 20 LLMs (arXiv 2604.22891) | post-hoc calibration candidate; no same-family majority on panels | `src/judge/` (planned) |

Domain packs implement the domain-pack-v1 contract: resolve → bind-identity →
prove-work → bind-spec (`src/domains/`).
