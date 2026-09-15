// Loading the agent registry. The built-in agents themselves live one-per-file
// in lib/agents/, so adding one is a data change rather than an edit here; this
// module is only about merging them with the user's jury.config.json and
// deciding which agent judges.
//
// What varies between agents, and what every definition therefore states:
//   promptDelivery  argv (codex) vs a file flag (droid -f)
//   cwd             process cwd (codex) vs an explicit --cwd flag (droid)
//   resume          codex keeps a session; droid's exec output carries no id
//   sandbox         how strongly the reviewer run is prevented from writing
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_AGENTS } from "./agents/registry.js";

export const DEFAULTS = {
  stopToken: "NO NEW FINDINGS",
  agents: BUILTIN_AGENTS,
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

  // Two sets, deliberately. `agents` is the default pool — what runs when nobody
  // names a reviewer. `available` is every agent that is merely *known*, which
  // includes built-ins that ship opt-in so that a default install does not
  // demand every supported CLI be present. An opt-in agent is still selectable
  // by name with --reviewer/--judge; it simply is not conscripted by default.
  const all = [...byName.values()];
  const agents = all.filter((a) => a.enabled !== false);

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
    available: all,
    main: mains[0] ?? null,
    configFile: path.join(dir, found),
  };
}

/**
 * Select the agent that judges findings and owns the working tree.
 *
 * Naming an agent explicitly reaches the whole known set, not just the default
 * pool: `--judge qwen` must work without first having to enable qwen in a
 * config file, or shipping an agent opt-in would make it unselectable.
 */
export function judgeAgent(cfg, name) {
  const agent = name
    ? (cfg.available ?? cfg.agents).find((a) => a.name === name)
    : cfg.main;
  return agent ? { ...agent, argv: agent.judgeArgv ?? agent.argv } : null;
}

/** Every agent that can be named, whether or not it is in the default pool. */
export function knownAgents(cfg) {
  return cfg.available ?? cfg.agents;
}

export function reviewers(cfg) {
  return cfg.agents.filter((a) => (a.role ?? "reviewer") === "reviewer");
}
