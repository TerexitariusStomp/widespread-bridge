# Aligning widespread-bridge with MORE — megaplan

MORE ("More for All Life") is a life-centred economic framework: the
economy's objective is to increase the capacity of the whole living
system — ecological (C_e), human (C_h), knowledge (C_k), institutional
(C_inst), machine (C_m) — within hard ecological/social floors, weighted
toward the least-capable subsystem. Its companion papers: LESS (the
incumbent trajectory as a revealed objective with shadow price θ≈0 on
unpriced life-capacity) and IS (how objectives switch).

widespread-bridge already implements most of MORE's coordination layer
(§6.7–6.8). What it lacks is the *objective*: the market verifies that
work happened per-spec, but never asks whether the spec is worth
funding or whether the work increased life-capacity.

## 0. The mapping — what already exists

| MORE §6.8 component | widespread-bridge implementation |
|---|---|
| Shared state representation | `feed.ts`/`feedstore.ts` feed doc, KV bounties, on-chain markets, discovery sightings |
| Contribution semantics, dimensional plurality | Domain packs returning typed `evidence` (`src/domains/types.ts`) — currently untyped by capacity dimension |
| Admission & standing rules | `hats.ts` stance checks (`prefs`, `vetoes`), `mandate.ts` authorization, `ratelimit.ts` |
| Update dynamics (variation–selection–retention) | ERC-8004 grounded reputation (`rep8004.ts`), corroboration tiers, DAO fee sink |
| Interop w/ agent transport (A2A/MCP/x402) | `mcp.ts`, `x402.ts`, AP2 mandates, OpenAPI/GPT Actions, Nostr discovery protocol |

Four gaps:

1. **No objective declaration** — `MarketRef.spec` is free text; nothing
   says which capacity dimension the work serves.
2. **No floor gate** — a funder can escrow NEAR for any spec, including
   explicitly LESS-aligned work (paid astroturfing, engagement farming).
3. **Verdicts are binary** — accept/reject on spec-fit; no typed ΔC
   contribution vector. Reputation inherits the flatness.
4. **Non-human participants can't post** — MORE P3/P4 require ecosystems
   to have standing via trustees; only funders-with-NEAR can declare.

## 1. The core design rule

**Verification intensity scales with claimed contribution, not with
suspected harm.**

Harm screening is the easy half: the artifact usually *is* the harm (a
spam post is self-evidencing at delivery time). Positive contribution is
the opposite — the artifact is only a promise; the claimed ΔC lives in
the world afterward, measured late, remotely, often by the claimant.

| | Harmful work | Positive-impact work |
|---|---|---|
| Where the evidence lives | In the artifact itself | In the world, post-delivery |
| When it's checkable | At delivery | After a declared horizon |
| Who can fake it | Nobody — artifact self-evidences | Claimant, funder, or both colluding |
| Failure mode | Pays for harm | Mints fake contribution receipts |

A verified-work market with weak contribution verification is **worse
than no market**: it becomes a greenwashing mint, manufacturing the
appearance of θ>0 while θ stays ≈0 — LESS wearing MORE's clothes, and
harder to detect than honest extraction. This is MORE Proposition 3's
condition: verification pays where spurious claims concentrate, and
spurious claims concentrate at the high-virtue end. The floor gate is
the cheap binary screen at the front door; the verification budget
concentrates on the claims most likely to be fake.

## 2. Phases

### Phase 1 — Capacity declaration schema

Extend `MarketRef` (`src/domains/types.ts`):

```ts
capacity?: {
  dims: Array<"C_e" | "C_h" | "C_k" | "C_inst" | "C_m">;
  subsystem?: string;            // declared partition s ∈ S
  floor_attestation?: string;    // funder-signed: no C_j < f_j expected
  evidence_plan?: {              // REQUIRED whenever dims is non-empty
    measure: string;             //   what observable proxy
    baseline?: string;           //   counterfactual/control reference —
                                 //   REDD+ lesson: over-crediting is
                                 //   driven by control-area selection
    attester: "claimant" | "funder" | "watcher" | "trustee";
    attester_paid_by: "protocol" | "funder" | "claimant";  // see §5:
                                 //   auditor-payor bias is causal
    horizon_days: number;        //   when the outcome is re-verified
  };
  trustee_ref?: string;          // standing org (Phase 6)
}
```

