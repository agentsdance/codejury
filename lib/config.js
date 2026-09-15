// Agent registry. Built-in defaults cover common agent CLIs, so nothing has to be
// configured for the common case; jury.config.json overrides or adds agents.
//
// Only three things vary between agents, and all three bit during the reference
// run on !1158:
//   promptDelivery  argv (codex) vs a file flag (droid -f)
//   cwd             process cwd (codex) vs an explicit --cwd flag (droid)
//   resume          codex keeps a session; droid's exec output carries no id
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const DEFAULTS = {
  stopToken: "NO NEW FINDINGS",
  agents: [
    {
      name: "claude",
      product: "Anthropic Claude Code",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: [
        "claude", "-p", "{{promptText}}",
        "--permission-mode", "plan",
        "--disallowedTools", "Edit,Write,NotebookEdit",
        "--add-dir", "{{worktree}}",
      ],
      judgeArgv: [
        "claude", "-p", "{{promptText}}",
        "--permission-mode", "acceptEdits",
        "--add-dir", "{{worktree}}",
      ],
      resume: { supported: false, reason: "each finding is judged on its own merits" },
      report: "whole",
      expectSeconds: 900,
    },
    {
      name: "codex",
      product: "OpenAI Codex",
      role: "main",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "{{promptText}}"],
      judgeArgv: ["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "{{promptText}}"],
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
    {
      name: "opencode",
      product: "OpenCode",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: ["opencode", "run", "--dir", "{{worktree}}", "--agent", "plan", "--format", "json", "--", "{{promptText}}"],
      judgeArgv: ["opencode", "run", "--dir", "{{worktree}}", "--agent", "build", "--format", "json", "--auto", "--", "{{promptText}}"],
      env: { OPENCODE_PERMISSION: JSON.stringify({ edit: "deny", task: "deny", external_directory: "deny", bash: { "*": "deny", "git diff *": "allow", "git status*": "allow", "git show *": "allow", "git merge-base *": "allow", "git log *": "allow", "git rev-parse *": "allow" } }) },
      judgeEnv: { OPENCODE_PERMISSION: JSON.stringify({ external_directory: "deny" }) },
      resume: { supported: false, reason: "fresh conversation with finding context; never resume the latest session" },
      report: "opencode-json",
      expectSeconds: 600,
    },
    {
      name: "agy",
      product: "Google Antigravity",
      role: "reviewer",
      promptDelivery: "argv",
      cwd: "worktree",
      argv: [
        "agy", "--dangerously-skip-permissions", "--add-dir", "{{worktree}}",
        "--print-timeout", "20m", "--print", "{{promptText}}",
      ],
      resume: { supported: false, reason: "print mode starts a fresh session per run" },
      report: "whole",
      // Allow the CLI's 20-minute print timeout to finish before Jury's timeout.
      expectSeconds: 420,
    },
  ],
};

/**
 * Config file names, newest first.
 *
 * The tool was previously called `cr`, and `macr` before that. Both old names
 * remain readable across the rename — a config that
 * silently stops being found is worse than a deprecated filename, because the
 * failure looks like "every agent is suddenly missing".
 */
export const CONFIG_NAMES = ["jury.config.json", "cr.config.json", "macr.config.json"];

export const globalConfigPath = () => path.join(homedir(), ".jury", "config.json");

export async function readGlobalConfig(file = globalConfigPath()) {
  try {
    const settings = JSON.parse(await readFile(file, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)
      || (settings.judge !== undefined && (typeof settings.judge !== "string" || !settings.judge.trim()))) {
      throw new Error("expected an object with a nonempty judge name");
    }
    return settings;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot read global settings ${file}: ${err.message}`);
  }
}

export async function saveGlobalJudge(name, file = globalConfigPath()) {
  const settings = await readGlobalConfig(file);
  if (name === null) delete settings.judge;
  else settings.judge = name;
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function loadConfig(dir = process.cwd(), { globalFile = globalConfigPath() } = {}) {
  const global = await readGlobalConfig(globalFile);
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
  const explicitMain = (user.agents ?? []).find((a) => a.role === "main" && a.enabled !== false);
  if (explicitMain) {
    for (const agent of byName.values()) {
      if (agent.role === "main" && agent.name !== explicitMain.name) agent.role = "reviewer";
    }
  }
  for (const a of user.agents ?? []) {
    if (!a.name) throw new Error(`each agent in ${found} needs a name`);
    const merged = { ...(byName.get(a.name) ?? {}), ...a };
    // A custom executable must also be used for judging unless explicitly overridden.
    if (a.argv && !Object.hasOwn(a, "judgeArgv")) delete merged.judgeArgv;
    byName.set(a.name, merged);
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

  const globalJudge = !explicitMain && global.judge;
  if (globalJudge) {
    for (const agent of agents) agent.role = agent.name === globalJudge ? "main" : (agent.role === "main" ? "reviewer" : agent.role);
  }
  const main = globalJudge ? agents.find(a => a.name === globalJudge) ?? null : mains[0] ?? null;

  return {
    globalJudge: global.judge ?? null,
    stopToken: user.stopToken ?? DEFAULTS.stopToken,
    agents,
    main,
    configFile: path.join(dir, found),
  };
}

/** Select the agent that judges findings and owns the working tree. */
export function judgeAgent(cfg, name) {
  const agent = name ? cfg.agents.find((a) => a.name === name) : cfg.main;
  return agent ? { ...agent, argv: agent.judgeArgv ?? agent.argv, env: agent.judgeEnv ?? agent.env } : null;
}

export function reviewers(cfg) {
  return cfg.agents.filter((a) => (a.role ?? "reviewer") === "reviewer");
}
