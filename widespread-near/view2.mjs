const CONTRACT = "98ae0514a19c52d33f5e037f1705d0cc4f5be8a74adb2c86f9403c8ebbe774c7";
async function view(method, args) {
  const r = await fetch("https://rpc.mainnet.near.org", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "query",
      params: { request_type: "call_function", finality: "final",
        account_id: CONTRACT, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 300));
  return JSON.parse(Buffer.from(j.result.result).toString());
}
const m = await view("getMarket", { marketId: "2" });
console.log("status:", m.status, "| paidTo:", m.paidTo);
for (const c of m.claims ?? []) console.log(" claim", c.id, c.status, "attested:", c.attested, c.claimHash.slice(0, 30));
console.log("verdicts:", JSON.stringify(await view("getVerdicts", { marketId: "2" })));
console.log("claims:", JSON.stringify(await view("getClaims", { marketId: "2" })).slice(0, 2000));
