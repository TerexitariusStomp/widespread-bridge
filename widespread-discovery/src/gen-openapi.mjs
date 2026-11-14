// gen-openapi.mjs — OpenAPI spec → widespread-adapter/1 draft manifest.
// Bulk catalog generation: feed it a spec (JSON or YAML), get a draft
// manifest. Ops are honest `verified:false` — promotion requires live
// probing per the honesty gate. Path params become {name} templates.
import { parse as parseYaml } from "yaml";

const METHODS = ["get", "post", "put", "delete", "patch"];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "op";

function paramsFor(pathItem, methodItem) {
  const params = {};
  for (const p of [...(pathItem.parameters ?? []), ...(methodItem.parameters ?? [])]) {
    if (p?.in === "query" && p?.name) params[p.name] = `{${p.name}}`;
  }
  return Object.keys(params).length ? params : undefined;
}

export function specToManifest(spec, { surface, kind = "api", author = "", generated_by = "", source = "openapi-transpile" } = {}) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      const mi = item?.[m];
      if (!mi) continue;
      const name = slug(`${m}_${path}`);
      const endpoint = path; // site-relative; family specs may carry {instance} host
      const op = {
        name,
        class: m === "get" ? "read" : "write",
        endpoint,
        method: m.toUpperCase(),
        verified: false,
        risk: m === "get" ? "low" : "medium",
      };
      const params = paramsFor(item, mi);
      if (params) op.params = params;
      ops.push(op);
    }
  }
  const server = spec.servers?.[0]?.url;
  const manifest = {
    schema: "widespread-adapter/1",
    surface: surface ?? (server ? new URL(server).hostname : "unknown"),
    kind,
    author, generated_by,
    generated_with: { tools: ["openapi-transpile"], captured_at: Date.now(), source },
    auth: { type: "api-key", refresh: "manual", delegation: "none" },
    ops,
    status: "draft",
    issued_at: Date.now(),
    ...(server ? { _server: server } : {}),
  };
  return manifest;
}

export function parseSpec(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  return parseYaml(t);
}
