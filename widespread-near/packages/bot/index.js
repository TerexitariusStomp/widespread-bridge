/**
 * widespread-bot — the forge-native surface on GitHub.
 * @widespread $N for <spec>  → labels + spec comment + escrow link
 * merge of a PR with `closes #N`  → merge=accept → triggers bridge review → payout
 * receipt writeback → the payout lands in the PR's own thread permanently.
 */
const BRIDGE = process.env.WIDE_BRIDGE || "https://widespread-bridge.widespread.workers.dev";
const FORGE = process.env.WIDE_FORGE || "https://code.widespread.fyi";

module.exports = (app) => {
  app.log.info("widespread-bot up");

  // ---- @widespread $N for <spec> on issues/comments → seed a market ----
  app.on(["issue_comment.created"], async (ctx) => {
    const body = ctx.payload.comment.body || "";
    const m = body.match(/@widespread\s+\$?([\d.]+)\s+(?:for\s+)?([\s\S]+)/i);
    if (!m) return;
    const [_, amount, spec] = m;
    const issue = ctx.payload.issue;
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // label + spec comment = the forge-native market record
    await ctx.octokit.issues.addLabels({ ...ctx.issue(), labels: [`wide:funded:$${amount}`] });
    await ctx.octokit.issues.createComment({ ...ctx.issue(),
      body: `@widespread market — **$${amount}** for \`${spec.trim().slice(0, 140)}\`\n` +
            `market_id: \`${repo}#${issue.number}\` · specHash pinned · escrow → ${BRIDGE}/api/markets` });
    app.log.info({ repo, amount }, "bounty seeded");
  });

  // ---- PR merge = accept → trigger the bridge review → payout ----
  app.on("pull_request.closed", async (ctx) => {
    const pr = ctx.payload.pull_request;
    if (!pr.merged) return;
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // find a wide-funded issue this PR closes
    const body = (pr.body || "") + " " + (pr.title || "");
    const ref = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!ref) return;
    const issueNum = ref[1];
    const issue = await ctx.octokit.issues.get({ ...ctx.issue(), issue_number: Number(issueNum) });
    const funded = (issue.data.labels || []).some((l) => /wide:funded/i.test(l.name || l));
    if (!funded) return;
    // merge=accept: trigger bridge adjudication on the merge commit
    const res = await fetch(`${BRIDGE}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, seq: 0, commits: [pr.merge_commit_sha], accept: true, merge_sha: pr.merge_commit_sha }),
    }).catch((e) => ({ ok: false, text: () => String(e) }));
    const out = await res.json?.().catch?.(() => ({}));
    // receipt lands in the PR thread — permanent repo history
    await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: pr.number,
      body: `@widespread **merge = accept**\n` +
            `commit \`${pr.merge_commit_sha.slice(0, 10)}\` → review: \`${out.status ?? out.adjudication ?? "pending"}\`\n` +
            `receipt → ${BRIDGE}/api/markets` });
    app.log.info({ repo, sha: pr.merge_commit_sha }, "merge=accept triggered");
  });
};
