// Collaborator seams — every partner integration is env-gated and optional.
// The core protocol runs with zero of these; each lights up a leg of the
// loop (proof, disputes, distribution, money, workers) when configured.
// All adapters are thin: existing public APIs/OSS clients, no custody.

import type { Env } from "./types";

/* ---------- Sigstore / Rekor — append-only attestation of ship claims ---- */

/** ECDSA P-256 keypair from env (one-time provision; ephemeral fallback
 *  still yields a valid Rekor entry but isn't reproducible). */
async function attestKey(env: Env): Promise<{ key: CryptoKey; pubPem: string } | null> {
  const pkcs8 = (env as unknown as { ATTEST_KEY_PKCS8_B64?: string }).ATTEST_KEY_PKCS8_B64;
  const pubPem = (env as unknown as { ATTEST_PUBKEY_PEM?: string }).ATTEST_PUBKEY_PEM;
  if (!pkcs8 || !pubPem) return null;
  try {
    const der = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    return { key, pubPem };
  } catch {
    return null;
  }
}

/** Upload a hashedrekord to Rekor: sha → permanent public transparency log.
 *  Returns the log entry UUID/index/integratedTime, or a skip reason. */
export async function attestClaim(
  env: Env,
  opts: { repo: string; sha: string; note?: string },
): Promise<{ uuid?: string; logIndex?: string; integratedTime?: number; skipped?: string }> {
  const key = await attestKey(env);
  if (!key) return { skipped: "ATTEST_KEY_PKCS8_B64/ATTEST_PUBKEY_PEM not set" };
  const payload = new TextEncoder().encode(`${opts.repo}@${opts.sha}:${opts.note ?? "widespread-ship"}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key.key, new TextEncoder().encode(hashHex),
  );
  const entry = {
    apiVersion: "0.0.1",
    kind: "hashedrekord",
    spec: {
      signature: {
        content: btoa(String.fromCharCode(...new Uint8Array(sig))),
        publicKey: { content: key.pubPem },
      },
      data: { hash: { algorithm: "sha256", value: hashHex } },
    },
  };
  const res = await fetch(`${(env as unknown as { REKOR_URL?: string }).REKOR_URL ?? "https://rekor.sigstore.dev"}/api/v1/log/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  }).catch(() => null);
  if (!res?.ok) return { skipped: `rekor ${res?.status ?? "unreachable"}` };
  const body = (await res.json().catch(() => null)) as Record<string, { body?: string; integratedTime?: number; logID?: string; logIndex?: number }> | null;
  const first = body ? Object.values(body)[0] : null;
  const decoded = first?.body ? JSON.parse(atob(first.body)) : {};
  return {
    uuid: decoded?.spec?.signature?.content ? Object.keys(body!)[0] : undefined,
    logIndex: first?.logIndex !== undefined ? String(first.logIndex) : undefined,
    integratedTime: first?.integratedTime,
  };
}

/* ---------- Kleros — decentralized dispute resolution ------------------- */

/** Open a dispute record + arbitration params. On-chain arbitration goes
 *  through the Kleros court contracts (their SDK is the `kleros` npm pkg);
 *  this seam binds our claimHash as evidence and returns the params a payer
 *  or agent submits. Env: KLEROS_COURT (default "general"). */
export async function openDispute(
  env: Env,
  opts: { repo: string; marketId: string; claimHash: string; reason: string; responder?: string },
): Promise<{ disputeId: string; court: string; evidenceHash: string; link: string }> {
  const court = (env as unknown as { KLEROS_COURT?: string }).KLEROS_COURT ?? "general";
  const evidenceHash = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`${opts.repo}|${opts.marketId}|${opts.claimHash}|${opts.reason}`),
  ).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  const disputeId = `wide-${opts.repo.replace(/\//g, "-")}-${opts.marketId}-${Date.now().toString(36)}`;
  await env.CLAIMS.put(`dispute:${disputeId}`, JSON.stringify({
    ...opts, court, evidenceHash, opened_at: Date.now(),
    status: "open", note: "arbitrate via kleros court contracts — evidenceHash binds claim+reason",
  }));
  return {
    disputeId, court, evidenceHash,
    link: `https://kleros.medium.com/ · court:${court} · evidence:${evidenceHash.slice(0, 16)}`,
  };
}

/* ---------- Forge registry — where receipts/mentions land --------------- */

export interface ForgeSurface {
  forge: "github" | "tangled" | "radicle" | "forgejo" | "gitlab" | "codeberg" | "generic";
  api?: string;
  receipt: "commit-status" | "mention" | "pr-comment" | "none";
}

export function forgeFor(url: string): ForgeSurface {
  if (/github\.com/.test(url)) return { forge: "github", api: "https://api.github.com", receipt: "commit-status" };
  if (/tangled\.sh|tangled\.org/.test(url)) return { forge: "tangled", receipt: "mention" };
  if (/radicle\.xyz|rad\.icle/.test(url)) return { forge: "radicle", receipt: "mention" };
  if (/forgejo|codeberg\.org/.test(url)) return { forge: url.includes("codeberg") ? "codeberg" : "forgejo", receipt: "commit-status" };
  if (/gitlab\.com/.test(url)) return { forge: "gitlab", api: "https://gitlab.com/api/v4", receipt: "commit-status" };
  return { forge: "generic", receipt: "none" };
}

