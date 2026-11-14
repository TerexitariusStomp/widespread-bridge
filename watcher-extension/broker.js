// broker.js — credential broker core (shared shape across extension/wsd/plugin).
// Grants are capabilities, not credentials: {surface, ops, mode, expires,
// max_calls}. Ops resolve to URL templates declared in surface config —
// the agent picks an op name + params, never a raw URL.
//
// This module is dependency-free and runtime-neutral (works in extension
// service worker, userscript sandbox, and Node).

export const GRANT_V = "widespread-grant/1";

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** Issue a grant. `signer` = async (msg:string)=>base64 (ed25519). */
export async function issueGrant({ surface, ops, mode = "read", ttlSec = 86400, maxCalls = 500 }, signer, nowSec = Math.floor(Date.now() / 1000)) {
  const body = { v: GRANT_V, surface, ops, mode, expires: nowSec + ttlSec, max_calls: maxCalls, issued_by: null, sig: null };
  const sig = await signer(canonicalJson(body));
  return { ...body, sig };
}

/** Verify grant shape + expiry + scope. Returns {ok, reason}. */
export function checkGrant(grant, { surface, op, mode = "read" }, nowSec = Math.floor(Date.now() / 1000)) {
  if (!grant || grant.v !== GRANT_V) return { ok: false, reason: "bad grant" };
  if (grant.surface !== surface) return { ok: false, reason: "surface mismatch" };
  if (grant.expires < nowSec) return { ok: false, reason: "expired" };
  if (!grant.ops.includes(op)) return { ok: false, reason: "op not granted" };
  if (mode === "write" && grant.mode !== "write") return { ok: false, reason: "read-only grant" };
  return { ok: true };
}

/** Resolve an op to a concrete URL using the surface's declared api map.
 * api: { opName: "/path/{param}" } — params substitute {name} slots.
 * Returns null if op undeclared (agent can never pick arbitrary URLs). */
export function resolveOp(surfaceCfg, op, params = {}) {
  const api = surfaceCfg?.api ?? {};
  const tmpl = api[op];
  if (typeof tmpl !== "string") return null;
  // only allow http(s) and site-relative templates — never javascript:/data:
  if (!/^(https?:)?\/\//.test(tmpl) && !tmpl.startsWith("/")) return null;
  let url = tmpl;
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(String(v))) return null; // param injection guard
    url = url.split(`{${k}}`).join(encodeURIComponent(String(v)));
  }
  if (url.includes("{")) return null; // unfilled required param
  const base = surfaceCfg.base_url ?? "";
  if (url.startsWith("/")) {
    if (!base) return null;
    url = base.replace(/\/$/, "") + url;
  }
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return null; }
  catch { return null; }
  return url;
}

/** Sanitize a fetched response for sighting use: strip anything that looks
 * like credential material before it can flow downstream. */
export function sanitizeForSighting(obj, maxText = 4000) {
  const CRED_RE = /("(?:cookie|set-cookie|authorization|x-api-key|token|session|password|secret)"\s*:\s*)"[^"]*"/gi;
  let text = typeof obj === "string" ? obj : JSON.stringify(obj);
  text = text.replace(CRED_RE, '$1"[REDACTED]"');
  return text.slice(0, maxText);
}

/** Audit record shape — append-only, locally inspectable. */
export function auditRecord({ grant, op, surface, resultHash, ts = Date.now() }) {
  return { v: 1, grant_surface: grant?.surface ?? surface, op, surface, result_hash: resultHash, ts };
}
