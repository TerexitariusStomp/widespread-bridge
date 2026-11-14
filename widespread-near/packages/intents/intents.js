// intents.js — Aurora Intents settlement leg (the $3K bounty integration).
// Payer funds → quote → deposit → solvers settle to the contributor on
// Solana (or any chain). Settlement ONLY counts after confirmed status —
// post-Oct-2026-incident discipline: never credit on deposit alone.

const API = 'https://intents-api.aurora.dev/api';
export const APP_KEY = process.env.AURORA_APP_KEY || '';

export const TOKENS = {
  SOL_USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  SOL_USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
};

export async function getTokens() {
  const r = await fetch(`${API}/tokens/${APP_KEY}`);
  if (!r.ok) throw new Error(`tokens: HTTP ${r.status}`);
  return r.json();
}

// Request a quote: assetIn → assetOut to `recipient` on `destChain`.
export async function quote({ assetIn, assetOut, amount, recipient, destChain, refundTo }) {
  const r = await fetch(`${API}/quote/${APP_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      depositType: 'ORIGIN_CHAIN',
      originAsset: assetIn,
      destinationAsset: assetOut,
      amount: String(amount),
      slippageTolerance: 100,
      refundTo: refundTo || 'widespread.near',
      refundType: 'ORIGIN_CHAIN',
      recipient: recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3600e3).toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`quote: HTTP ${r.status} ${await r.text()}`);
  return r.json(); // → depositAddress, estimated output, fees
}

// Settlement is only real when the solver CONFIRMS — poll status.
export async function getStatus(depositAddress) {
  const r = await fetch(`${API}/status/${depositAddress}`);
  if (!r.ok) throw new Error(`status: HTTP ${r.status}`);
  return r.json();
}

export async function waitSettled(depositAddress, { tries = 20, gapMs = 8000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await getStatus(depositAddress);
    const st = s.status || s.state;
    if (/success|settled|completed/i.test(st)) return { settled: true, status: s };
    if (/refund|fail/i.test(st)) return { settled: false, status: s };
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return { settled: false, status: 'timeout' };
}

// Full leg: quote → (caller deposits) → waitSettled → true payout.
export async function intentsPayout(opts) {
  const q = await quote(opts);
  return {
    depositAddress: q.depositAddress || q.deposit_address,
    amountOut: q.amountOut || q.amount_out,
    quote: q,
    settle: () => waitSettled(q.depositAddress || q.deposit_address),
  };
}
