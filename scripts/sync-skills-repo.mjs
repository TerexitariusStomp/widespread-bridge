// scripts/sync-skills-repo.mjs — push a distribution dir to its standalone repo.
// Usage: node scripts/sync-skills-repo.mjs [--check] [dir] [repo]
//   default: widespread-skills → TerexitariusStomp/widespread-skills
//   also:    node scripts/sync-skills-repo.mjs widespread-mcp TerexitariusStomp/widespread-mcp
// Those repos are MIRRORS: canonical sources live in this monorepo,
// distribution repo (github.com/TerexitariusStomp/widespread-skills).
// That repo is a MIRROR: canonical SKILL.md is .agents/skills/widespread/SKILL.md,
// regenerated into widespread-skills/ by `npm run sync`.
//
//   node scripts/sync-skills-repo.mjs            commit+push if changed
//   node scripts/sync-skills-repo.mjs --check    exit non-zero if mirror is behind
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const positional = process.argv.slice(2).filter(a => !a.startsWith("-"));
const DIR = positional[0] ?? "widespread-skills";
const REPO_NAME = positional[1] ?? DIR;
const REPO = `https://github.com/TerexitariusStomp/${REPO_NAME}.git`;

// regenerate first — never push stale generated files
execFileSync("node", [join(root, "scripts/sync-surfaces.mjs")], { stdio: "inherit" });

const tmp = join(tmpdir(), `${DIR}-${Date.now()}`);
const git = (a, cwd = tmp) => execFileSync("git", a, { cwd, encoding: "utf8" });
try {
  execFileSync("git", ["clone", "--depth", "1", "-b", "master", REPO, tmp], { stdio: "inherit" });
  for (const e of execFileSync("git", ["-C", tmp, "ls-files"], { encoding: "utf8" }).trim().split("\n"))
    if (e) rmSync(join(tmp, e), { force: true });
  cpSync(join(root, DIR), tmp, { recursive: true });

  git(["add", "-A"]);
  const dirty = git(["status", "--porcelain"]).trim();
  if (!dirty) { console.log("mirror already in sync"); process.exit(0); }
  if (CHECK) { console.error("mirror is behind:\n" + dirty); process.exit(1); }

  const srcSha = git(["-C", root, "rev-parse", "--short", "HEAD"]).trim();
  git(["-c", "user.name=Devin", "-c", "user.email=158243242+devin-ai-integration[bot]@users.noreply.github.com",
       "commit", "-q", "-m", `Sync from widespread-bridge@${srcSha}`]);
  git(["push", "origin", "HEAD:master"]);
  console.log("pushed mirror");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
