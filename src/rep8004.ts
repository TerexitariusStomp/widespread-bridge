// rep8004.ts — emit ERC-8004 Reputation-Registry-shaped feedback records
// from settled reviews. The schema is the EIP's (CC0): value int128,
// tag1/tag2 dimensions, feedbackURI + feedbackHash for the off-chain
// payload. Our verdict receipts map onto it directly — claim feedbackURI
// is the review record; feedbackHash is the claim's op-log hash.
import type { ReviewRecord } from "./types";

export interface Rep8004 {
  schema: "erc-8004-feedback/1";
  value: number;          // signed fixed-point
  valueDecimals: number;
  tag1: string;           // dimension, e.g. "starred"
  tag2: string;           // vertical / domain tag
  endpoint: string;       // where the work was judged
  feedbackURI: string;    // off-chain detail (the review record)
  feedbackHash: string;   // integrity anchor for the payload
  /** Grounded = feedback binds to a settled job with recomputed evidence —
   *  the arXiv-2606.26028 defense against the measured 73-90% Sybil noise
   *  in ungrounded ERC-8004 registries. */
  grounded: boolean;
  /** Workforce surface that produced the deliverable, when it came in
   *  through a dispatched channel (wurk, agentledger, olas, ...). */
  origin_platform?: string;
}

export function rep8004For(r: ReviewRecord, originPlatform?: string): Rep8004 {
  const accepted = r.status === "accepted_paid" || r.status === "accepted_unpaid";
  const stars = accepted ? 5 : r.status === "rejected" ? 1 : 3;
  // MORE Stage A: a capacity-tagged market emits dimensional reputation —
  // tag1 = declared capacity dim, tag2 = domain (or second dim). Untagged
  // markets keep the legacy "starred" dimension byte-for-byte.
  const dims = r.bounty?.capacity?.dims ?? [];
  const tagged = dims.length > 0;
  const tag1 = tagged ? dims[0] : "starred";
  const tag2 = tagged
    ? (dims[1] ?? r.bounty?.domain ?? "capacity")
    : (r.commits?.length ? "code" : "general");
  return {
    schema: "erc-8004-feedback/1",
    value: stars,
    valueDecimals: 0,
    tag1,
    tag2,
    endpoint: `repo:${r.repo}`,
    feedbackURI: `${r.repo}/claims/${r.seq}`,
    feedbackHash: r.claim?.hash ?? "",
    grounded: Boolean(r.claim?.hash),
    ...(originPlatform ? { origin_platform: originPlatform } : {}),
  };
}
