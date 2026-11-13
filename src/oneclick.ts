// oneclick.ts — NEAR Intents 1Click funding quotes.
//
// 1Click (defuse-protocol) is the current cross-chain rail into NEAR:
// a requester on any supported chain gets a deposit address, sends the
// origin asset, and Intents delivers the destination asset to the NEAR
// account — which then funds a market escrow or session exactly like a
// native deposit. The Bridge API this replaced was deprecated Nov 2025;
// 1Click is the maintained path.
//
// This module is a thin honest wrapper over the official SDK — quotes are
// real API calls to the hosted 1Click service; nothing is simulated. If
// the service is unreachable the route returns 502, never a fake quote.

import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";

export interface OneClickQuoteRequest {
  /** Origin asset id (e.g. from GET /api/funding/1click/tokens). */
  originAsset: string;
  /** Destination asset id — defaults to NEAR native when omitted? No:
   *  required explicitly so callers pick the real asset id. */
  destinationAsset: string;
  /** EXACT_OUTPUT semantics: the destination amount requested (e.g. "5"
   *  NEAR to fund a session/market). */
  amount: string;
  /** Where refunds go (origin-chain address or Intents account). */
  refundTo: string;
  /** NEAR account or address receiving the destination asset. */
  recipient: string;
  slippageTolerance?: number;
}

/** Supported token/asset catalog — passthrough so callers discover real
 *  asset ids instead of guessing. */
export async function listTokens(ondoTokens = "false") {
  return OneClickService.getTokens(ondoTokens);
}

/** Request a real swap quote → deposit address + expected output. */
export async function quoteSwap(req: OneClickQuoteRequest) {
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return OneClickService.getQuote({
    dry: false,
    swapType: "EXACT_OUTPUT" as never,
    slippageTolerance: req.slippageTolerance ?? 0.5,
    originAsset: req.originAsset,
    depositType: "INTENTS" as never,
    destinationAsset: req.destinationAsset,
    amount: req.amount,
    refundTo: req.refundTo,
    refundType: "INTENTS" as never,
    recipient: req.recipient,
    recipientType: "DESTINATION_CHAIN" as never,
    deadline,
  } as never);
}

/** Poll execution status for a deposit address. */
export async function executionStatus(depositAddress: string, depositMemo?: string) {
  return OneClickService.getExecutionStatus(depositAddress, depositMemo);
}
