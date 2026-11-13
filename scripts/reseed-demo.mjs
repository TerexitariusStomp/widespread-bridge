// One-command demo reseed: the forge wipes op-logs periodically, so this
// refires the demo claims and re-runs both reviews to restore full state.
//   node scripts/reseed-demo.mjs
import { execFileSync } from "node:child_process";

const BRIDGE = "https://widespread-bridge.widespread.workers.dev";
const DIR = new URL("..", import.meta.url).pathname;

const claims = [
  {
    repo: "slop/slopdotcash",
    commits: "99cc25d469c2ededff0b67d99f08dd4375cf4208",
    session: "widespread-demo-keeper-pay",
  },
  {
    repo: "slop/slopdotcash",
    commits: "a0cc9de43d530b6b4d3884a5910074e4eee02e84",
    session: "widespread-demo-lease-receipt",
  },
  {
    repo: "slop/protocol",
    commits: "ec8f99d477e2c7846b8a33c234ca9451ee464866",
    session: "widespread-demo-reject",
  },
];

const run = (cmd, args) =>
  execFileSync("bash", ["-lc", `${cmd} ${args}`], { cwd: DIR }).toString().trim();

for (const c of claims) {
  console.log(`shipping ${c.repo} ← ${c.commits.slice(0, 8)}…`);
  const out = run("node", [
    `scripts/ship-claim.mjs --repo ${c.repo} --commits ${c.commits} --session ${c.session}-$(date +%s) --tool devin`,
  ]);
  const seq = out.match(/"op_seq":(\d+)/)?.[1];
  if (seq == null) { console.log("  ship failed:", out.slice(0, 200)); continue; }
  console.log(`  landed seq ${seq} — reviewing…`);
  const r = run("curl", [
    `-s -X POST ${BRIDGE}/review -H 'content-type: application/json' -d '{"repo":"${c.repo}","seq":${seq}}'`,
  ]);
  const rec = JSON.parse(r).records?.[0];
  console.log(`  ${rec?.status} | verdict ${rec?.adjudication?.verdict} @ ${rec?.adjudication?.confidence} | batch ${rec?.payout?.batch_id ?? "—"} ${rec?.payout?.batch_status ?? ""}`);
}
console.log("\nstate:", run("curl", [`-s ${BRIDGE}/api/state | python3 -c "import json,sys; print(len(json.load(sys.stdin)['claims']),'records')"`]));
