import type { Env } from "./types";
// near.ts — shared NEAR JSON-RPC view-call helper.
export async function nearView(
  env: { NEAR_RPC_URL?: string },
  accountId: string,
  method: string,
  args: object
): Promise<unknown> {
  const rpc = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "wide",
      method: "query",
      params: {
        request_type: "call_function", finality: "final",
        account_id: accountId, method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const out = (await res.json()) as { result?: { result?: number[] } };
  const bytes = out.result?.result;
  return bytes ? JSON.parse(String.fromCharCode(...bytes)) : null;
}

/** All open markets on the configured NEAR contract, shaped for the API. */
export async function listOnchainMarkets(env: Env): Promise<unknown[] | null> {
  const acct = (env as { NEAR_CONTRACT?: string }).NEAR_CONTRACT;
  if (!acct) return null;
  const markets = await nearView(env, acct, "listOpen", {}) as
    { marketId: string; payer: string; spec: string; amount: string; locked: string; deadline: string; status: string }[] | null;
  if (!markets) return null;
  return markets.map((m) => ({
    marketId: m.marketId, payer: m.payer, spec: m.spec,
    amount: m.amount, locked: m.locked, deadline: m.deadline,
    status: m.status, payout_trace: {
      escrowed: true, state: m.status,
      to: m.status === "paid" ? "claimant" : "escrow", tx: null,
    },
  }));
}
