// Agent registry. Built-in defaults cover codex and droid, so nothing has to be
// configured for the common case; macr.config.json overrides or adds agents.
//
// Only three things vary between agents, and all three bit during the reference
// run on !1158:
//   promptDelivery  argv (codex) vs a file flag (droid -f)
//   cwd             process cwd (codex) vs an explicit --cwd flag (droid)
//   resume          codex keeps a session; droid's exec output carries no id
import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  stopToken: "NO NEW FINDINGS",
  agents: [
    {
      name: "codex",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: ["codex", "exec", "--skip-git-repo-check", "{{promptText}}"],
      resume: { supported: true, argv: ["codex", "exec", "resume", "--last", "{{promptText}}"] },
      // stdout is a full transcript that contains the prompt, so the stop token
      // appears in the instruction as well as the answer. Read the tail only.
      report: "tail",
      expectSeconds: 1100,
    },
    {
      name: "droid",
      role: "reviewer",
      promptDelivery: "file",
      cwd: "flag",
      argv: ["droid", "exec", "--cwd", "{{worktree}}", "--auto", "medium", "-f", "{{promptFile}}"],
      resume: { supported: false, reason: "exec output carries no session id" },
      report: "whole",
      expectSeconds: 130,
    },
  ],
};

export async function loadConfig(dir = process.cwd()) {
  const file = path.join(dir, "macr.config.json");
  let user = {};
  try {
    user = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`macr.config.json is not valid JSON: ${err.message}`);
    }
  }

  const byName = new Map(DEFAULTS.agents.map((a) => [a.name, { ...a }]));
  for (const a of user.agents ?? []) {
    if (!a.name) throw new Error("each agent in macr.config.json needs a name");
    byName.set(a.name, { ...(byName.get(a.name) ?? {}), ...a });
  }

  return {
    stopToken: user.stopToken ?? DEFAULTS.stopToken,
    agents: [...byName.values()].filter((a) => a.enabled !== false),
    configFile: file,
  };
}

export function reviewers(cfg) {
  return cfg.agents.filter((a) => (a.role ?? "reviewer") === "reviewer");
}
