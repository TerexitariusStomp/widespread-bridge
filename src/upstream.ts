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

/** Public-HTTP prover — networks exposing a no-auth public API keyed by
 * the ref id. `env` override lets deployments/tests repoint the base. */
function httpApiProver(envKey: string, defaultBase: string, path: (id: string) => string,
  ok: (body: unknown) => boolean, label: string): Prover["verify"] {
  return async (env, opaque) => {
    const base = ((env as unknown as Record<string, string | undefined>)[envKey] || defaultBase).replace(/\/$/, "");
    try {
      const res = await fetch(`${base}${path(opaque)}`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, detail: `${label} HTTP ${res.status}` };
      const body = await res.json();
      return ok(body)
        ? { ok: true, detail: `${label} confirmed` }
        : { ok: false, detail: `${label} returned negative status` };
    } catch (e) {
      return { ok: false, detail: `${label} unreachable: ${e instanceof Error ? e.message : e}` };
    }
  };
}

const PROVERS: Record<string, Prover> = {
  // Wave A — ported chimera networks
  golem: fmt(/^agr-[0-9a-f]{8,64}$|^0x[0-9a-fA-F]{64}$/, "golem", true, evmTxProver("UPSTREAM_GOLEM_RPC")),
  mysterium: fmt(/^sess-[0-9a-f-]{8,64}$|^[0-9a-f-]{36}$/, "mysterium", false),
  btfs: fmt(/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120}|[0-9a-f]{64})$/, "btfs", false),
  anyone: fmt(/^[0-9a-f]{40,64}$/, "anyone", false),
  // Wave B/C — public daemons (refs emitted by the runner providers)
  storj: fmt(/^[1-9A-HJ-NP-Za-km-z]{30,64}$/, "storj", false),          // node id (base58)
  "storj-sat": fmt(/^[1-9A-HJ-NP-Za-km-z]{30,64}$/, "storj", false),    // satellite id
  sia: fmt(/^(ed25519:)?[0-9a-f]{16,128}$|^ed25519:[0-9a-fA-F+/=]{8,128}$/, "sia", false), // host pubkey / contract id
  theta: fmt(/^[0-9a-zA-Z_-]{4,128}$/, "theta", false),                 // edgelauncher job id / node addr
  aioz: fmt(/^[0-9a-zA-Z_-]{4,128}$/, "aioz", false),                  // dCDN task id
  hopr: fmt(/^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{44,60}$/, "hopr", true, evmTxProver("UPSTREAM_HOPR_RPC")), // channel/tx on Gnosis, or libp2p peer id (format-only)
  nosana: fmt(/^[1-9A-HJ-NP-Za-km-z]{32,88}$/, "nosana", false),       // solana address / job id (job post returns tx sig or job pubkey)
  ionet: fmt(/^[0-9a-zA-Z_-]{6,64}$/, "ionet", true,
    httpApiProver("UPSTREAM_IONET_EXPLORER", "https://api.io.solutions",
      (id) => `/v1/io-explorer/devices/${encodeURIComponent(id)}/details`,
      (b) => !!(b && typeof b === "object"), "io explorer")),          // public device telemetry
  sentinel: fmt(/^sentnode1[0-9a-z]{38}$|^\d{4,20}$/, "sentinel", true,
    async (env, opaque) => {
      // node addresses → public health API; numeric session ids → LCD query
      if (opaque.startsWith("sentnode1")) {
        const fn = httpApiProver("UPSTREAM_SENTINEL_HEALTH", "https://api.health.sentinel.co",
          (id) => `/v1/records/${encodeURIComponent(id)}`,
          (b) => (b as { result?: { ok?: boolean; status?: number } })?.result?.ok === true,
          "sentinel health");
        return fn!(env, opaque);
      }
      const fn = httpApiProver("UPSTREAM_SENTINEL_LCD", "https://lcd.sentinel.co",
        (id) => `/sentinel/session/v3/sessions/${encodeURIComponent(id)}`,
        (b) => !!(b as { session?: unknown })?.session, "sentinel lcd");
      return fn!(env, opaque);
    }),
  spheron: fmt(/^[0-9a-zA-Z_-]{4,64}$/, "spheron", false),              // fizz node id — dashboard-only telemetry
  infernet: fmt(/^0x[0-9a-fA-F]{40}$|^[0-9a-zA-Z_-]{4,64}$/, "infernet", false), // coordinator contract / wallet
  "infernet-job": fmt(/^[0-9a-zA-Z_-]{4,64}$/, "infernet", false),
  "filecoin-pdp": fmt(/^f0[0-9]+$|^[0-9a-zA-Z_-]{4,64}$/, "filecoin-pdp", false), // provider/deal id
  netmind: fmt(/^[0-9a-zA-Z_-]{4,64}$/, "netmind", false),            // machine node_name — account-gated telemetry
  bee: fmt(/^0x[0-9a-fA-F]{64}$|^[0-9a-fA-F]{64}$|^0x[0-9a-fA-F]{40}$/, "bee", true, evmTxProver("UPSTREAM_BEE_RPC")), // overlay/chequebook/tx on Gnosis
  "bee-peer": fmt(/^[0-9a-fA-F]{64}$/, "bee", false),
  autonomi: fmt(/^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{40,60}$/, "autonomi", false), // rewards addr (EVM) / peer id
  akash: fmt(/^(dseq|provider|lease):[0-9a-zA-Z:._-]{2,80}$|^akash1[0-9a-z]{20,60}$|^[0-9a-zA-Z._-]{6,64}$/, "akash", false), // dseq/provider refs from serve() deploys, akash1... provider addr
  arweave: fmt(/^[0-9a-zA-Z_-]{43}$|^[0-9a-zA-Z_-]{20,64}$/, "arweave", false), // block hash / wallet addr
  gaianet: fmt(/^[0-9a-zA-Z._-]{4,80}$/, "gaianet", false),
  "gaianet-model": fmt(/^[0-9a-zA-Z._\/-]{3,80}$/, "gaianet", false),
  nkn: fmt(/^NKN[0-9a-zA-Z]{30,50}$|^[0-9a-f]{64}$|^[0-9a-zA-Z._-]{8,80}$/, "nkn", false),
  // attest:<url> — TEE attestation doc (tinfoil/dstack style
  // `/.well-known/*-attestation`). Full DCAP/SGX quote verification
  // needs native libs workerd lacks; the honest tier fetches the doc,
  // checks shape + freshness, and marks verified only when an external
  // verifier (UPSTREAM_ATTEST_VERIFY_URL) confirms the quote.
  attest: fmt(/^https?:\/\/[0-9a-zA-Z._\-/:?=&%]{8,300}$/, "attest", true,
    async (env, opaque) => {
      const verifyUrl = (env as unknown as Record<string, string | undefined>).UPSTREAM_ATTEST_VERIFY_URL;
      try {
        const res = await fetch(opaque, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, detail: `attestation doc HTTP ${res.status}` };
        const doc = await res.json() as Record<string, unknown>;
        const hasShape = doc && typeof doc === "object" &&
          (doc.verifier || doc.measurement || doc.quote || doc.evidence || doc.attestation);
        if (!hasShape) return { ok: false, detail: "attestation doc missing verifier/measurement/quote fields" };
        if (!verifyUrl) {
          return { ok: false, detail: "attestation doc well-formed but unsigned-quote verification needs UPSTREAM_ATTEST_VERIFY_URL" };
        }
        const v = await fetch(verifyUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ doc, url: opaque }), signal: AbortSignal.timeout(15000),
        });
        const out = await v.json() as { verified?: boolean; detail?: string };
        return out.verified
          ? { ok: true, detail: out.detail || "TEE quote verified" }
          : { ok: false, detail: out.detail || "external verifier rejected quote" };
      } catch (e) {
        return { ok: false, detail: `attestation unreachable: ${e instanceof Error ? e.message : e}` };
      }
    }),
  // zktls:<proof-id> — zkTLS proof (TLSNotary/Reclaim-style). The proof
  // itself lives off-chain; verification delegates to a configured
  // prover service (UPSTREAM_ZKTLS_PROVER_URL) which runs the real
  // TLSNotary/Reclaim verification. Without it, format-only.
  zktls: fmt(/^[0-9a-zA-Z._:/-]{4,200}$/, "zktls", true,
    async (env, opaque) => {
      const prover = (env as unknown as Record<string, string | undefined>).UPSTREAM_ZKTLS_PROVER_URL;
      if (!prover) return { ok: false, detail: "no zkTLS prover configured (UPSTREAM_ZKTLS_PROVER_URL)" };
      try {
        const res = await fetch(prover, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ proof_id: opaque }), signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return { ok: false, detail: `zkTLS prover HTTP ${res.status}` };
        const out = await res.json() as { verified?: boolean; detail?: string };
        return out.verified
          ? { ok: true, detail: out.detail || "zkTLS proof verified" }
          : { ok: false, detail: out.detail || "zkTLS proof rejected" };
      } catch (e) {
        return { ok: false, detail: `zkTLS prover unreachable: ${e instanceof Error ? e.message : e}` };
      }
    }),
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
