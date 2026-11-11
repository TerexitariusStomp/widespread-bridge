// evmread.ts — minimal JSON-RPC eth_call + ERC-8183 repo-variant job
// decoding. Pure fetch, no deps — Workers can't bundle viem/ethers, and
// the surfaces we read are small fixed layouts. Selectors are keccak
// constants (keccak-256 isn't WebCrypto).
export interface EvmJob {
  client: string;
  provider: string;
  evaluator: string;
  token: string;
  expectedBudget: bigint; // repo-variant anti-front-running field
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number; // 8183: 0 Open 1 Funded 2 Submitted 3 Completed 4 Rejected 5 Expired
}

const SEL = {
  jobCount: "0x4c5d8a0f", // jobCount()
  getJob: "0xbf22c457",   // getJob(uint256)
  getBounty: "0xee8c4bbf", // getBounty(uint256) — Claudelance TaskBoard
};

/** Batched eth_call — JSON-RPC allows an array of calls in one HTTP
 *  request, which keeps us under the Worker per-invocation subrequest
 *  cap (sequential calls die at ~50). */
export async function evmCallBatch(rpc: string, calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: "eth_call", params: [{ to: c.to, data: c.data }, "latest"] }))),
  }).catch(() => null);
  if (!r || !r.ok) return calls.map(() => null);
  const arr = await r.json().catch(() => null) as ({ id: number; result?: string } | { id: number; error: unknown })[];
  if (!Array.isArray(arr)) return calls.map(() => null);
  const out: (string | null)[] = calls.map(() => null);
  for (const item of arr) {
    const i = (item as { id: number }).id - 1;
    const res = (item as { result?: string }).result;
    if (i >= 0 && i < out.length) out[i] = res && res !== "0x" ? res : null;
  }
  return out;
}

export async function evmCall(rpc: string, to: string, data: string): Promise<string | null> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to, data }, "latest"] }),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null) as { result?: string } | null;
  return j?.result && j.result !== "0x" ? j.result : null;
}

const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

function abiString(hex: string, byteOff: number): string {
  // dynamic string: [len][bytes], offsets are hex positions not word indexes
  const p = 2 + byteOff * 2;
  const len = Number(BigInt("0x" + hex.slice(p, p + 64)));
  const raw = hex.slice(p + 64, p + 64 + len * 2);
  let out = "";
  for (let i = 0; i < raw.length; i += 2) out += String.fromCharCode(parseInt(raw.slice(i, i + 2), 16));
  return out;
}

/** Decode getJob(uint256) from the ERC-8183 repo-variant layout (9 fields,
 *  incl. expectedBudget added post-EIP for funding front-run protection):
 *  tuple(expectedBudget,client,provider,evaluator,token,descOff,budget,expiredAt,status,desc) */
export function decodeJob(hex: string): EvmJob | null {
  if (!hex || hex.length < 2 + 10 * 64) return null;
  try {
    const base = 2 + Number(word(hex, 0)) * 2; // tuple head starts at the byte offset pointed to by word 0
    const w = (i: number) => BigInt("0x" + hex.slice(base + i * 64, base + (i + 1) * 64));
    const a = (i: number) => "0x" + hex.slice(base + i * 64 + 24, base + (i + 1) * 64);
    return {
      expectedBudget: w(0),
      client: a(1), provider: a(2), evaluator: a(3), token: a(4),
      description: abiString(hex, Number(w(5)) + Number(word(hex, 0))),
      budget: w(6), expiredAt: w(7), status: Number(w(8)),
    };
  } catch { return null; }
}

export interface EvmBounty {
  poster: string;
  amount: bigint;
  token: string;
  deadline: bigint;
  maxSlots: number;
  claimedSlots: number;
  status: number; // Claudelance: 0 Open 1 Resolved 2 Cancelled
  targetRepoUrl: string;
  instructionUrl: string;
}

/** Decode Claudelance getBounty(uint256) — 15-field tuple with two
 *  trailing dynamic strings (targetRepoUrl, instructionUrl). */
export function decodeBounty(hex: string): EvmBounty | null {
  if (!hex || hex.length < 2 + 16 * 64) return null;
  try {
    const base = 2 + Number(word(hex, 0)) * 2;
    const w = (i: number) => BigInt("0x" + hex.slice(base + i * 64, base + (i + 1) * 64));
    const a = (i: number) => "0x" + hex.slice(base + i * 64 + 24, base + (i + 1) * 64);
    const head = Number(word(hex, 0));
    return {
      poster: a(0), amount: w(1), token: a(4),
      deadline: w(5), maxSlots: Number(w(6)), claimedSlots: Number(w(7)),
      status: Number(w(11)),
      targetRepoUrl: abiString(hex, Number(w(13)) + head),
      instructionUrl: abiString(hex, Number(w(14)) + head),
    };
  } catch { return null; }
}

/** Sequential-scan Claudelance bounties (ids are 1-based, contiguous),
 *  batched 40 calls per HTTP request to stay under the subrequest cap. */
export async function readBounties(rpc: string, contract: string, max = 250): Promise<{ id: number; bounty: EvmBounty }[]> {
  const out: { id: number; bounty: EvmBounty }[] = [];
  for (let i = 1; i <= max; i += 40) {
    const ids = Array.from({ length: Math.min(40, max - i + 1) }, (_, k) => i + k);
    const raws = await evmCallBatch(rpc, ids.map((id) => ({
      to: contract, data: SEL.getBounty + id.toString(16).padStart(64, "0"),
    })));
    ids.forEach((id, k) => {
      const b = raws[k] && decodeBounty(raws[k]!);
      if (b) out.push({ id, bounty: b });
    });
  }
  return out;
}

export async function readJobs(rpc: string, contract: string, max = 50): Promise<{ id: number; job: EvmJob }[]> {
  const cnt = await evmCall(rpc, contract, SEL.jobCount);
  if (!cnt) return [];
  const total = Math.min(Number(BigInt(cnt)), max);
  const ids = Array.from({ length: total }, (_, k) => total - 1 - k);
  const raws = await evmCallBatch(rpc, ids.map((i) => ({
    to: contract, data: SEL.getJob + i.toString(16).padStart(64, "0"),
  })));
  const out: { id: number; job: EvmJob }[] = [];
  ids.forEach((i, k) => {
    const job = raws[k] && decodeJob(raws[k]!);
    if (job) out.push({ id: i, job });
  });
  return out;
}
