// Forge resolution — which adapter + which deployment serves a repo.
//
// Resolution order (first hit wins):
//   1. env.FORGES — JSON map: { "owner/repo": {"type": "deltagit", "base": "https://…"} }
//      plus optional "*" default entry.
//   2. env.FORGE_BASE — legacy single-forge var (type deltagit — the only
//      op-log forge the legacy var ever pointed at).
//   3. generic — no remote claims/receipts; the bridge feed is the receipt.
//
// Markets' `forge`/`locator` fields describe the work's home; FORGES maps
// deployment URLs for forges that host a claim stream the bridge scans.

import type { Env, OpLogEntry } from "../types";
import { deltagit } from "./deltagit";
import { generic } from "./generic";
import type { ForgeAdapter, ForgeBinding } from "./types";

const ADAPTERS: Record<string, ForgeAdapter> = { deltagit };

export function adapterFor(type: string | undefined | null): ForgeAdapter {
  return (type && ADAPTERS[type]) || generic;
}

/** Per-repo forge binding. `repo` is the bridge's owner/repo claim key. */
export function bindingFor(env: Env, repo: string): ForgeBinding | null {
  const reg = env.FORGES ? safeJson(env.FORGES) : null;
  const hit = reg?.[repo] ?? reg?.["*"];
  if (hit?.base) return { type: hit.type ?? "generic", base: hit.base.replace(/\/+$/, "") };
  if (env.FORGE_BASE) return { type: "deltagit", base: env.FORGE_BASE.replace(/\/+$/, "") };
  return null;
}

/** Adapter + binding for a repo. `binding` null means the repo has no
 *  claim-log forge — adapter is generic and claim streams are empty. */
export function forgeFor(env: Env, repo: string): { adapter: ForgeAdapter; binding: ForgeBinding | null } {
  const binding = bindingFor(env, repo);
  return { adapter: adapterFor(binding?.type), binding };
}

function safeJson(s: string): Record<string, { type?: string; base?: string }> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export type { ForgeAdapter, ForgeBinding };
export type ClaimEntry = OpLogEntry;
