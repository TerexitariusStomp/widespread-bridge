// upstream.ts — upstream-prover registry for metered receipts.
//
// A receipt's `upstream_refs` are `net:opaque-id` handles into the DePIN
// network's own metering. Self-reported usage is never sole evidence —
// each ref is checked against the network's public surface where one
// exists, and honestly marked `verified:false` when only format can be
// confirmed. Networks without any public proof surface set
// `public_proof:false` — their receipts corroborate via coordinator
// challenges instead (challenge:<jobId>:<seq> refs resolve live).

import type { Env } from "./types";

export interface UpstreamVerdict {
  ref: string;
  network: string;
  verified: boolean;     // true only when a live public check passed
  detail: string;
}

interface Prover {
  name: string;
  refFormat: RegExp;
  public_proof: boolean;
  verify?: (env: Env, opaque: string) => Promise<{ ok: boolean; detail: string }>;
}

const fmt = (re: RegExp, network: string, public_proof: boolean,
  verify?: Prover["verify"]): Prover => ({ name: network, refFormat: re, public_proof, verify });

/** EVM-log prover — networks whose proofs are on-chain events. Enabled by
 * setting UPSTREAM_<NET>_RPC (JSON-RPC URL); the prover asks the chain for
 * the tx receipt — existence on-chain = corroborated. */
function evmTxProver(rpcEnvKey: string): Prover["verify"] {
  return async (env, opaque) => {
    const rpc = (env as unknown as Record<string, string | undefined>)[rpcEnvKey];
    if (!rpc) return { ok: false, detail: `${rpcEnvKey} not configured — format-only` };
    if (!/^0x[0-9a-fA-F]{64}$/.test(opaque)) return { ok: false, detail: "not a tx hash" };
    try {
      const res = await fetch(rpc, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [opaque] }),
        signal: AbortSignal.timeout(8000),
      });
      const out = (await res.json()) as { result?: { status?: string } | null };
      if (out.result?.status === "0x1") return { ok: true, detail: "tx confirmed on-chain" };
      return { ok: false, detail: out.result ? `tx status ${out.result.status}` : "tx not found" };
    } catch (e) {
      return { ok: false, detail: `rpc unreachable: ${e instanceof Error ? e.message : e}` };
    }
  };
}

const PROVERS: Record<string, Prover> = {
  // Wave A — ported chimera networks
  golem: fmt(/^agr-[0-9a-f]{8,64}$|^0x[0-9a-fA-F]{64}$/, "golem", true, evmTxProver("UPSTREAM_GOLEM_RPC")),
  mysterium: fmt(/^sess-[0-9a-f-]{8,64}$|^[0-9a-f-]{36}$/, "mysterium", false),
  btfs: fmt(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120}|[0-9a-f]{64})$/, "btfs", false),
  anyone: fmt(/^[0-9a-f]{40,64}$/, "anyone", false),
  // Wave B — public daemons
  storj: fmt(/^[a-z0-9]{16,64}@[a-z0-9.:-]+$/i, "storj", false),        // satellite:node pair
  sia: fmt(/^[0-9a-f]{64}$/, "sia", false),                            // hostd consensus id
  theta: fmt(/^edge-[0-9a-z-]{8,64}$/i, "theta", false),
  aioz: fmt(/^[0-9a-f]{64}$|^aioz[0-9a-z]{20,}$/i, "aioz", false),
  hopr: fmt(/^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/, "hopr", true, evmTxProver("UPSTREAM_HOPR_RPC")), // channel / tx on Gnosis
  nosana: fmt(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "nosana", false),        // solana address
  // challenge refs — resolved against our own coordinator, the strongest tier
  challenge: fmt(/^[A-Za-z0-9._:-]{4,128}:\d+$/, "challenge", true),
};

export const UPSTREAM_NETWORKS = Object.keys(PROVERS);

/** Verify one upstream ref. `verified:true` ONLY when a live public check
 * ran; format-valid-but-unverifiable refs report verified:false with the
 * reason — callers decide whether "referenced" is enough corroboration. */
export async function verifyUpstreamRef(env: Env, ref: string): Promise<UpstreamVerdict> {
  const m = ref.match(/^([a-z0-9_-]+):(.+)$/i);
  if (!m) return { ref, network: "unknown", verified: false, detail: "ref is not net:opaque-id shaped" };
  const [, net, opaque] = m;
  const prover = PROVERS[net.toLowerCase()];
  if (!prover) return { ref, network: "unknown", verified: false, detail: `no prover registered for ${net}` };
  if (!prover.refFormat.test(opaque)) {
    return { ref, network: prover.name, verified: false, detail: `ref fails ${prover.name} format check` };
  }
  if (net.toLowerCase() === "challenge") {
    const detail = await verifyChallengeRef(env, opaque);
    return { ref, network: "challenge", verified: detail.ok, detail: detail.detail };
  }
  if (!prover.verify) {
    return { ref, network: prover.name, verified: false, detail: `${prover.name} has no public proof API — corroborate via coordinator challenges` };
  }
  const v = await prover.verify(env, opaque);
  return { ref, network: prover.name, verified: v.ok, detail: v.detail };
}

/** challenge:<jobId>:<seq> → load the coordinator job and check the logged
 * challenge outcome. Local import avoids a cycle (artifacts ↔ upstream). */
async function verifyChallengeRef(env: Env, opaque: string): Promise<{ ok: boolean; detail: string }> {
  const m = opaque.match(/^(.+):(\d+)$/);
  if (!m) return { ok: false, detail: "malformed challenge ref" };
  const [, jobId, seqStr] = m;
  const seq = Number(seqStr);
  const { loadJobRecord, verifyJobRecordSig } = await import("./artifacts");
  const job = await loadJobRecord(env, jobId);
  if (!job) return { ok: false, detail: "coordinator job record unreachable" };
  if (!(await verifyJobRecordSig(env, job))) return { ok: false, detail: "job record sig invalid" };
  const c = job.challenges?.[seq];
  if (!c) return { ok: false, detail: `challenge ${seq} not logged` };
  return c.ok ? { ok: true, detail: "challenge passed" } : { ok: false, detail: "challenge FAILED" };
}
