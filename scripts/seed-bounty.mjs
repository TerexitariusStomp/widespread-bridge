#!/usr/bin/env node
// Seed a funded bounty on the bridge's registry.
//
//   node scripts/seed-bounty.mjs --bridge http://localhost:8787 \
//     --repo slop/protocol --claimant you.near \
//     --amount 25.00 --currency USD \
//     --spec "…" [--upstream https://github.com/SlopDotCash/protocol] \
//     [--token $ADMIN_TOKEN]

const args = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

const BRIDGE = getOpt("bridge", "http://localhost:8787").replace(/\/$/, "");
const repo = getOpt("repo");
const claimant = getOpt("claimant");
const amount = getOpt("amount", "1.00");
const currency = getOpt("currency", "USD");
const spec = getOpt("spec", "");
const upstream = getOpt("upstream");
const token = getOpt("token", process.env.ADMIN_TOKEN);

if (!repo || !claimant) {
  console.error("need --repo owner/name --claimant receiver.near");
  process.exit(1);
}

const res = await fetch(`${BRIDGE}/api/bounties`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({
    repo,
    amount,
    currency,
    receiver_account: claimant,
    spec,
    ...(upstream ? { upstream } : {}),
  }),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
