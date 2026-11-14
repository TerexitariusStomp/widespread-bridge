// Domain-pack contract (vendored from widespread-protocol spec/domain-pack-v1).
// The protocol is domain-blind; a pack answers 4 checks: resolve →
// bind-identity → prove-work → bind-spec. Returns failures + evidence.
export interface MarketRef {
  id: string;
  spec?: string;
  specHash?: string;
  domain?: string;
  verification?: { class: string; params?: Record<string, unknown> };
  amount?: string;
  currency?: string;
  created_at?: number;
  /** MORE capacity objective — declared, optional (Stage A). */
  capacity?: import("../types").CapacityTag;
}

export interface ClaimRef {
  ref: string;                          // canonical artifact locator
  actor?: string;                       // claimed platform identity (handle)
  evidence?: Record<string, unknown>;
  commits?: string[];
  [k: string]: unknown;
}

export interface ValidateResult {
  failures: string[];
  evidence: Record<string, unknown>;
}

export type ValidateFn = (
  input: { market: MarketRef; claim: ClaimRef },
  ctx: { env: Record<string, string | undefined>; fetch: typeof fetch },
) => Promise<ValidateResult>;

export interface DomainPack {
  name: string;
  evidence_class: string;
  display: string;
  validate: ValidateFn;
}
