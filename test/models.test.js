import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS, loadConfig, judgeAgent, knownAgents, applyModelFlags, assertModelsSupported, modelsUsed,
  saveGlobalModel, readGlobalConfig,
} from "../lib/config.js";
import { runAgent, withModel, modelEnv, supportsModel } from "../lib/agents.js";
import { replyArgv } from "../lib/reply.js";
import { validateAgent } from "../lib/agent-schema.js";
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL("../bin/jury.js", import.meta.url));

async function scratch(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Where each CLI's model flag lands, verified against its own --help:
// codex-cli 0.156.1 (exec and exec resume: -m, --model), Claude Code 2.1.281
// (--model), opencode 1.18.32 (run: -m, --model), qwen 0.24.4 (-m, --model),
// Copilot CLI 1.0.88 (--model), Kimi Code 2.1.1 (-m, --model), droid 0.226.2
// (exec: -m, --model), agy 1.2.10 (--model), cursor-agent 2026.09.23 (--model),
// traecli 0.207.1 (exec: -m, --model).
const FLAG_AT = {
  codex: { argv: 2, judgeArgv: 2, resume: 3 },
  claude: { argv: 1, judgeArgv: 1, resume: 1 },
  opencode: { argv: 2, judgeArgv: 2, resume: 2 },
  qwen: { argv: 1, judgeArgv: 1, resume: 1 },
  copilot: { argv: 1, judgeArgv: 1 },
  kimi: { argv: 1, judgeArgv: 1, resume: 1 },
  droid: { argv: 2, resume: 2 },
  agy: { argv: 1, resume: 1 },
  cursor: { argv: 1, judgeArgv: 1 },
  trae: { argv: 2, judgeArgv: 2 },
};
const byName = new Map(DEFAULTS.agents.map(a => [a.name, a]));

test("each supported agent gets its model flag in every command, and nothing without a model", () => {
  for (const [name, at] of Object.entries(FLAG_AT)) {
    const agent = byName.get(name);
    assert.ok(supportsModel(agent), name);
    const variants = { argv: agent.argv, judgeArgv: agent.judgeArgv, resume: agent.resume?.argv };
    for (const [key, index] of Object.entries(at)) {
      const argv = variants[key];
      const withOne = withModel(argv, { ...agent, model: "m-1" });
      assert.deepEqual(withOne.slice(index, index + 2), ["--model", "m-1"], `${name} ${key}`);
      assert.deepEqual(withModel(argv, agent), argv.filter(a => a !== "{{modelArgs}}"), `${name} ${key} unchanged without a model`);
    }
  }
  // grok reads GROK_MODEL (superagent-ai/grok-cli README); its argv is untouched.
  const grok = byName.get("grok");
  assert.ok(supportsModel(grok));
  assert.deepEqual(modelEnv({ ...grok, model: "grok-4.3" }), { GROK_MODEL: "grok-4.3" });
  assert.deepEqual(modelEnv(grok), {});
  assert.deepEqual(withModel(grok.argv, { ...grok, model: "grok-4.3" }), grok.argv);
});

test("agents without a per-run model say so and refuse a configured model", () => {
  for (const name of ["amp"]) {
    const agent = byName.get(name);
    assert.equal(supportsModel(agent), false, name);
    assert.ok(agent.modelNote, `${name} explains why`);
    assert.throws(() => assertModelsSupported([{ ...agent, model: "x", modelSource: "--model" }]),
      new RegExp(`${name} cannot select a model per run .*remove model "x" from --model`));
  }
  assert.doesNotThrow(() => assertModelsSupported([byName.get("amp"), { ...byName.get("codex"), model: "x" }]));
  // A custom command without a slot cannot carry the model either.
  assert.equal(supportsModel({ name: "mine", argv: ["mine", "{{promptText}}"], resume: { supported: false } }), false);
  assert.equal(supportsModel({ name: "mine", argv: ["mine", "--model={{model}}"], resume: { supported: false } }), true);
});

test("the schema keeps the model slot and its arguments together", () => {
  const codex = byName.get("codex");
  const noSlot = { ...codex, judgeArgv: codex.judgeArgv.filter(a => a !== "{{modelArgs}}") };
  assert.ok(validateAgent(noSlot).some(p => /judgeArgv must contain a "\{\{modelArgs\}\}"/.test(p)));
  const { modelArgs, ...slotOnly } = codex;
  assert.ok(validateAgent(slotOnly).some(p => /modelArgs is not defined/.test(p)));
  assert.ok(validateAgent({ ...codex, modelArgs: ["--model"] }).some(p => /"modelArgs" must be/.test(p)));
  assert.ok(validateAgent({ ...codex, modelNote: "none" }).some(p => /modelNote/.test(p)));
});

test("the model reaches the process on first runs, resumed rounds, judging and replies", async t => {
  const dir = await scratch(t, "jury-model-run-");
  const log = path.join(dir, "calls.jsonl");
  const exe = path.join(dir, "fake-agent");
  await writeFile(exe, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), grok: process.env.GROK_MODEL ?? null }) + "\\n");\nconsole.log("session id: 0123abcd-0000");\nconsole.log("NO NEW FINDINGS");\n`);
  await chmod(exe, 0o755);
  const swap = argv => [exe, ...argv.slice(1)];
  const codex = { ...byName.get("codex"), model: "gpt-x" };
  const stand = { ...codex, argv: swap(codex.argv), resume: { ...codex.resume, argv: swap(codex.resume.argv) } };
  const opts = { worktree: dir, prompt: "review", stopToken: "NO NEW FINDINGS", timeoutSeconds: 10 };
  assert.ok((await runAgent(stand, opts)).ok);
  assert.ok((await runAgent(stand, { ...opts, sessionId: "0123abcd-0000" })).ok);
  assert.ok((await runAgent({ ...stand, argv: swap(codex.judgeArgv) }, opts)).ok);
  assert.ok((await runAgent({ ...stand, model: undefined }, opts)).ok);
  const grok = byName.get("grok");
  assert.ok((await runAgent({ ...grok, model: "grok-4.3", argv: swap(grok.argv) }, opts)).ok);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(calls[0].argv.slice(0, 3), ["exec", "--model", "gpt-x"]);
  assert.deepEqual(calls[1].argv.slice(0, 5), ["exec", "resume", "--model", "gpt-x", "0123abcd-0000"]);
  assert.deepEqual(calls[2].argv.slice(0, 4), ["exec", "--model", "gpt-x", "--sandbox"]);
  assert.ok(!calls[3].argv.includes("--model"));
  assert.ok(!calls[3].argv.some(a => a.includes("{{")));
  assert.equal(calls[4].grok, "grok-4.3");

  const reply = replyArgv(codex, { promptText: "verdicts", worktree: dir, sessionId: "abc-123" });
  assert.deepEqual(reply.argv.slice(0, 6), ["codex", "exec", "resume", "--model", "gpt-x", "abc-123"]);
  const fresh = replyArgv({ ...codex, model: undefined }, { promptText: "verdicts", worktree: dir });
  assert.ok(!fresh.argv.some(a => a.includes("{{modelArgs}}") || a === "--model"));
});

test("precedence: --model, then the repository, then the saved model, then the CLI default", async t => {
  const dir = await scratch(t, "jury-model-precedence-");
  const globalFile = path.join(dir, "global.json");
  let cfg = await loadConfig(dir, { globalFile });
  assert.equal(knownAgents(cfg).find(a => a.name === "claude").model, undefined);

  await saveGlobalModel("claude", "sonnet", globalFile);
  await saveGlobalModel("codex", "gpt-a", globalFile);
  cfg = await loadConfig(dir, { globalFile });
  const claude = () => knownAgents(cfg).find(a => a.name === "claude");
  assert.equal(claude().model, "sonnet");
  assert.equal(claude().modelSource, "~/.jury/config.json");
  assert.equal(judgeAgent(cfg).model, "gpt-a", "the judge carries its model too");

  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "claude", model: "opus" }] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.equal(claude().model, "opus");
  assert.equal(claude().modelSource, "jury.config.json");

  applyModelFlags(cfg, ["claude=haiku", "amp=smart"]);
  assert.equal(claude().model, "haiku");
  assert.equal(claude().modelSource, "--model");
  assert.deepEqual(modelsUsed([judgeAgent(cfg), claude()]), { codex: "gpt-a", claude: "haiku" });
  assert.equal(modelsUsed([knownAgents(cfg).find(a => a.name === "grok")]), undefined);

  for (const [flag, why] of [["claude", /<agent>=<model>/], ["=x", /<agent>=<model>/], ["nobody=x", /unknown or disabled agent "nobody"/],
    ["claude=", /nonempty/], ["claude=-x", /must not start with "-"/], ["claude=a b", /whitespace/]]) {
    assert.throws(() => applyModelFlags(cfg, [flag]), why, flag);
  }
  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "claude", model: "--danger" }] }));
  await assert.rejects(loadConfig(dir, { globalFile }), /jury\.config\.json: claude: model "--danger" must not start with "-"/);

  await saveGlobalModel("claude", null, globalFile);
  await saveGlobalModel("codex", null, globalFile);
  assert.deepEqual(await readGlobalConfig(globalFile), {});
  await writeFile(globalFile, JSON.stringify({ models: { claude: "" } }));
  await assert.rejects(readGlobalConfig(globalFile), /models to map agent names/);
});

test("jury agents model saves, lists, refuses and resets, and a review records the models used", async t => {
  const home = await scratch(t, "jury-model-cli-");
  const repo = path.join(home, "repo");
  await mkdir(repo);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (args, cwd = repo) => execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  const fail = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" });
  const file = path.join(home, ".jury", "config.json");

  assert.match(run(["agents", "model", "codex", "gpt-x"]), /codex: model gpt-x/);
  const before = await readFile(file, "utf8");
  for (const [args, why] of [[["amp", "x"], /amp cannot select a model per run/], [["codex", "-x"], /must not start/],
    [["nobody", "x"], /Unknown or disabled agent/], [["codex"], /Usage/]]) {
    const bad = fail(["agents", "model", ...args]);
    assert.notEqual(bad.status, 0, args.join(" "));
    assert.match(bad.stderr, why);
    assert.equal(await readFile(file, "utf8"), before);
  }
  const listing = run(["agents", "model"]);
  assert.match(listing, /codex\s+gpt-x\s+\(~\/\.jury\/config\.json\)/);
  assert.match(listing, /claude\s+CLI default\n/);
  assert.match(listing, /amp\s+CLI default\s+\(no per-run model\)/);
  assert.match(spawnSync(process.execPath, [cli, "agents"], { cwd: repo, env, encoding: "utf8" }).stdout, /codex .*\(model gpt-x\)/);
  assert.match(run(["agents", "model", "--help"]), /jury agents model <agent> <model>/);

  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { env });
  g("init", "-q", "-b", "master");
  g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  g("checkout", "-q", "-b", "feature");
  g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "change");
  const review = (...extra) => spawnSync(process.execPath, [cli, "review", "--dir", repo, "--trunk", "master",
    "--rounds", "1", "--web=false", "--dry-run", "--jury", "claude", ...extra], { cwd: repo, env, encoding: "utf8" });

  let result = review("--model", "claude=opus");
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /models\s+codex gpt-x, claude opus/);
  const [slug] = await readdir(path.join(repo, "runs"));
  const saved = JSON.parse(await readFile(path.join(repo, "runs", slug, "run.json"), "utf8"));
  assert.deepEqual(saved.target.models, { codex: "gpt-x", claude: "opus" });

  result = review("--jury", "amp", "--model", "amp=x");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /amp cannot select a model per run.*remove model "x" from --model/);

  run(["agents", "model", "codex", "--reset"]);
  assert.match(run(["agents", "model"]), /codex\s+CLI default/);
});
