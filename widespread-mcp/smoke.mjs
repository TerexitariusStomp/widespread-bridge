// npm run smoke — starts the stdio server, does a real MCP handshake,
// calls wide_bounties via the remote catalog, prints tool count, exits 0.
import { spawn } from "node:child_process";

const srv = spawn("uv", ["run", "widespread-mcp"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let id = 0;

srv.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* not jsonrpc */ }
  }
});

const call = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  setTimeout(() => rej(new Error(`timeout: ${method}`)), 30000);
});

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await call("tools/list");
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`tools: ${names.length}`);
  const res = await call("tools/call", { name: "wide_bounties", arguments: {} });
  const text = res.result?.content?.[0]?.text ?? "";
  console.log(`wide_bounties: ${res.isError || res.result?.isError ? "ERROR " : "ok "}${text.slice(0, 120)}`);
  srv.kill();
  process.exit(res.isError || res.result?.isError ? 1 : 0);
} catch (e) {
  console.error("smoke failed:", e.message);
  srv.kill();
  process.exit(1);
}
