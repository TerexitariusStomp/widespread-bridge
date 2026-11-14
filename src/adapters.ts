// adapters.ts — the `widespread-adapter/1` manifest: a signed, portable,
// evidence-carrying description of how to act on an external surface
// (social network, marketplace, forum, internal tool, desktop app).
//
// Design constraints (see plan):
//  - Declarative HTTP ops only — a manifest can never carry executable
//    code, so the shared catalog can't be weaponized.
//  - `verified` requires side-effect-asserting probe evidence (the post
//    exists, the reply is visible, an id was returned) — never a bare
//    HTTP 200. Malva: 86.6% of tool-mediated failures are silent.
//  - Auth is referenced, never stored: `auth.storage` names a client-side
//    profile or env var; secrets never enter the manifest or registry.
//  - `author` is a did:key that signs `widespread-adapter:<id>` — same
//    Ed25519 scheme as offers/receipts, verifiable with no resolver.
//  - `supersedes` chains preserve provenance when surfaces change.

import { verifyDidKey, decodeSig, didKeyPublicKey } from "./coordinator/didkey";
import { canonicalJson } from "./artifacts";

export const ADAPTER_SCHEMA = "widespread-adapter/1";

export type AdapterKind =
  | "social" | "forum" | "marketplace" | "api" | "app" | "desktop" | "mobile";
export type AdapterStatus = "draft" | "verified" | "deprecated";
export type OpClass = "read" | "write";
export type OpRisk = "low" | "medium" | "high";
export type AuthType =
  | "session-cookie" | "oauth" | "api-key" | "none" | "oauth21-cimd";
export type AuthRefresh = "manual" | "auto";
/** Which delegation standard the adapter's authority model maps to.
 *  `widespread-bind` is our pre-standard equivalent of ID-JAG-style
 *  agent→user assertion; `id-jag` where the surface supports it. */
export type AuthDelegation = "id-jag" | "widespread-bind" | "none";
export type VerifyAssert =
  | "post-exists" | "reply-visible" | "id-returned"
  | "state-changed" | "list-contains";

export interface AdapterOp {
  name: string;
  class: OpClass;
  /** http(s) URL or site-relative path — the only things an op may hit. */
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  params?: Record<string, unknown>;
  returns?: Record<string, unknown>;
  verified: boolean;
  verify?: { assert: VerifyAssert; evidence?: string };
  risk: OpRisk;
}

export interface AdapterManifest {
  schema: typeof ADAPTER_SCHEMA;
  /** sha256 of canonicalJson(manifest minus id/sig). */
  id: string;
  surface: string;
  kind: AdapterKind;
  /** did:key that signed this manifest. */
  author: string;
  /** Informational: which agent/tool produced it (may differ from author). */
  generated_by?: string;
  generated_with?: {
    rea_session?: string;
    tools?: string[];
    captured_at?: number;
  };
  supersedes?: string;
  auth: {
    type: AuthType;
    storage?: string;
    refresh?: AuthRefresh;
    delegation?: AuthDelegation;
  };
  ops: AdapterOp[];
  grammar?: {
    declaration?: string;
    claim?: string;
    receipt?: string;
    placement?: string;
  };
  status: AdapterStatus;
  issued_at: number;
  sig: string;
}

/** Registry-side wrapper: the signed manifest plus mutable, unsigned
 *  lifecycle metadata. `status` inside the manifest is immutable; the
 *  registry's effective status can degrade to "deprecated" via reported
 *  verify failures or an explicit deprecation — the manifest itself is
 *  never rewritten (that would break the signature). */
export interface AdapterRecord {
  manifest: AdapterManifest;
  meta: {
    status: AdapterStatus | null;      // null → use manifest.status
    superseded_by: string | null;
    imports: number;
    invocations: number;
    verify_ok: number;
    verify_fail: number;
    last_report_at: number | null;
    bounty_posted: boolean;
  };
}

export function effectiveStatus(rec: AdapterRecord): AdapterStatus {
  return rec.meta.status ?? rec.manifest.status;
}

const KINDS: AdapterKind[] = ["social", "forum", "marketplace", "api", "app", "desktop", "mobile"];
const STATUSES: AdapterStatus[] = ["draft", "verified", "deprecated"];
const ASSERTS: VerifyAssert[] = ["post-exists", "reply-visible", "id-returned", "state-changed", "list-contains"];
const AUTH_TYPES: AuthType[] = ["session-cookie", "oauth", "api-key", "none", "oauth21-cimd"];
const OP_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SURFACE_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const MAX_OPS = 64;
const MAX_STR = 4096;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = MAX_STR): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** Fields excluded from the id hash — the id covers everything else. */
const ID_EXCLUDE = new Set(["id", "sig"]);

export function adapterIdBody(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (!ID_EXCLUDE.has(k)) out[k] = v;
  return out;
}

export async function adapterId(m: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(canonicalJson(adapterIdBody(m))));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signing message — same domain-separated pattern as offers/receipts. */
export function adapterSignMessage(id: string): string {
  return `widespread-adapter:${id}`;
}