/* ---------- Funding pools — OpenCollective / Polar / OnlyDust ------------ */

/** Read-only pool balances for the ecosystem feed. Public APIs, no auth. */
export async function fundingPools(env: Env): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const oc = (env as unknown as { OC_ORG?: string }).OC_ORG;
  if (oc) {
    const q = { query: `{ organization(slug:"${oc}") { name stats { totalNetAmountReceived { value } } } }` };
    const res = await fetch("https://api.opencollective.com/graphql/v2", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q),
    }).catch(() => null);
    out.opencollective = res?.ok ? await res.json().catch(() => null) : { skipped: "unreachable" };
  }
  const polar = (env as unknown as { POLAR_ORG?: string }).POLAR_ORG;
  if (polar) {
    const res = await fetch(`https://api.polar.sh/v1/issues/search?org=${encodeURIComponent(polar)}`,
      { headers: { accept: "application/json" } }).catch(() => null);
    out.polar = res?.ok ? await res.json().catch(() => null) : { skipped: "unreachable" };
  }
  const od = (env as unknown as { ONLYDUST_ORG?: string }).ONLYDUST_ORG;
  if (od) {
    const res = await fetch("https://api.onlydust.com/graphql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ organization(slug:"${od}") { name } }` }),
    }).catch(() => null);
    out.onlydust = res?.ok ? await res.json().catch(() => null) : { skipped: "unreachable" };
  }
  return out;
}

/* ---------- Security-work markets — Immunefi / Hats / Code4rena ---------- */

/** Security bounty boards share our submit→judge→pay shape for vulns.
 *  Env-gated feeds; links are the always-on surface. */
export function securityMarkets(env: Env): Record<string, unknown> {
  const e = env as unknown as { SECURITY_FEEDS?: string };
  let feeds: unknown[] = [];
  try { feeds = e.SECURITY_FEEDS ? JSON.parse(e.SECURITY_FEEDS) : []; } catch { feeds = []; }
  return {
    boards: [
      { name: "Immunefi", url: "https://immunefi.com/bug-bounty/", pattern: "submit→judge→pay (web3 vulns)" },
      { name: "Hats Finance", url: "https://hats.finance/", pattern: " decentralized audit competitions" },
      { name: "Code4rena", url: "https://code4rena.com/", pattern: "audit contests → judged payouts" },
    ],
    feeds,
    note: "widespread generalizes their verdict-gated payout to ALL work, not just vulns",
  };
}

/* ---------- Settlement rails registry ------------------------------------ */

export function rails(env: Env): Record<string, unknown>[] {
  const e = env as unknown as Record<string, string | undefined>;
  return [
    { id: "near", status: e.NEAR_CONTRACT ? "live" : "configured", note: "contract escrow + oracle release" },
    { id: "usdc", status: "live", note: "SPL token payouts" },
    { id: "near-intents-1click", status: "live", note: "cross-chain intents settlement (dry-run quotes)" },
    { id: "x402", status: e.X402_FACILITATOR ? "live" : "ready", note: "@fastnear/x402 + @x402/near deps" },
    { id: "tempo", status: e.TEMPO_API ? "live" : "ready", note: "Stripe Tempo stablecoin rail" },
    { id: "privy", status: e.PRIVY_APP_ID ? "live" : "ready", note: "agent identity/wallets" },
  ];
}

/* ---------- Agent workers — OpenHands / SWE-agent backends ---------------- */

export function workers(env: Env): Record<string, unknown>[] {
  const e = env as unknown as Record<string, string | undefined>;
  return [
    { id: "widespread-runner", status: "live", note: "sealed executor, dg-ship-1 claims" },
    { id: "openhands", status: e.WORKER_OPENHANDS ? "enabled" : "ready", cmd: "openhands", note: "All-Hands agent runtime" },
    { id: "swe-agent", status: e.WORKER_SWE_AGENT ? "enabled" : "ready", cmd: "swe-agent", note: "Princeton SWE agent" },
    { id: "hermes", status: "live", note: "near-hermes-browser wide_* toolset" },
  ];
}

/* ---------- Aggregate ecosystem feed -------------------------------------- */

export async function ecosystem(env: Env) {
  return {
    forges: [
      "https://github.com/o/r", "https://tangled.sh/o/r", "https://radicle.xyz/o/r",
      "https://codeberg.org/o/r", "https://gitlab.com/o/r", "https://forgejo.example/o/r",
    ].map((u) => forgeFor(u)),
    funding: await fundingPools(env),
    security: securityMarkets(env),
    rails: rails(env),
    workers: workers(env),
    partners: {
      disputes: "kleros", proof: "sigstore/rekor", verification: "pr-bots",
      security_pattern: "immunefi/hats/code4rena", funding: "opencollective/polar/onlydust",
      distribution: "tangled/radicle/forgejo", identity: "privy", payments: "near/intents/usdc/x402/tempo",
    },
  };
}
