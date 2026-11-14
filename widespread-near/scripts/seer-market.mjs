// seer-market.mjs — create a Seer Opportunity Market on Base for Foreguild
// treasury governance. Uses @seer-pm/sdk (MIT) create-market helpers + viem.
//
// Requires: BASE_PRIVATE_KEY (funded with ~0.01 xDAI for gas on Gnosis; sDAI only
// needed if you also seed liquidity — Seer Gnosis markets use sDAI collateral).
// Run:  BASE_PRIVATE_KEY=0x... node scripts/seer-market.mjs
//
// Creates a categorical market: "Foreguild Q4 treasury allocation" with
// YES/NO outcomes — resolved by oracle against verified Widespread metrics
// (settled volume on wide-mkt-11561.testnet).

import { createWalletClient, createPublicClient, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gnosis } from "viem/chains";
import {
  getCreateMarketExecution,
  getMarketFactoryAddress,
  MISC_CATEGORY,
} from "@seer-pm/sdk/create-market";

const pk = process.env.BASE_PRIVATE_KEY;
if (!pk) {
  console.error("set BASE_PRIVATE_KEY (funded Base wallet with sUSDS)");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: gnosis, transport: http("https://rpc.gnosischain.com") });
const wallet = createWalletClient({ account, chain: gnosis, transport: http("https://rpc.gnosischain.com") });

const props = {
  marketType: "categorical",
  marketName: "Will Foreguild/Widespread settle 20 verified paid tasks by 31 Jan 2027?",
  outcomes: ["Yes", "No"],
  openingTime: Math.floor(Date.now() / 1000),
  chainId: 100,
  minBond: 1000000000000000n, // 0.001 ETH — Reality.eth bond
  category: MISC_CATEGORY,
};

const execution = getCreateMarketExecution(props, getMarketFactoryAddress(100, "default"));
console.log("creating Seer market on Gnosis from", account.address);
console.log("factory:", getMarketFactoryAddress(100, "default"));
const hash = await wallet.writeContract(execution);
console.log("tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("status:", receipt.status, "block:", receipt.blockNumber.toString());
console.log("market events → https://opportunity.seer.pm/markets");
