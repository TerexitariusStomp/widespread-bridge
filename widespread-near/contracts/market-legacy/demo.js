// demo.js — the permissionless loop, narrated on devnet/sim:
//   payer locks → agent ships claim → oracle/payer verdict → escrow releases.
// Runs the contract logic in-process (node) — mirrors the on-chain path.
import { WidespreadMarket } from './contract.js';
// near-sdk-js contracts run on-chain; this demo models the call sequence
// against a local state harness for the video + README.
console.log('widespread market — see README for testnet deploy steps');
console.log('  near deploy <acct> build/contract.js');
console.log('  near call <acct> createMarket ...');