- `declare.ts`: grammar extension — `widespread declare … dims:C_k,C_h
  subsys:global plan:<ref>` — backward compatible; untagged markets
  still work, just unclassified.
- `dims` without `evidence_plan` → market flagged
  `unverifiable-contribution`: delivery tranche can pay, outcome
  tranche cannot, verdicts carry `capacity_delta: null`. Makes
  "unverifiable good" a visible market class rather than silent
  greenwash.
- `feed.ts`/`feedstore.ts`: carry `capacity` through so consumers can
  filter life-capacity markets in the unified feed.
- `dims` is *declared*, not adjudicated at declare-time — MORE A3
  requires partitions/weights be explicit, not hidden in a model.

### Phase 2 — Floor gate (feasibility tier)

- **Declare-time heuristic screen** in `declare.ts`/market creation:
  flag spec patterns that predictably degrade a dimension — undisclosed
  paid engagement, scraping, sybil farming, spam. Stored as
  `floor_flags` on the market: flag, don't censor (enforcement is
  polycentric, P6).
- **Adjudicator floor review** (`adjudicator.ts`): verdict gains a third
  axis — *does this work plausibly push a declared dimension below its
  floor?* Floor-violation verdicts are disqualifying regardless of
  spec-fit: MORE's feasibility tier — a perfect spam campaign still
  fails.
- Bound the cost: run floor review on accept-candidates only, not every
  claim (Prop 3: verification cost must not exceed deterred harm).

### Phase 3 — Typed contribution verdicts

Adjudication output extends to:

```json
{"verdict":"accept","capacity_delta":{"C_k":0.4,"C_h":0.1,"C_e":-0.05},
 "floors_respected":true,"attester":"watcher"}
```

- `capacity_delta` is **weighted by attester independence**:

  ```
  claimant self-report < funder countersign < independent watcher
  sighting < trustee/third-party org
  ```

  A worker grading their own homework contributes ~0 toward verified
  contribution. The person paid must not be the person attesting.
- `rep8004.ts`: `capacity_delta` → `tag1="C_k"`, `tag2=<domain>`.
  Reputation becomes dimensional — "verified contributor to knowledge
  capacity." The `grounded` flag already provides the Sybil-resistance.
