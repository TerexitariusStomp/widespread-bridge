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
};

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

export async function readJobs(rpc: string, contract: string, max = 50): Promise<{ id: number; job: EvmJob }[]> {
  const cnt = await evmCall(rpc, contract, SEL.jobCount);
  if (!cnt) return [];
  const total = Math.min(Number(BigInt(cnt)), max);
  const out: { id: number; job: EvmJob }[] = [];
  for (let i = total - 1; i >= 0 && out.length < max; i--) {
    const res = await evmCall(rpc, contract,
      SEL.getJob + i.toString(16).padStart(64, "0"));
    const job = res && decodeJob(res);
    if (job) out.push({ id: i, job });
  }
  return out;
}
