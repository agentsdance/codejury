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
import { supportsModel } from "./agents.js";

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
    if (settings.reviewers !== undefined && (!Array.isArray(settings.reviewers) || !settings.reviewers.length
      || settings.reviewers.some(n => typeof n !== "string" || !n.trim()))) {
      throw new Error("expected reviewers to be a nonempty list of agent names");
    }
    if (settings.models !== undefined && (!settings.models || typeof settings.models !== "object"
      || Array.isArray(settings.models) || Object.values(settings.models).some(m => modelProblem(m)))) {
      throw new Error("expected models to map agent names to model names");
    }
    return settings;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot read global settings ${file}: ${err.message}`);
  }
}

export async function saveGlobalJudge(name, file = globalConfigPath()) {
  await saveGlobalSetting("judge", name, file);
}

/** Save the default reviewer list, or remove it with null. */
export async function saveGlobalReviewers(names, file = globalConfigPath()) {
  if (names !== null && !names.length) throw new Error("at least one default reviewer is required");
  await saveGlobalSetting("reviewers", names, file);
}

/** Save one agent's default model, or remove it with null. */
export async function saveGlobalModel(agent, model, file = globalConfigPath()) {
  const settings = await readGlobalConfig(file);
  const models = { ...(settings.models ?? {}) };
  if (model === null) delete models[agent];
  else models[agent] = model;
  await saveGlobalSetting("models", Object.keys(models).length ? models : null, file);
}

/**
 * Why a model name is unusable, or null. A model reaches the agent as its own
 * argument, so the one real hazard is a value the CLI would parse as a flag.
 */
export function modelProblem(model) {
  if (typeof model !== "string" || !model.trim()) return "a model name must be a nonempty string";
  if (model !== model.trim() || /\s/.test(model)) return `model "${model}" must not contain whitespace`;
  if (model.startsWith("-")) return `model "${model}" must not start with "-"`;
  return null;
}

async function saveGlobalSetting(key, value, file) {
  const settings = await readGlobalConfig(file);
  if (value === null) delete settings[key];
  else settings[key] = value;
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
    if (a.role === "main" && a.enabled !== false) merged.enabled = true;
    if (Object.hasOwn(a, "model")) {
      const problem = modelProblem(a.model);
      if (problem) throw new Error(`${found}: ${a.name}: ${problem}`);
      merged.modelSource = found;
    }
    byName.set(a.name, merged);
  }

  // A saved default model fills in only where the repository chose none: the
  // repository's jury.config.json is the more specific setting.
  for (const [name, model] of Object.entries(global.models ?? {})) {
    const agent = byName.get(name);
    if (agent && !Object.hasOwn(agent, "modelSource")) {
      agent.model = model;
      agent.modelSource = "~/.jury/config.json";
    }
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

  // Saved default reviewers sit below the repository's own roles: a repository
  // that names a reviewer explicitly has chosen its jury, and a global setting
  // made for some other project must not silently replace it.
  const repoReviewers = (user.agents ?? []).some(a => a.role === "reviewer" && a.enabled !== false);
  const savedReviewers = !repoReviewers && global.reviewers ? [...global.reviewers] : null;

  return {
    explicitRoles: Boolean(global.judge || global.reviewers || (user.agents ?? []).some(a =>
      Object.hasOwn(a, "role") || Object.hasOwn(a, "enabled"))),
    globalJudge: global.judge ?? null,
    globalReviewers: global.reviewers ?? null,
    savedReviewers,
    disabledByRepo: [...offByUser],
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

const SAVED = "saved default reviewers (~/.jury/config.json; change with `jury agents jury`)";

/**
 * The reviewers a run uses when none are named on the command line.
 *
 * Saved defaults reach the whole known set, like --jury, so an opt-in built-in
 * can be a default. A saved name that no longer resolves is an error naming the
 * setting rather than a silent drop: a jury that quietly shrank is a review
 * with fewer eyes than the user believes it has. The judge is left out, as it
 * never reviews its own work.
 */
export function defaultReviewers(cfg, judge = null) {
  if (!cfg.savedReviewers) return reviewers(cfg).filter(a => a.name !== judge);
  const byName = new Map(knownAgents(cfg).map(a => [a.name, a]));
  const problems = cfg.savedReviewers.filter(name => !byName.has(name)).map(name =>
    (cfg.disabledByRepo ?? []).includes(name)
      ? `"${name}" is disabled in ${path.basename(cfg.configFile)}`
      : `"${name}" is not a configured agent`);
  if (problems.length) throw new Error(`${SAVED}: ${problems.join("; ")}`);
  const pool = cfg.savedReviewers.filter(name => name !== judge).map(name => byName.get(name));
  if (!pool.length) {
    throw new Error(`${SAVED} list only "${judge}", which is the selected judge; save another reviewer or pass --reviewer <name>`);
  }
  return pool;
}

export const savedReviewersNote = SAVED;

/**
 * Apply `--model <agent>=<model>` for this run only. It outranks both config
 * files, and names an agent from the whole known set, like --reviewer.
 */
export function applyModelFlags(cfg, flags = []) {
  const byName = new Map(knownAgents(cfg).map(a => [a.name, a]));
  for (const flag of flags) {
    const at = flag.indexOf("=");
    const name = at > 0 ? flag.slice(0, at).trim() : "";
    const model = at > 0 ? flag.slice(at + 1) : "";
    if (!name) throw new Error(`--model expects <agent>=<model>, got "${flag}"`);
    const agent = byName.get(name);
    if (!agent) throw new Error(`--model names unknown or disabled agent "${name}". Choose: ${[...byName.keys()].join(", ")}`);
    const problem = modelProblem(model);
    if (problem) throw new Error(`--model ${name}: ${problem}`);
    agent.model = model;
    agent.modelSource = "--model";
  }
}

/**
 * Refuse a run that would ignore a configured model. Starting anyway would
 * review with the agent's own default while the run record, and the user,
 * believe another model was used.
 */
export function assertModelsSupported(agents) {
  const problems = agents.filter(a => a.model && !supportsModel(a)).map(a =>
    `${a.name} cannot select a model per run (${a.modelNote ?? "its command has no {{modelArgs}} slot"}); `
    + `remove model "${a.model}" from ${a.modelSource ?? "its configuration"}`);
  if (problems.length) throw new Error(problems.join("\n"));
}

/** The model each agent in a run will use, for the run record. */
export function modelsUsed(agents) {
  const used = agents.filter(a => a.model).map(a => [a.name, a.model]);
  return used.length ? Object.fromEntries(used) : undefined;
}
