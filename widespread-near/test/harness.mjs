// harness.mjs — load a near-sdk-js v2 contract source under Node by
// bundling it with esbuild and aliasing near-sdk-js to our stub.
// Returns { Contract, near } — `near` is the mutable runtime context.

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "near-sdk-js-stub.mjs");
const cache = new Map();

export async function loadContract(srcPath, exportName) {
  if (cache.has(srcPath)) return cache.get(srcPath);
  const dir = mkdtempSync(join(tmpdir(), "near-contract-"));
  const src = readFileSync(srcPath, "utf8");
  // Decorators need the TS parser — write as .ts so esbuild applies them.
  const tsPath = join(dir, "contract.ts");
  writeFileSync(tsPath, src);
  const out = join(dir, "bundle.mjs");
  await build({
    entryPoints: [tsPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    alias: { "near-sdk-js": stub },
    logLevel: "silent",
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  const mod = await import(pathToFileURL(out).href);
  const { near } = await import("./near-sdk-js-stub.mjs");
  const entry = { Contract: mod[exportName], near };
  cache.set(srcPath, entry);
  return entry;
}

/** Populate the stubbed `near` runtime for one call. Returns the
 * transfer recorder so tests can assert payouts. */
export function setNear(near, { account = "alice.testnet", signer, deposit = 0n,
                               timestamp = 1_000_000_000n } = {}) {
  const transfers = [];
  near.predecessorAccountId = () => account;
  near.signerAccountId = () => signer ?? account;
  near.attachedDeposit = () => deposit;
  near.blockTimestamp = () => timestamp;
  near.promiseBatchCreate = (to) => { transfers.push({ to, amount: 0n, calls: [] }); return transfers.length - 1; };
  near.promiseBatchActionTransfer = (idx, amount) => { transfers[idx].amount = amount; };
  near.promiseBatchActionFunctionCall = (idx, methodName, args, amount, gas) => {
    (near.__calls ??= []).push({ fn: [idx, methodName, args, amount, gas] });
    transfers[idx].calls.push({ methodName, args: JSON.parse(args), deposit: amount, gas });
  };
  return transfers;
}
