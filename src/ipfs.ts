// ipfs.ts — content-addressed storage for ciphertext + evidence bundles.
//
// Two rails, both OPTIONAL — the bridge degrades to CID-less operation
// when neither is configured:
//   IPFS_API_URL      — a Kubo RPC endpoint (self-hosted node, e.g.
//                       http://127.0.0.1:5001). POST /api/v0/add puts
//                       the bytes; the node itself announces content.
//   IPFS_PINNING_URL  — any IPFS Pinning Service API endpoint +
//   IPFS_PINNING_KEY    (Authorization bearer). Pins a CID the node
//                       already added — persistent remote copy.
//
// What gets pinned: spec ciphertext bundles, sealed deliverables,
// Kleros evidence bundles — bytes the bridge cannot or should not
// decrypt. Plaintext never goes near this module.
import type { Env } from "./types";

export interface PinResult {
  cid?: string;
  bytes?: number;
  pinned_remotely?: boolean;
  error?: string;
}

/** Raw-content CIDv1 — the cid=… stub already carried on markets. */
export async function pinBytes(env: Env, bytes: Uint8Array, name = "widespread-blob"): Promise<PinResult> {
  const api = (env as { IPFS_API_URL?: string }).IPFS_API_URL;
  const pinUrl = (env as { IPFS_PINNING_URL?: string }).IPFS_PINNING_URL;
  const pinKey = (env as { IPFS_PINNING_KEY?: string }).IPFS_PINNING_KEY;
  if (!api) return { error: "IPFS_API_URL not configured — no Kubo node" };

  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  const add = await fetch(`${api.replace(/\/$/, "")}/api/v0/add?cid-version=1`, {
    method: "POST", body: form,
  }).catch((e) => ({ error: e instanceof Error ? e.message : "add failed" } as const));
  if ("error" in add) return { error: `ipfs add: ${add.error}` };
  if (!add.ok) return { error: `ipfs add ${add.status}` };
  const j = await add.json() as { Hash?: string; Size?: string };
  const cid = j.Hash;
  if (!cid) return { error: "ipfs add returned no Hash" };

  let remote = false;
  if (pinUrl && pinKey) {
    // Standard Pinning Service API: pin the CID we just added.
    const r = await fetch(`${pinUrl.replace(/\/$/, "")}/pins`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pinKey}` },
      body: JSON.stringify({ cid, name }),
    }).catch(() => null);
    remote = !!r?.ok;
  }
  return { cid, bytes: bytes.length, pinned_remotely: remote };
}

/** Pin a base64 blob from an API client — bounded, never executed. */
export async function handlePin(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { data_b64?: string; name?: string } | null;
  if (!body?.data_b64 || typeof body.data_b64 !== "string") {
    return Response.json({ error: "data_b64 required" }, { status: 400 });
  }
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(body.data_b64), (c) => c.charCodeAt(0)); }
  catch { return Response.json({ error: "invalid base64" }, { status: 400 }); }
  if (bytes.length > 2 * 1024 * 1024) {
    return Response.json({ error: "2MB pin budget — use your own node for larger objects" }, { status: 413 });
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 120) : "widespread-blob";
  const r = await pinBytes(env, bytes, name);
  return Response.json(r, { status: r.error ? 503 : 200 });
}