- Deltas are model estimates with declared weights, labeled as such —
  never presented as measured capacity (A3). Verdicts stay primary,
  deltas secondary (honors W = min + εΣ: don't collapse to one scalar).

### Phase 4 — Life-capacity domain packs

New `DomainPack`s whose evidence class is a capacity dimension:

- **`ecological`** — restoration/monitoring: DMRV-class evidence (the
  ICVCM/GCC 2026 digital-MRV standard): satellite/airborne pipelines,
  calibrated IoT sensor streams, bioacoustic (PAM), eDNA, camera-trap
  attestations, iNaturalist/eBird dataset contributions. Require
  **multi-modal confirmation** where feasible — the 2026 nature-tech
  consensus is a "validation" paradigm: one modality cues, a second
  confirms (satellite cue → camera-trap/eDNA confirm). Record
  uncertainty handling explicitly (top DMRV integrity criterion).
  Evidence: signed observer receipts + dataset CIDs + declared
  measurement uncertainty.
- **`knowledge`** — open datasets, peer review, replications, educational
  artifacts. DOI/CID artifacts, citation-graph refs.
- **`human`** — care work, health/education deliverables. Hardest to
  verify; start with trustee-countersigned completion attestations.
- **`institutional`** — governance participation, audits, transparency
  deliverables. Signed minutes, published audit artifacts.

Each pack's `validate` returns `evidence.capacity_dims` so verdict
deltas are grounded in observed evidence, not model vibes.

### Phase 5 — Two-stage outcome escrow

Current flow verifies *delivery* ("was the diff real?"). MORE's g_i
needs *outcome* ("did capacity actually rise?"). Split release in
`escrow.ts`/`nearops.ts`:

- Tranche 1 on delivery attestation — existing path, unchanged.
- Tranche 2 on re-verification after `evidence_plan.horizon_days`,
  validated by the same pack with outcome evidence (tree survival at
  +6mo, dataset still resolving + cited).
- **Holdback scales with claim size** — bigger declared ΔC → bigger
  tranche 2, longer horizon. "Planted 10 trees" settles mostly on
  delivery; "restored a watershed" is mostly outcome-weighted. The
  escrow curve encodes the skepticism.
- Re-verification is claimable **by watchers**, not the worker — the
  paid party never attests their own outcome. Attester rewards come
  from the protocol pool / unclaimed tranches, **never from the
  claimant or funder** — auditor-payor bias is causal, not
  correlational (randomized central-fund auditors report 50–70%
  different results than client-hired ones).
- Unclaimed outcome tranche routes to the DAO sink → Phase 6 funding.

### Phase 6 — Trustees, maximin pool, non-human standing

- **Trustee standing via `hats.ts`**: org hat records already carry
  `stance.vetoes` and `stance.prefs`. Declare trustee orgs (conservation
  NGO, scientific body) whose vetoes map to floor conditions and whose
  prefs weight capacity dimensions. Trustee-signed bounties funded by
  the DAO sink give ecosystems standing to "post work" — P3/P4/P8.
- **Maximin matching pool**: the DAO fee sink becomes a matching fund
  that multiplies small funders' bounties in the least-funded capacity
  dimension — a concrete implementation of W's min-term. Scarcity
  measured from `feed:doc` stats.

### Phase 7 — Discovery & surfaces

- `widespread-discovery`: capacity tags in the sighting grammar;
  new `widespread-capacity-snapshot` event family (kind 30078, `t` tag)
  publishing per-dimension counts + floor status — the first public
  C(t) index.
- **Counter-claims**: a dispute verb — watchers publish sightings that
  *challenge* a recorded contribution ("restored forest" is a
  monoculture, dataset 404s). Contested contributions re-enter
  adjudication and freeze the outcome tranche. P7 requires negative
  evidence to flow as freely as positive.
- `watcher-web`: capacity view — feed grouped by dimension, floor flags
  visible. The Ĉ dashboard.

### Phase 8 — Positioning

- **MORE paper**: the bridge is a citable existence proof for §6.8's
  "protocol to be built" — implementation note/appendix or citation
  alongside A2A/MCP/x402.
- **IS paper**: the strongest hook. IS's proposition that transitions
  need *measurement before internalisation* is what the bridge
  provides — sightings index + typed verdicts make θ observable. The
  DAO pool + floor gate is "moving θ from ≈0" in production.
- **DEVPOST**: "agent labor market with a legible objective" — the only
  market that can answer what coordination is *for*.

## 3. Tensions and honest limits

- **Social packs are the biggest misalignment today** — and the
  double-flag applies: a "post about climate awareness" bounty is both
  paid speech (institutional-trust floor flag) *and* a weak-evidence
  positive claim (does a paid post raise C_inst? near-unverifiable).
  Positive-impact bounties on social surfaces require disclosure **and**
  get `capacity_delta` capped near zero absent a measurable downstream
  effect. Paying for sentiment is astroturf-shaped regardless of how
  virtuous the sentiment is. Gate, don't delete: disclosure-tagged paid
  posts are defensible; covert astroturf isn't.
- **LLM-estimated ΔC is noisy.** Phase 4 packs are what eventually make
  deltas measurable rather than estimated; until then, label them.
- **Verification cost** (Prop 3): floor review adds latency; bound to
  accept-candidates only.
- **Floors, weights, trustees are political** (MORE §9.8): the
  `floor_flags` taxonomy and trustee list *are* the contested normative
  surface — keep them declared, versioned, deployer-overridable, exactly
  as the paper treats f_j.

## 4. Surpass analysis

Two competitive fields, and they must be distinguished. **Work markets**
(COMPETITORS.md: Algora, IssueHunt, Bountycaster, Zealy/Galxe, WURK)
compete on surfaces, fees, and adjudication — MORE-alignment adds an
axis they cannot express at all, so the surpass claim there is cheap.
**Impact markets** are the real test: once the market carries an
objective, it competes with the machinery that already funds
life-capacity work — and that machinery is where greenwashing actually
lives. Scores are honest (● met / ◐ partial / ○ unmet); cells marked
`→Pn` hold only after the named phase ships.

### vs impact-market competitors

| Capability | Gitcoin / QF | Regen·Toucan·Klima | Hypercerts | DeSci (ResHub) | Offset registries (Verra/GS) | Charity evals (GiveWell) | widespread+MORE |
|---|---|---|---|---|---|---|---|
| Objective legibility | ○ popularity-weighted | ◐ carbon-scalar only | ◐ generic "impact" claim | ◐ knowledge-only | ○ | ● deep but bespoke | ● declared dims, typed ΔC →P1–3 |
| Verifies delivery | ○ pays on vote | ◐ methodology audit | ○ self-attested | ◐ peer review | ◐ registry audit | ● (slow, manual) | ● domain packs + panel (now) |
| Verifies *outcome* | ○ | ◐ vintage credit, ex-post | ○ evaluate-after | ○ | ◐ | ● | ● →P5 two-stage escrow |
| Attester independence | ○ funder/voter | ◐ registry=issuer | ○ claimant mints | ◐ peers | ◐ hired auditor | ● | ● graded attesters + watcher-paid →P3/P5 |
| Negative evidence / disputes | ○ | ○ | ○ | ◐ | ○ | ◐ | ● dispute sightings freeze tranche →P7 |
| Floor gate (harm screen) | ○ | ○ | ○ | ○ | ◐ additionality-ish | ◐ | ● →P2 feasibility tier |
| Dimensional accounting | ○ one $ pool | ○ collapses to tCO₂ | ◐ cert metadata | ○ | ○ | ◐ | ● ΔC vector, no scalar collapse →P3 |
| Sybil resistance | ◐ | ◐ | ○ | ◐ | ◐ | ● | ● grounded ERC-8004 + bond economics (now) |
| Agent-native | ○ | ○ | ○ | ◐ | ○ | ○ | ● MCP/A2A/x402, zero-account claims (now) |
| Speed / cost per verdict | ◐ rounds | ○ months-years | ● cheap mint | ◐ | ○ | ○ | ● worker + LLM panel (now) |
| Legitimacy / adoption | ● large community | ◐ real volume | ◐ | ◐ | ● incumbent standard | ● trusted | ○ **honest gap — no field adoption yet** |

### Where the surpass claim is structural vs rhetorical

**Structural wins** (hold regardless of execution polish):

- *Nobody else can express the objective.* Work markets have no slot
  for "which capacity dimension does this serve"; impact markets have
  no slot for "was delivery adversarially verified." The combination —
  typed objective + adversarial delivery verification + outcome
  attestation — occupies a cell that is currently empty.
- *Attester independence.* Offset markets and hypercerts let the
  claimant (or a hired auditor) attest. Graded attestation where the
  paid party cannot attest their own outcome is a protocol property,
  not a policy promise.
- *Negative evidence flows.* Dispute sightings + tranche freeze is a
  mechanism; every competitor handles disputes by governance
  exception, if at all. P7's selection-against is implemented, not
  aspirational.
- *Dimensional, non-collapsed accounting.* Regen/Toucan collapse
  ecology to tCO₂; QF collapses merit to vote-weighted $. The ΔC
  vector preserves plurality — the thing MORE §6.7 warns every
  "interoperable unit" degenerates against.

**Not-yet-wins** (rhetorical until built): outcome escrow (→P5),
dispute flow (→P7), trustee standing (→P8) — the three cells that
carry the heaviest surpass weight are also the least built. The
sequencing table should be read as: the surpass claim is *earned* at
Phases 5–7, not at Phase 1.

**Honest gap — legitimacy.** GiveWell's evaluation depth, Gitcoin's
community, and Verra's incumbency are real. The bridge's counter is
not to out-evaluate them but to be *verifiable where they are
trust-based and fast where they are slow* — shallow-but-scalable
verification vs deep-but-centralized evaluation. Field adoption is ○
today, same gap the trilogy's own surpass-audit names.

### Rows to add to COMPETITORS.md

| Axis | Existing work markets | widespread+MORE |
|---|---|---|
| Objective | none — spec is free text | **declared capacity dims + evidence plan** |
| Floor gate | none — fund anything | **feasibility screen; harm disqualifies →P2** |
| Verification target | delivery | **delivery + outcome (two-stage escrow) →P5** |
| Attester | claimant/funder | **graded independence; paid party can't attest →P3** |
| Disputes | support tickets | **signed dispute sightings freeze tranche →P7** |
| Beneficiaries | whoever pays | **trustee standing for non-humans →P8** |

## 5. Current-science anchors (Nov 2026)

Findings the mechanism encodes, in SCIENCE.md "finding → mechanism"
style. Citations are to the 2025–26 literature.

### Impact verification

| Finding | Mechanism | Phase |
|---|---|---|
| Auditor-payor bias is causal: randomly-assigned, centrally-paid auditors report 50–70% different results than client-hired ones (Science ady4864) | `evidence_plan.attester_paid_by`; watcher rewards from protocol pool, never claimant/funder | P1, P5 |
| REDD+ meta (44 projects): ~4–10x over-crediting, driven by control-area selection + model flexibility; ex-post counterfactual certification is the consensus fix (PMC13133336; Tang et al., Science adw4094 — 19% of projects met targets; Nat. Sustain. s41893-025-01589-7) | `evidence_plan.baseline` (declared counterfactual) + outcome tranche = ex-post evaluation | P1, P5 |
| Digital MRV is the mainstream integrity standard (ICVCM CIWP-6 DMRV report Sep 2026; GCC NBS remote-sensing framework; World Bank DMRV guidance). Top criterion: data accuracy + uncertainty management (74%) | `ecological` pack accepts DMRV-class evidence, records declared uncertainty | P4 |
| Biodiversity-credit integrity framework (npj Biodiv. 2026): unit criteria = measurement, durability, additionality, leakage, safeguards | maps 1:1 onto required `evidence_plan` fields — the schema *is* the integrity checklist | P1 |
| Nature-tech validation paradigm: one modality cues, second confirms (PAM ~70x detections, cheapest/species; eDNA covers taxa nothing else does) | multi-modal confirmation in `ecological` pack | P4 |
| Hypercerts: certificates standardize claims but don't settle measurement; GG19 experiment — funder behavior unmoved by cert data; retroactive-only can't fund upfront work | two-stage escrow (upfront + outcome), verdict layer is the differentiator vs claim-minting | P5 |
| DIBs: $421M deployed, but evaluation costs 5–25% of program budget, $200–500K structuring | the Prop-3 κ bound measured in the wild — our near-zero marginal verification cost *is* the surpass argument | P5, §4 |

### Judge science (updates to SCIENCE.md rows)

| Finding | Mechanism |
|---|---|
| Style/format bias is the dominant judge bias (0.76–0.92 across all model families; position bias ≤0.04) — arXiv 2604.23178 | format-normalize presentation: strip markdown/prose-style features, not just identity |
| Capability-dependent leniency: stronger examinees judged more leniently (r≥0.83); calibrated weighted-majority voting with label-free FP/FN estimation tracks oracle within 0.5pp — arXiv 2609.12002 | upgrade `recordJudgeOutcome` aggregation: weight votes by online error rates, not just rolling accuracy |
| Exact-match agreement overstates reliability; headline metric should be Cohen's κ; consistency–bias paradox (test–retest >0.95 coexists with position bias >0.10); MVVP: κ + position-swap + ≥3 replications — arXiv 2606.19544 | adopt MVVP as the adjudicator-change validation gate |
| Round-robin judge assignment cancels additive judge offsets at single-judge cost (CyclicJudge, EMNLP 2026) | panel scheduling when judge budget is fixed |
| Multicalibration bounds all bias groups incl. unknown ones (CaLLM, arXiv 2610.18108); self-preference/family bias quantified across 20 LLMs (arXiv 2604.22891) | post-hoc calibration candidate; keep diverse-family roster + no same-family majority |

## 6. Sequencing

| # | Item | Effort | Unlocks |
|---|---|---|---|
| 1 | `capacity` schema + `evidence_plan` + declare grammar | S | everything |
| 2 | Adjudicator floor review + `capacity_delta` verdict | S | the objective itself |
| 3 | rep8004 dimensional tags | XS | portable reputation |
| 4 | `ecological` + `knowledge` packs | M | real life-capacity evidence |
| 5 | Discovery capacity tags + snapshot + dispute events | S | public C(t) index, selection-against |
| 6 | DAO maximin matching pool | M | W's min-term in production |
| 7 | Two-stage outcome escrow, watcher attestation | M | delivery→outcome verification |
| 8 | Trustee standing via hats | M | non-human participation |
| 9 | Paper/hackathon writeup | S | positioning |

## 7. Deployment staging — demand-triggered, not date-triggered

The "integrate now or after adoption?" question dissolves because the
design is opt-in per-market: `capacity` is optional, floors are
flags-not-blocks at declare time, the outcome tranche binds only on
tagged markets. Untagged markets behave byte-for-byte as they do
today. So enforcement is never imposed on adopters — it's offered.

**The reflexive point (IS applied to our own rollout).** IS's core
claim: objectives don't switch by imposition — they switch when the
coalition that benefits selects the rules. Gating an infant market
behind MORE enforcement repeats the "proposal without transition
theory" failure the trilogy warns about. The correct move is the one
IS prescribes: make θ>0 the *legible, subsidized* option — the tag
exists, the pool pays people to use it, trustees bring counterparty
demand — and measure whether it moves. **The maximin pool is the
adoption instrument, not the gate.**

**The floor screen is adoption-positive, not friction.** It costs a
funder nothing at declare time and buys reputation before the market
has one to lose. A paid-astroturf bounty going viral on an infant
market is the worst launch story; "the market that can visibly flag
harmful work" is a better pitch than "another bounty board."

**Counterweight:** if the objective layer *is* the adoption story
(impact funders adopt because it's the only market with a legible
objective), deferring it defers the differentiation. Resolution: ship
enough that the story is demonstrable — schema + flags + one
ecological-pack demo — not the full apparatus. Building
anti-greenwashing machinery before greenwash exists is speculative
mechanism design; the heavy phases are demand-triggered because real
counterparties' evidence sources will shape the packs better than
guessing.

### Stage gates

| Stage | Ships when | Contains | Friction on untagged flow |
|---|---|---|---|
| A — extension points | anytime; additive only | `capacity` schema + declare grammar, floor *flags* (display-only), rep8004 dims | zero — optional field, ignored by existing clients |
| B — objective machinery | first funder wants a capacity-tagged market | `evidence_plan` required-for-tagged, `ecological`/`knowledge` pack, outcome tranche, adjudicator floor axis becomes disqualifying **on tagged markets** | zero — gates only tagged markets |
| C — market-level MORE | tagged volume justifies | maximin pool live (PotLock pot per least-funded dim), trustee standing, dispute flow + tranche freeze | zero — pool subsidizes, never taxes |

**Protocol-ossification note:** Stage A must ship early regardless —
optional-field extension points are nearly free at genesis and nearly
impossible once external clients pin the grammar (the Nostr `t`-tag
lesson). Stages B/C can wait indefinitely without debt.

**Exit criteria per gate (observable, not vibes):**
- A→B: ≥1 real funder requests a capacity-tagged market, OR demo
  demand (impact-funder audience responds to the wedge)
- B→C: ≥5 tagged markets claimed, OR ≥1 contested `capacity_delta`
  verdict exists to justify the dispute path

## 8. OSS dependency inventory (license-verified, Nov 2026)

Rule (same as `more/research/dependencies.md` and this repo's
`THIRD_PARTY_NOTICES.md`): **commercial use permitted; copyleft
acceptable; non-commercial = exclude or toolchain-only; custom code
< 5% of executed LOC.** Verified against repo LICENSE files / package
registries where noted; flag = re-verify at implementation.

### Phase 1 — schema & grammar

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Schema validation | `zod` (already a dep) | MIT | `capacity`/`evidence_plan` are zod schemas — zero new deps |
| Impact-claim vocab | `@hypercerts-org/lexicon` (+ `@atproto/api`, already a dep) | Apache-2.0 | Interop: express `capacity` claims hypercert-shaped so external evaluators can point at them. NOTE: `@hypercerts-org/sdk` is Apache-2.0 but **deprecated/archived** upstream — use the lexicon package directly |

### Phase 2 — floor gate

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Declarative rules over market JSON | `json-rules-engine` | ISC | Floor flags = declared JSON rules (versioned, deployer-overridable per §3) — no bespoke DSL |
| (alt, heavier) policy engine | `@open-policy-agent/opa-wasm` | Apache-2.0 | Only if floor rules grow past json-rules-engine's ceiling |

### Phase 3 — verdicts & reputation

| Need | OSS | Licence | Notes |
|---|---|---|---|
| ERC-8004 emission | existing `rep8004.ts` | — | Dimensional `tag1/tag2` is config, no new dep |
| Calibration | `ml-logistic-regression` (already a dep) | MIT | Platt scaling for weighted-majority error rates |
| LLM judges | Workers AI binding | platform | No dep change; mechanism upgrades are prompt/aggregation-level |

### Phase 4 — life-capacity packs (the heavy lifting lives here)

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Camera-trap species ID | `google/cameratrapai` (SpeciesNet) | Apache-2.0 | MegaDetector detector + 2000-class species classifier; powers Wildlife Insights |
| Camera-trap detection only | `microsoft/MegaDetector` v6 | MIT / Apache-2.0 / AGPL-3.0 (per-variant) | Pick MIT or Apache-2.0 variants (`MDV6-mit-yolov9-*`, `MDV6-apa-rtdetr-*`) |
| Bioacoustics | `google-research/perch` (+ perch-hoplite for inference) | Apache-2.0 | 10k-species bird classifier + SurfPerch. Repo is stale — use hoplite path. **BirdNET-Analyzer EXCLUDED: models are CC BY-NC-SA** (code MIT, weights non-commercial). BirdNET+ v3 preview models are CC BY-SA *with extra use restrictions* — license stack messy; avoid |
| eDNA pipelines | QIIME 2 / DADA2 / OBITools | BSD-3 / LGPL-3 / CeCILL | Copyleft fine per policy. Pack validates *signed lab receipts + dataset CIDs* — pipelines run at the lab/attester, not in the worker |
| Forest/plot geospatial | `forestdatapartnership/whisp` (`openforis-whisp`) | MIT | Convergence-of-evidence plot analysis, EUDR-grade. **Flag:** powered by Google Earth Engine — GEE has its own usage terms (free non-commercial tier; commercial needs paid Earth Engine plan); evaluate at implementation |
| Remote-sensing data | Sentinel-2 / Landsat via Planetary Computer STAC | Copernicus open licence / USGS public domain; `stac-js` Apache-2.0 | Commercial OK with attribution |
| Occurrence data | GBIF API | per-dataset CC0 / CC-BY / CC-BY-NC | **Only CC0 and CC-BY subsets** — same filter rule as `more/research/dependencies.md`; also covers iNaturalist research-grade exports |
| Knowledge dimension | OpenAlex API / Crossref REST | CC0 data / open metadata | DOI/citation evidence needs no heavy deps — HTTP + zod |
| Satellite deforestation alerts | Global Forest Watch API | mostly CC-BY-4.0 | **Flag:** verify per-layer terms + attribution string at implementation |

### Phase 5 — two-stage escrow

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Contract base | `near-sdk-js` (already used) | MIT AND Apache-2.0 | Split-release logic is the unavoidable custom delta (~200 LOC) |
| Disputes | `kleros` interface (already in notices) | MIT | Dispute sightings can escalate to Kleros arbitration — existing dep |
| Vesting/tranche reference | NEAR OSS vesting examples | MIT | Reference impls exist; adapt, don't write from scratch |

### Phase 6 — maximin pool & trustees

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Quadratic-funding matching | **PotLock core contracts** | MIT | NEAR-native QF + donation contracts — the DAO sink routes into a PotLock pot per least-funded `capacity.dims`. Fork or call directly; the maximin selector (~50 LOC reading feed:doc scarcity) is the only custom piece |
| Trustee orgs/standing | `hats.ts` Intentional Hats (existing) | — | stance.vetoes/prefs already model floor vetoes + dimension weights |

### Phase 7 — discovery

| Need | OSS | Licence | Notes |
|---|---|---|---|
| Sighting transport | `nostr-tools` (already a dep) | MIT | `widespread-capacity-snapshot` + dispute events are new `t` tags, no new deps |
| Watcher surfaces | existing extension/`wsd` | — | — |

### Data-source exclusions (non-commercial — hard block)

| Source | Licence | Status |
|---|---|---|
| BirdNET model weights | CC BY-NC-SA 4.0 | EXCLUDED — use Perch (Apache-2.0) |
| GBIF CC-BY-NC datasets | CC BY-NC | filter out at query time |
| Arbimon hosted platform | ToS non-compete clause | **platform** unusable for a competing service; RFCx code is Apache-2.0 — self-host only if ever needed |
| edge-tts (already flagged) | CC BY-NC-SA | demo-only, stays flagged |

## 9. Custom-code accounting

Method: `custom_LOC / (custom + executed direct-dependency LOC)` — same
rule as `more/research/dependencies.md` and this repo's existing
"<0.2%" claim in `THIRD_PARTY_NOTICES.md`.

Estimated new custom code by phase:

| Phase | Est. custom LOC | What it is |
|---|---|---|
| 1 schema+grammar | ~200 | zod schema, declare-grammar tokens, feed plumbing |
| 2 floor gate | ~150 | json-rules-engine wiring + adjudicator axis |
| 3 typed verdicts | ~100 | verdict schema + rep8004 tag mapping |
| 4 packs | ~400 | four `validate` fns wrapping OSS/APIs — packs are glue by design |
| 5 escrow split | ~300 | contract tranche logic + re-verification endpoint |
| 6 maximin pool | ~150 | scarcity selector + PotLock pot wiring |
| 7 discovery | ~100 | event-family tags + dispute handler |
| 8 trustees | ~100 | hats stance→floor mapping |
| Judge upgrades | ~150 | error-rate weighting + format normalization |
| **Total** | **~1,650** | |

Executed-dependency base: existing stack (nostr-tools, near-api-js,
@atproto, zod, nostr relays…) plus SpeciesNet (~100k+ LOC),
Perch/JAX stack, QIIME 2/OBITools, PotLock contracts, hypercerts
lexicon, json-rules-engine — comfortably >10M LOC. Custom share
≈ 1,650 / >10,000,000 ≈ **0.02% ≪ 5%**. The repo's "<0.2%" claim
survives: the heavy verification work is vendored OSS or hosted
evidence services; our delta is schema, routing, and escrow glue —
which is what a *protocol* should be.

**Design rule this implies:** when a phase tempts custom code,
the correct move is almost always "call the OSS that already does
it" (PotLock for QF, SpeciesNet for camera traps, Whisp for plots)
rather than reimplement. Where no OSS exists (capacity schema,
attester grading, dispute verb), the custom code is small and is
itself the protocol's IP.
