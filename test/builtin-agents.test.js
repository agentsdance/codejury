// Every built-in agent definition, checked against the schema. Run with `node --test`.
//
// The point of these tests is that adding an agent stays a one-file change that
// a contributor can get right without reading the rest of the codebase: if a
// new lib/agents/*.json is malformed, names a flag shape the runner cannot
// perform, or quietly resumes "the last session", it fails here rather than
// twenty minutes into somebody's review run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgent, validateRegistry, SANDBOX_LEVELS } from "../lib/agent-schema.js";
import { BUILTIN_AGENTS } from "../lib/agents/registry.js";
import { loadConfig, judgeAgent, reviewers, knownAgents } from "../lib/config.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "agents");

test("every built-in agent satisfies the schema", () => {
  const problems = validateRegistry(BUILTIN_AGENTS);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("every agent file in lib/agents is registered, and vice versa", async () => {
  // A definition that exists on disk but was never added to the registry is the
  // likeliest way for a contributor's agent to appear finished and never run.
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"))
    .sort();
  const registered = BUILTIN_AGENTS.map((a) => a.name).sort();
  assert.deepEqual(files, registered,
    "each lib/agents/<name>.json must be imported by registry.js, and its filename must match its name");
});

test("the agent files are the only source of built-in agents", async () => {
  // config.js must not regrow an inline list: the whole point of the split is
  // that contributors add a file rather than edit shared code.
  const config = await readFile(path.join(dir, "..", "config.js"), "utf8");
  assert.ok(!/name:\s*["']codex["']/.test(config),
    "config.js must not define agents inline — they belong in lib/agents/");
});

test("the schema rejects the mistakes a new agent is likely to make", () => {
  const ok = BUILTIN_AGENTS.find((a) => a.name === "qwen");

  const missing = { ...ok };
  delete missing.sandbox;
  assert.ok(validateAgent(missing).some((p) => /missing "sandbox"/.test(p)));

  assert.ok(validateAgent({ ...ok, promptDelivery: "carrier-pigeon" })
    .some((p) => /"promptDelivery" must be/.test(p)));

  assert.ok(validateAgent({ ...ok, argv: ["{{worktree}}", "run"] })
    .some((p) => /argv\[0\] must be the executable/.test(p)),
    "probe() looks up argv[0], so it cannot be a template");

  assert.ok(validateAgent({ ...ok, whatIsThis: true })
    .some((p) => /unknown field/.test(p)),
    "a typo'd field must not be silently ignored");

  // The isolation rule this project rests on.
  assert.ok(validateAgent({ ...ok, resume: { supported: true, argv: ["qwen", "--resume", "--last"] } })
    .some((p) => /\{\{sessionId\}\}/.test(p)),
    "resuming the latest session can answer an unrelated conversation");

  assert.ok(validateAgent({ ...ok, resume: { supported: false } })
    .some((p) => /resume\.reason/.test(p)),
    "declining resume must be a documented decision, not an omission");

  const unsandboxed = { ...ok, sandbox: "none" };
  delete unsandboxed.sandboxNote;
  assert.ok(validateAgent(unsandboxed).some((p) => /sandboxNote/.test(p)),
    "an agent that can write while reviewing must say so in words");
});

test("each agent states a sandbox level, and an unsandboxed one explains itself", () => {
  for (const agent of BUILTIN_AGENTS) {
    assert.ok(SANDBOX_LEVELS.includes(agent.sandbox), `${agent.name}: unknown sandbox level`);
    if (agent.sandbox === "none") {
      assert.ok(agent.sandboxNote?.trim(),
        `${agent.name}: an agent with no read-only mode must carry a sandboxNote`);
    }
  }
});

// All newly added CLIs require explicit selection, not installation by every user.
const NEW = ["opencode", "qwen", "copilot", "cursor", "amp", "kimi"];

test("the new agents are selectable as reviewer and as judge", async () => {
  // They ship opt-in, so they are absent from the default pool — but naming one
  // must still work without editing a config file first, or "supported" would
  // mean nothing more than "listed".
  const cfg = await loadConfig(path.join(dir, "..", ".."));
  const known = new Map(knownAgents(cfg).map((a) => [a.name, a]));
  for (const name of NEW) {
    assert.ok(known.has(name), `${name} must be a known built-in agent`);
    assert.equal(judgeAgent(cfg, name)?.name, name, `${name} must be usable with --judge`);
  }
});

test("the new agents ship opt-in, so a default install needs no extra CLI", async () => {
  // Enabling them by default would make every review preflight-fail on any
  // machine that has not installed all ten agents.
  const cfg = await loadConfig(path.join(dir, "..", ".."));
  const pool = new Set(cfg.agents.map((a) => a.name));
  for (const name of NEW) {
    assert.ok(!pool.has(name), `${name} must not be in the default pool`);
  }
  for (const name of ["codex", "claude", "grok", "droid"]) {
    assert.ok(pool.has(name), `${name} must remain enabled by default`);
  }
});

test("a judge invocation is never the read-only reviewer invocation", () => {
  // Judging writes the fix, so an agent whose reviewer argv genuinely forbids
  // writing needs a judgeArgv that does not. Without this the judge silently
  // cannot commit. Agents whose reviewer mode already permits edits (droid's
  // `--auto medium`) judge with the same command and need no second entry.
  const FORBIDS_WRITES = /^(read-only|plan|acceptEdits|auto-edit)$|^Edit,|^write$|^shell$/;
  for (const agent of BUILTIN_AGENTS) {
    const restricted = agent.argv.some((a) => FORBIDS_WRITES.test(a));
    if (!restricted) continue;
    assert.ok(agent.judgeArgv, `${agent.name}: a restricted reviewer needs a judgeArgv to write with`);
    assert.notDeepEqual(agent.judgeArgv, agent.argv,
      `${agent.name}: judgeArgv must differ from the read-only reviewer argv`);
  }
});

test("every agent's prompt actually reaches it", () => {
  for (const agent of BUILTIN_AGENTS) {
    const all = [agent.argv, agent.judgeArgv, agent.resume?.argv].filter(Boolean);
    for (const argv of all) {
      const joined = argv.join(" ");
      const token = agent.promptDelivery === "file" ? "{{promptFile}}" : "{{promptText}}";
      assert.ok(joined.includes(token),
        `${agent.name}: ${agent.promptDelivery} delivery requires ${token} in every argv`);
    }
  }
});

test("an agent that runs via a cwd flag names the worktree in argv", () => {
  // cwd: "flag" means runAgent spawns in the process cwd, so the worktree only
  // reaches the agent if argv says so. Getting this wrong reviews the wrong tree.
  for (const agent of BUILTIN_AGENTS.filter((a) => a.cwd === "flag")) {
    assert.ok(agent.argv.includes("{{worktree}}"),
      `${agent.name}: cwd is "flag", so argv must pass {{worktree}}`);
  }
});

test("an agent taking a generated session id declares newSession", () => {
  for (const agent of BUILTIN_AGENTS) {
    if (agent.argv.some((a) => a.includes("{{sessionId}}"))) {
      assert.equal(agent.newSession, true,
        `${agent.name}: argv uses {{sessionId}}, so newSession must be true or it substitutes empty`);
    }
  }
});

test("an idFrom pattern is a valid regular expression with one capture group", () => {
  for (const agent of BUILTIN_AGENTS) {
    const src = agent.resume?.idFrom;
    if (!src) continue;
    const re = new RegExp(src, "i");
    assert.equal(re.exec("session_id: 4f9a2c1b-33de-4a10-9f0e-7788aa112233")?.[1],
      "4f9a2c1b-33de-4a10-9f0e-7788aa112233",
      `${agent.name}: idFrom must capture the session id in group 1`);
  }
});

test("codex remains the default judge and the new agents carry the reviewer role", async () => {
  const cfg = await loadConfig(path.join(dir, "..", ".."));
  assert.equal(judgeAgent(cfg).name, "codex", "adding agents must not move the default judge");
  assert.ok(!reviewers(cfg).some((a) => a.name === "codex"), "the judge never reviews its own work");
  const known = new Map(knownAgents(cfg).map((a) => [a.name, a]));
  for (const name of NEW) {
    assert.equal(known.get(name).role ?? "reviewer", "reviewer",
      `${name} must carry the reviewer role so --reviewer accepts it`);
  }
});

test("shipping opt-in is not the same as being disabled by the user", async (t) => {
  // An agent that merely ships opt-in stays selectable by name. One the
  // repository explicitly turned off must stay refused, or `enabled: false`
  // would quietly stop meaning anything.
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const repo = await mkdtemp(path.join(tmpdir(), "jury-optin-"));
  t.after(() => rm(repo, { recursive: true, force: true }));

  let cfg = await loadConfig(repo);
  assert.equal(judgeAgent(cfg, "qwen")?.name, "qwen", "an opt-in built-in is selectable as judge");

  await writeFile(path.join(repo, "jury.config.json"),
    JSON.stringify({ agents: [{ name: "qwen", enabled: false }] }));
  cfg = await loadConfig(repo);
  assert.equal(judgeAgent(cfg, "qwen"), null, "an explicitly disabled agent must stay refused");
  assert.ok(!knownAgents(cfg).some((a) => a.name === "qwen"),
    "a disabled agent is not offered as selectable");
});
