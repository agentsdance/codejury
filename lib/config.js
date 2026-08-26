// Agent registry. Built-in defaults cover codex and droid, so nothing has to be
// configured for the common case; cr.config.json overrides or adds agents.
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
      name: "claude",
      product: "Anthropic Claude Code",
      role: "main",
      // The main agent used to carry empty argv, on the theory that it was the
      // session driving the loop rather than something spawned. That made the
      // loop unable to run without a person in the chair: nothing triaged, so
      // nothing was ever fixed and every round re-read the same commit. It is
      // spawned like any other agent now — the difference is that it is the
      // only one permitted to touch the tree.
      promptDelivery: "argv",
      cwd: "worktree",
      argv: [
        "claude", "-p", "{{promptText}}",
        "--permission-mode", "acceptEdits",
        "--add-dir", "{{worktree}}",
      ],
      resume: { supported: false, reason: "each finding is judged on its own merits" },
      report: "whole",
      // Triage is the longest step in a round: read, reproduce, fix, run the
      // suite. It was 0 back when this agent was never spawned, which made its
      // timeout 0 and killed it the instant it started.
      expectSeconds: 900,
      notes:
        "Owns the working tree and the commit. Reproduces a finding before fixing it, proves the " +
        "regression test fails without the fix, and replies to every finding including rejections.",
    },
    {
      name: "codex",
      product: "OpenAI Codex",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: ["codex", "exec", "--skip-git-repo-check", "{{promptText}}"],
      // `--last` means "whatever session ran most recently in this worktree",
      // which is only the review being answered if nothing else ran in between.
      // Any codex session started between the review and the reply steals the
      // reply: the verdict is delivered into an unrelated conversation, which
      // breaks both continuity and the isolation the whole design rests on.
      // {{sessionId}} is substituted when the review recorded one; replyArgv
      // falls back to a fresh session rather than resuming the wrong thread.
      resume: {
        supported: true,
        argv: ["codex", "exec", "resume", "{{sessionId}}", "{{promptText}}"],
        idFrom: /session[ _-]?id[:=]?\s*([0-9a-f-]{8,})/i,
      },
      // stdout is a full transcript that contains the prompt, so the stop token
      // appears in the instruction as well as the answer. Read the tail only.
      report: "tail",
      expectSeconds: 1100,
    },
    {
      name: "grok",
      product: "xAI Grok",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "flag",
      // grok assigns its own session UUID up front rather than making us guess
      // which one was ours afterwards, so resume names an exact conversation.
      // {{sessionId}} is generated per review by runAgent and handed back here.
      argv: [
        "grok", "--cwd", "{{worktree}}", "--always-approve",
        "--session-id", "{{sessionId}}", "-p", "{{promptText}}",
      ],
      newSession: true,
      resume: {
        supported: true,
        argv: ["grok", "--cwd", "{{worktree}}", "--always-approve", "--resume", "{{sessionId}}", "-p", "{{promptText}}"],
      },
      report: "whole",
      expectSeconds: 240,
    },
    {
      name: "droid",
      product: "Factory Droid",
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

/**
 * Config file names, newest first.
 *
 * The tool was called `macr` before it was called `cr`. The old name is still
 * read so an existing checkout keeps working across the rename — a config that
 * silently stops being found is worse than a deprecated filename, because the
 * failure looks like "every agent is suddenly missing".
 */
export const CONFIG_NAMES = ["cr.config.json", "macr.config.json"];

export async function loadConfig(dir = process.cwd()) {
  let user = {};
  let found = CONFIG_NAMES[0];
  for (const name of CONFIG_NAMES) {
    try {
      user = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      found = name;
      break;
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw new Error(`${name} is not valid JSON: ${err.message}`);
    }
  }

  const byName = new Map(DEFAULTS.agents.map((a) => [a.name, { ...a }]));
  for (const a of user.agents ?? []) {
    if (!a.name) throw new Error(`each agent in ${found} needs a name`);
    byName.set(a.name, { ...(byName.get(a.name) ?? {}), ...a });
  }

  const agents = [...byName.values()].filter((a) => a.enabled !== false);

  // Exactly one writer. Two agents both believing they own the commit is the
  // one misconfiguration that corrupts a run rather than merely failing it.
  const mains = agents.filter((a) => a.role === "main");
  if (mains.length > 1) {
    throw new Error(
      `only one agent may have role "main"; found ${mains.map((a) => a.name).join(", ")}`,
    );
  }

  return {
    stopToken: user.stopToken ?? DEFAULTS.stopToken,
    agents,
    main: mains[0] ?? null,
    configFile: path.join(dir, found),
  };
}

/** The agent that owns the working tree and the commit. Never spawned. */
export function mainAgent(cfg) {
  return cfg.main ?? null;
}

export function reviewers(cfg) {
  return cfg.agents.filter((a) => (a.role ?? "reviewer") === "reviewer");
}