function validEndpoint(ep: unknown): ep is string {
  if (!str(ep, 2048)) return false;
  if (ep.startsWith("/")) return !ep.startsWith("//"); // site-relative only
  try {
    const u = new URL(ep);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function validateOp(op: unknown, idx: number): string | null {
  if (!isObj(op)) return `ops[${idx}] must be an object`;
  if (!str(op.name, 64) || !OP_NAME_RE.test(op.name)) return `ops[${idx}].name invalid`;
  if (op.class !== "read" && op.class !== "write") return `ops[${idx}].class must be read|write`;
  if (!validEndpoint(op.endpoint)) return `ops[${idx}].endpoint must be http(s) URL or site-relative path`;
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(String(op.method))) {
    return `ops[${idx}].method invalid`;
  }
  if (typeof op.verified !== "boolean") return `ops[${idx}].verified must be boolean`;
  if (!["low", "medium", "high"].includes(String(op.risk))) return `ops[${idx}].risk invalid`;
  if (op.verified) {
    // Honesty gate: a verified op MUST carry a side-effect assertion.
    // HTTP-200 is not verification (Malva: silent wrongness is the norm).
    const v = op.verify;
    if (!isObj(v) || !ASSERTS.includes(v.assert as VerifyAssert)) {
      return `ops[${idx}] verified:true requires verify.assert ∈ ${ASSERTS.join("|")}`;
    }
  }
  return null;
}

/** Structural validation — returns the manifest typed, or an error string.
 *  Does NOT check the signature; see verifyAdapterManifest. */
export async function validateAdapterManifest(v: unknown): Promise<
  { ok: true; manifest: AdapterManifest } | { ok: false; error: string }
> {
  if (!isObj(v)) return { ok: false, error: "manifest must be an object" };
  if (v.schema !== ADAPTER_SCHEMA) return { ok: false, error: `schema must be ${ADAPTER_SCHEMA}` };
  if (!str(v.surface, 256) || !SURFACE_RE.test(v.surface)) return { ok: false, error: "surface must be a hostname" };
  if (!KINDS.includes(v.kind as AdapterKind)) return { ok: false, error: `kind must be one of ${KINDS.join("|")}` };
  if (!STATUSES.includes(v.status as AdapterStatus)) return { ok: false, error: "status must be draft|verified|deprecated" };
  if (typeof v.author !== "string" || !didKeyPublicKey(v.author)) {
    return { ok: false, error: "author must be a did:key (ed25519)" };
  }
  if (typeof v.issued_at !== "number" || !Number.isFinite(v.issued_at)) {
    return { ok: false, error: "issued_at must be a unix-ms number" };
  }
  if (!Array.isArray(v.ops) || v.ops.length === 0 || v.ops.length > MAX_OPS) {
    return { ok: false, error: `ops must be a non-empty array (≤${MAX_OPS})` };
  }
  const names = new Set<string>();
  for (let i = 0; i < v.ops.length; i++) {
    const err = validateOp(v.ops[i], i);
    if (err) return { ok: false, error: err };
    const n = (v.ops[i] as AdapterOp).name;
    if (names.has(n)) return { ok: false, error: `duplicate op name ${n}` };
    names.add(n);
  }
  if (!isObj(v.auth)) return { ok: false, error: "auth object required" };
  if (!AUTH_TYPES.includes(v.auth.type as AuthType)) {
    return { ok: false, error: `auth.type must be one of ${AUTH_TYPES.join("|")}` };
  }
  if (v.auth.refresh !== undefined && v.auth.refresh !== "manual" && v.auth.refresh !== "auto") {
    return { ok: false, error: "auth.refresh must be manual|auto" };
  }
  if (v.auth.delegation !== undefined && !["id-jag", "widespread-bind", "none"].includes(String(v.auth.delegation))) {
    return { ok: false, error: "auth.delegation must be id-jag|widespread-bind|none" };
  }
  if (v.grammar !== undefined && !isObj(v.grammar)) return { ok: false, error: "grammar must be an object" };
  if (v.supersedes !== undefined && (typeof v.supersedes !== "string" || v.supersedes.length > 128)) {
    return { ok: false, error: "supersedes must be an adapter id string" };
  }
  const computed = await adapterId(v as Record<string, unknown>);
  if (v.id !== computed) return { ok: false, error: "id mismatch — sha256 of canonical body required" };
  return { ok: true, manifest: v as unknown as AdapterManifest };
}

/** Full verification: structure + id integrity + Ed25519 signature by
 *  `author` over `widespread-adapter:<id>`. */
export async function verifyAdapterManifest(v: unknown): Promise<
  { ok: true; manifest: AdapterManifest } | { ok: false; error: string }
> {
  const res = await validateAdapterManifest(v);
  if (!res.ok) return res;
  const m = res.manifest;
  const sig = decodeSig(m.sig);
  if (!sig) return { ok: false, error: "sig must be 64-byte ed25519 (hex or base64)" };
  const ok = await verifyDidKey(m.author, adapterSignMessage(m.id), sig);
  if (!ok) return { ok: false, error: "signature verification failed" };
  return { ok: true, manifest: m };
}

/** Verified-op count — the registry's primary quality ranking signal. */
export function verifiedOpCount(m: AdapterManifest): number {
  return m.ops.filter((o) => o.verified).length;
}
