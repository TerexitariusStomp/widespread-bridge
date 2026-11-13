// Bidirectional audit: after a verdict, write the receipt back to the
// forge as a commit status (POST /api/:o/:r/dg/status), signed with the
// bridge's own did:key agent identity — the same envelope scheme the
// forge verifies for every agent mutation (x-dg-* headers, Ed25519 over
// sha256("dg1\n<did>\n<ts>\n<nonce>\n<METHOD>\n<path>\n<body_sha256>")).

import type { Env, Writeback } from "./types";

const te = new TextEncoder();

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function agentKey(env: Env): Promise<CryptoKey | null> {
  if (!env.DG_AGENT_KEY_PKCS8_B64) return null;
  return crypto.subtle
    .importKey("pkcs8", b64ToBytes(env.DG_AGENT_KEY_PKCS8_B64) as BufferSource, "Ed25519", false, [
      "sign",
    ])
    .catch(() => null);
}

async function signedPost(
  env: Env,
  key: CryptoKey,
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const bodyBytes = te.encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const bodySha = await sha256Hex(bodyBytes);
  const payload = await sha256Hex(
    te.encode(`dg1\n${env.DG_AGENT_DID}\n${ts}\n${nonce}\nPOST\n${path}\n${bodySha}`)
  );
  const sig = toHex(
    await crypto.subtle.sign("Ed25519", key, te.encode(payload) as BufferSource)
  );
  const res = await fetch(`${env.FORGE_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dg-did": env.DG_AGENT_DID!,
      "x-dg-ts": ts,
      "x-dg-nonce": nonce,
      "x-dg-sig": sig,
    },
    body: bodyBytes,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Record the payout receipt (or rejection) on the claimed commit so the
 * forge's own audit surface — GET /dg/status/:sha — shows the money trail.
 */
export async function writebackReceipt(
  env: Env,
  opts: {
    repo: string;
    sha: string;
    accepted: boolean;
    description: string;
    claimId: string;
  }
): Promise<Writeback> {
  const out: Writeback = { attempted: false };
  if (!env.DG_AGENT_DID || !env.DG_AGENT_KEY_PKCS8_B64) {
    out.skipped_reason = "no DG_AGENT_* identity configured";
    return out;
  }
  const key = await agentKey(env);
  if (!key) {
    out.skipped_reason = "DG_AGENT_KEY_PKCS8_B64 is not a valid Ed25519 pkcs8 key";
    return out;
  }
  const path = `/api/${opts.repo}/dg/status`;
  const targetUrl = env.PUBLIC_BASE ? `${env.PUBLIC_BASE}/#/claim/${opts.claimId}` : undefined;
  const res = await signedPost(env, key, path, {
    sha: opts.sha,
    state: opts.accepted ? "success" : "failure",
    context: "widespread/payout",
    description: opts.description.slice(0, 512),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
  out.attempted = true;
  out.status_url = `${env.FORGE_BASE}/api/${opts.repo}/dg/status/${opts.sha}`;
  if (res.status !== 200) out.error = `dg/status: HTTP ${res.status} ${JSON.stringify(res.body)}`;
  return out;
}
