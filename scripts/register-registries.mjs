#!/usr/bin/env node
// Emits registration payloads for the agent-registry layer. Actual
// submission needs the operator's account on each registry — this script
// produces exactly what to submit where.
// Usage: BASE=https://widespread-bridge.widespread.workers.dev node scripts/register-registries.mjs
const BASE = process.env.BASE ?? "https://widespread-bridge.widespread.workers.dev";
const cardUrl = `${BASE}/.well-known/agent-card.json`;

const out = {
  agent_card: cardUrl,
  nandai_index: {
    note: "NANDA AgentFacts record — submit via their index onboarding (nanda.topcoder.com). Resolution record maps our id to the Agent Card URL.",
    agentfacts: {
      agent_name: "widespread-bridge",
      provider: "widespread",
      version: "1.0.0",
      agent_url: `${BASE}/a2a`,
      capabilities: ["discover-funded-work"],
      description: "Funded work markets with escrowed claims and independent evaluation",
      evaluation: "self",
      authentication_factor: "none",
    },
  },
  fetchai_almanac: {
    note: "Deploy a uagents broadcaster agent (pip install uagents, Apache-2.0) — registers on the Almanac for ~micro-FET. Scaffold:",
    agent_py: `from uagents import Agent, Context\nagent = Agent(name="widespread-broadcaster", mailbox=True)\n@agent.on_interval(period=3600.0)\nasync def announce(ctx: Context):\n    ctx.logger.info("discover funded work: ${BASE}/api/feed")\n# run: python agent.py — agent auto-registers on the Almanac`,
  },
  x402_bazaar: {
    note: "List the evaluator endpoint in the x402 service descriptor format so buyer agents find it via the bazaar index.",
    service: {
      url: `${BASE}/api/evaluate`,
      accepts: [{ scheme: "exact", network: "base", description: "independent job evaluation, oracle-signed verdict" }],
    },
  },
  universal_agentic_registry: {
    note: "Public REST index (ai-sdk-registry-broker has NO LICENSE — API-only, no SDK dep). Register the Agent Card URL through their onboarding if/when the index accepts submissions; discovery clients already resolve A2A cards directly.",
  },
};
console.log(JSON.stringify(out, null, 2));
