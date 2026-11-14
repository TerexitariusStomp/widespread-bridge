// lifecapacity.ts — MORE life-capacity domain packs (docs/more-alignment.md
// Phase 4, Stage B). Evidence class IS a capacity dimension: these packs
// validate DMRV-class / scholarly artifacts and stamp evidence.capacity_dims
// so verdict deltas are grounded in observed evidence, not model vibes.
//
// Design rule: packs validate STRUCTURE + resolvability, not ground truth —
// a signed observer receipt + dataset CID + declared uncertainty is what
// the 2026 DMRV integrity literature asks for at this layer; physical
// truth is the outcome bonus's job (two-stage escrow).
import type { DomainPack, ValidateFn } from "./types";

const CID_RE = /^(baf[a-z2-7]{50,}|Qm[1-9A-HJ-NP-Za-km-z]{44}|zd[a-z2-7]{50,})$/;
const DOI_RE = /^10\.\d{4,9}\/\S+$/;

const evDims = (dims: string[]) => ({ capacity_dims: dims });

// --- ecological: DMRV-class restoration/monitoring evidence ---------------
// Required evidence fields (claim.evidence):
//   modalities: string[]  — subset of satellite|iot|pam|edna|camera-trap|field
//   cids: string[]        — content-addressed dataset/receipt artifacts
//   uncertainty: string   — declared measurement uncertainty (top DMRV
//                           integrity criterion per ICVCM CIWP-6)
// Multi-modal confirmation (nature-tech 2026 validation paradigm): ≥2
// distinct modality families when the spec asks for it
// (verification.params.multi_modal !== false).
const ECO_MODALITIES = new Set(["satellite", "iot", "pam", "edna", "camera-trap", "field"]);

const validateEcological: ValidateFn = async ({ market, claim }) => {
  const ev: Record<string, unknown> = {};
  const f: string[] = [];
  const e = (claim.evidence ?? {}) as Record<string, unknown>;

  const modalities = Array.isArray(e.modalities)
    ? e.modalities.filter((m): m is string => typeof m === "string" && ECO_MODALITIES.has(m))
    : [];
  if (!modalities.length) {
    f.push("resolve: no DMRV modalities declared (satellite|iot|pam|edna|camera-trap|field)");
  }
  ev.modalities = modalities;

  const cids = Array.isArray(e.cids) ? e.cids.filter((c): c is string => typeof c === "string" && CID_RE.test(c)) : [];
  const dataset = typeof e.dataset === "string" ? e.dataset : null;
  if (!cids.length && !dataset) {
    f.push("resolve: no content-addressed evidence (cids[] or dataset ref)");
  }
  ev.cids = cids; ev.dataset = dataset;

  if (typeof e.uncertainty !== "string" || !e.uncertainty.trim()) {
    f.push("resolve: measurement uncertainty not declared (DMRV integrity criterion)");
  } else {
    ev.uncertainty = e.uncertainty.slice(0, 500);
  }

  const wantMulti = market.verification?.params?.multi_modal !== false;
  if (wantMulti && modalities.length === 1) {
    f.push("resolve: single-modality evidence — multi-modal confirmation required (cue + confirm)");
  }
  ev.multi_modal_confirmed = modalities.length >= 2;

  // Optional attestation artifacts
  if (typeof e.observer_receipt === "string") ev.observer_receipt = e.observer_receipt.slice(0, 200);
  if (typeof e.site === "string") ev.site = e.site.slice(0, 200);

  return { failures: f, evidence: { ...ev, ...evDims(["C_e"]) } };
};

// --- knowledge: open datasets, papers, replications -----------------------
// claim.ref is a DOI (resolved via Crossref) or an IPFS CID / dataset URL.
const validateKnowledge: ValidateFn = async ({ claim }, ctx) => {
  const ev: Record<string, unknown> = {};
  const f: string[] = [];
  const ref = claim.ref;

  const stripped = ref.replace(/^doi:\s*/i, "");
  if (DOI_RE.test(stripped)) {
    const doi = stripped;
    const r = await ctx.fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
      .catch(() => null);
    const j = (await r?.json().catch(() => null)) as
      { message?: { title?: string[]; DOI?: string; type?: string; published?: unknown } } | null;
    if (!j?.message?.DOI) {
      f.push(`resolve: DOI ${doi} not found in Crossref`);
    } else {
      ev.doi = j.message.DOI;
      ev.title = (j.message.title ?? [])[0];
      ev.work_type = j.message.type;
    }
  } else if (CID_RE.test(ref) || /ipfs:\/\//.test(ref)) {
    ev.cid = ref;
    // CID resolvability is checked at outcome verification — a CID is a
    // promise of content, not proof of it.
  } else if (/^https?:\/\//.test(ref)) {
    const r = await ctx.fetch(ref, { method: "HEAD" }).catch(() => null);
    if (!r || !r.ok) f.push(`resolve: ${ref} unreachable`);
    else ev.url = ref;
  } else {
    f.push(`resolve: not a DOI, CID, or resolvable URL: ${ref.slice(0, 80)}`);
  }

  const e = (claim.evidence ?? {}) as Record<string, unknown>;
  if (typeof e.citations === "number" && e.citations >= 0) ev.citations = e.citations;
  if (Array.isArray(e.dataset_cids)) {
    ev.dataset_cids = e.dataset_cids.filter((c): c is string => typeof c === "string");
  }
  return { failures: f, evidence: { ...ev, ...evDims(["C_k"]) } };
};

export const lifeCapacityPacks: DomainPack[] = [
  { name: "ecological", evidence_class: "capacity-dimension", display: "Ecological restoration/monitoring (DMRV)", validate: validateEcological },
  { name: "knowledge", evidence_class: "capacity-dimension", display: "Knowledge capacity (DOI/CID/dataset)", validate: validateKnowledge },
];
