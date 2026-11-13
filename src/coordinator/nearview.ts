// Ported from LocalChimera (AGPL-3.0) — new for Widespread (NEAR market views).

/**
 * nearview.ts — minimal NEAR JSON-RPC view-call helper for the coordinator.
 * Same wire shape as src/near.ts's nearView but parameterized on the RPC
 * URL + contract so the DO can call it without threading the whole Env.
 */
export async function nearView(
  rpcUrl: string,
  contract: string,
  method: string,
  args: object,
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "wide",
      method: "query",
      params: {
        request_type: "call_function", finality: "final",
        account_id: contract, method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const out = (await res.json()) as { result?: { result?: number[] } };
  const bytes = out.result?.result;
  return bytes ? JSON.parse(String.fromCharCode(...bytes)) : null;
}

/** Read one market's on-chain record. Returns null when unconfigured or
 *  the view call fails — callers decide whether null means "open" (fail
 *  open for dispatch) or "reject" (fail closed for job submission). */
export async function getMarket(
  env: { NEAR_RPC_URL?: string; NEAR_CONTRACT?: string },
  marketId: string,
): Promise<{ marketId?: string; status?: string; [k: string]: unknown } | null> {
  const acct = env.NEAR_CONTRACT;
  const rpc = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  if (!acct || !marketId) return null;
  const m = await nearView(rpc, acct, "getMarket", { marketId }).catch(() => null);
  return m && typeof m === "object" ? (m as { marketId?: string; status?: string }) : null;
}
