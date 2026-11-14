// delta-git forge adapter — the signed op-log forge (delta-git repo,
// currently deployed at FORGE_BASE). Claim stream = GET /dg/oplog entries;
// work submissions arrive as kind:"push.patch" ops (kind:"ship" is the
// legacy dg-ship-1 name, kept for back-compat). Receipts write back via
// POST /dg/status. Signed mutations use the forge's dg1 envelope:
// ed25519( utf8( sha256hex( "dg1\n<did>\n<ts>\n<nonce>\n<METHOD>\n<path>\n<body_sha256hex>" ) ) ).

import type {
  ChainVerification,
  Env,
  OpLogEntry,
  OpLogResponse,
  ShipClaim,
  Writeback,
} from "../types";
import type { ForgeAdapter, ForgeBinding, ReceiptOpts, ShipTarget } from "./types";

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

/** Recompute the stored hash for one entry — mirrors the forge's
 *  /dg/oplog canonical (JSON.stringify of the five fields in this order). */
export async function entryHash(entry: OpLogEntry, prevHash: string): Promise<string> {
  const canonical = JSON.stringify({
    seq: entry.seq,
    kind: entry.kind,
    actor: entry.actor,
    payload: entry.payload,
    createdAt: entry.created_at,
  });
  return sha256Hex(te.encode(prevHash + canonical));
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
  base: string,
  key: CryptoKey,
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const bodyBytes = te.encode(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = toHex(
    await crypto.subtle.sign(
      "Ed25519",
      key,
      (await deltagit.sigPayload(env.DG_AGENT_DID!, ts, nonce, "POST", path, await sha256Hex(bodyBytes))) as BufferSource
    )
  );
  const res = await fetch(`${base}${path}`, {
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

export const deltagit: ForgeAdapter = {
  type: "deltagit",

  async fetchClaims(b, repo, since = -1) {
    const res = await fetch(`${b.base}/api/${repo}/dg/oplog${since >= 0 ? `?since=${since}` : ""}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`oplog ${repo}: HTTP ${res.status}`);
    const body = (await res.json()) as OpLogResponse;
    return body.entries ?? [];
  },

  isClaim(e) {
    // kind:"ship" is the legacy dg-ship-1 name; on the current forge a work
    // submission lands as a push.patch op.
    return (e.kind === "ship" && e.payload?.ship === true) || e.kind === "push.patch";
  },

  toClaim(e) {
    const p = e.payload as Record<string, unknown>;
    return {
      ...(e.payload as unknown as ShipClaim),
      ship: true,
      // push.patch ops carry the new commit oid as deltaOid (intent delta
      // ref tip); ship claims carry an explicit commits list.
      commits:
        (e.payload as { commits?: string[] }).commits ??
        ([p.deltaOid ?? p.commit_oid, p.mergeOid].filter(Boolean) as string[]),
    };
  },

  async verifyChain(entries) {
    let expectedPrev = "genesis";
    let brokenAt: number | null = null;
    for (const entry of entries) {
      const computed = await entryHash(entry, expectedPrev);
      if (entry.prev_hash !== expectedPrev || entry.hash !== computed) {
        brokenAt = entry.seq;
        break;
      }
      expectedPrev = entry.hash;
    }
    const tip = entries.length > 0 ? entries[entries.length - 1] : undefined;
    const out: ChainVerification = {
      valid: brokenAt === null,
      checked: entries.length,
      tip_hash: tip?.hash ?? null,
      tip_seq: tip?.seq ?? -1,
      broken_at_seq: brokenAt,
    };
    return out;
  },

  async commitDiff(b, repo, sha) {
    const res = await fetch(`${b.base}/api/v1/repos/${repo}/commits/${sha}/diff`).catch(() => null);
    if (!res?.ok) return null;
    // Cap like evidence.ts's MAX_PATCH_BYTES — huge diffs truncate rather
    // than blow the subrequest budget.
    return (await res.text()).slice(0, 2 * 1024 * 1024);
  },

  async commitMessage(b, repo, sha) {
    const res = await fetch(`${b.base}/api/v1/repos/${repo}/commits/${sha}`, {
      headers: { accept: "application/json" },
    }).catch(() => null);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { message?: string; title?: string } | null;
    return body?.message ?? body?.title ?? null;
  },

  async writeReceipt(env, b, opts) {
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
    const res = await signedPost(env, b.base, key, path, {
      sha: opts.sha,
      state: opts.accepted ? "success" : "failure",
      context: "widespread/payout",
      description: opts.description.slice(0, 512),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    });
    out.attempted = true;
    out.status_url = `${b.base}${path}/${opts.sha}`;
    if (res.status !== 200) out.error = `dg/status: HTTP ${res.status} ${JSON.stringify(res.body)}`;
    return out;
  },

  async registerAgent(b, pubkeyHex, label) {
    if (!b) return { error: "no forge binding — register the agent with your forge, or use the generic adapter" };
    const reg = (await fetch(`${b.base}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: pubkeyHex, label }),
    })
      .then((r) => r.json().catch(() => ({})))
      .catch((e) => ({ error: `forge_unreachable: ${String(e)}` }))) as { did?: string; error?: string };
    return reg.error || !reg.did ? { error: reg.error ?? "forge registration failed" } : { did: reg.did };
  },

  shipTarget(b, repo) {
    // /dg/patch is the forge's real signed-submission route — a landed
    // patch writes a push.patch op (the claim) and auto-attempts merge.
    const path = `/api/${repo}/dg/patch`;
    return {
      path,
      url: `${b.base}${path}`,
      sign_format:
        'ed25519( utf8( sha256hex( "dg1\\n{did}\\n{ts}\\n{nonce}\\nPOST\\n{path}\\n{sha256hex(body)}" ) ) )',
      headers: "x-dg-did, x-dg-ts, x-dg-nonce, x-dg-sig",
      body_schema:
        "{ base_ref, patch, message, author? } — unified diff + commit metadata. " +
        "For non-patch artifacts, submit via POST /api/claims on the bridge instead.",
    };
  },

  async sigPayload(did, ts, nonce, method, path, bodyShaHex) {
    // The forge signs the hex digest as UTF-8 — verified live against
    // delta-git's verifyAgentRequest (sign sha256hex(canonical), not the
    // raw digest bytes).
    return te.encode(
      await sha256Hex(te.encode(`dg1\n${did}\n${ts}\n${nonce}\n${method}\n${path}\n${bodyShaHex}`))
    );
  },
};

export type { ReceiptOpts };
