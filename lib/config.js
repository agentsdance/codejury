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
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
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

  // Two sets, deliberately. `agents` is the default pool — what runs when nobody
  // names a reviewer. `available` is every agent that is merely *known*, which
  // includes built-ins that ship opt-in so that a default install does not
  // demand every supported CLI be present. An opt-in agent is still selectable
  // by name with --reviewer/--judge; it simply is not conscripted by default.
  const all = [...byName.values()];
  const agents = all.filter((a) => a.enabled !== false);

  // "Not in the default pool" and "turned off" are different things, and only
  // the first stays selectable. A built-in that ships opt-in can be named with
  // --reviewer/--judge without editing a config; an agent the user explicitly
  // disabled in this repository must stay refused, or `enabled: false` would
  // mean nothing.
  const offByUser = new Set(
    (user.agents ?? []).filter((a) => a.enabled === false).map((a) => a.name),
  );
  const selectable = all.filter((a) => !offByUser.has(a.name));

  // Exactly one writer. Two agents both believing they own the commit is the
  // one misconfiguration that corrupts a run rather than merely failing it.
  const mains = agents.filter((a) => a.role === "main");
  if (mains.length > 1) {
    throw new Error(
      `only one agent may have role "main"; found ${mains.map((a) => a.name).join(", ")}`,
    );
  }

  // A saved global judge may name an opt-in built-in, so the search covers every
  // known agent: `jury agents judge qwen` must survive without also having to
  // enable qwen in each repository's config.
  // A saved global judge may name a built-in that ships opt-in, so the search
  // covers every selectable agent rather than only the default pool. An agent
  // the repository explicitly disabled is still refused: `enabled: false` on
  // the named judge means this repository has no judge, not that the setting
  // is ignored.
  const globalJudge = !explicitMain && global.judge;
  if (globalJudge) {
    for (const agent of selectable) agent.role = agent.name === globalJudge ? "main" : (agent.role === "main" ? "reviewer" : agent.role);
  }
  const main = globalJudge ? selectable.find(a => a.name === globalJudge) ?? null : mains[0] ?? null;

  return {
    globalJudge: global.judge ?? null,
    stopToken: user.stopToken ?? DEFAULTS.stopToken,
    agents,
    available: selectable,
    main,
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
  return agent ? { ...agent, argv: agent.judgeArgv ?? agent.argv, env: agent.judgeEnv ?? agent.env } : null;
}

/** Every agent that can be named, whether or not it is in the default pool. */
export function knownAgents(cfg) {
  return cfg.available ?? cfg.agents;
}

export function reviewers(cfg) {
  return cfg.agents.filter((a) => (a.role ?? "reviewer") === "reviewer");
}
