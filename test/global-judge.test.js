import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, judgeAgent, reviewers, saveGlobalJudge } from "../lib/config.js";
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL("../bin/jury.js", import.meta.url));

test("global judge persists across CLI invocations and directories, with reset and validation", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "jury-global-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = path.join(home, "first"), second = path.join(home, "second");
  await mkdir(first); await mkdir(second);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (args, cwd = first) => execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  assert.match(run(["agents", "judge", "claude"]), /Global judge: claude/);
  assert.match(run(["agents", "judge"], second), /Global judge: claude/);
  const file = path.join(home, ".jury", "config.json");
  const before = await readFile(file, "utf8");
  const bad = spawnSync(process.execPath, [cli, "agents", "judge", "typo"], { cwd: second, env, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Unknown or disabled judge/);
  assert.equal(await readFile(file, "utf8"), before);
  await writeFile(path.join(second, "jury.config.json"), JSON.stringify({ agents: [{ name: "grok", enabled: false }] }));
  for (const args of [["judge", "grok"], ["judge", "claude", "extra"], ["unknown"]]) {
    const invalid = spawnSync(process.execPath, [cli, "agents", ...args], { cwd: second, env, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.equal(await readFile(file, "utf8"), before);
  }
  assert.match(run(["agents", "judge", "--help"]), /jury agents judge/);
  run(["agents", "judge", "--reset"]);
  assert.match(run(["agents", "judge"]), /not set/);
});

test("repository and per-run judges override global defaults without losing reviewer roles", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-precedence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const globalFile = path.join(dir, "global.json");
  await writeFile(globalFile, JSON.stringify({ judge: "claude", unrelated: 7 }));
  let cfg = await loadConfig(dir, { globalFile });
  assert.equal(judgeAgent(cfg).name, "claude");
  assert.equal(judgeAgent(cfg, "grok").name, "grok");
  assert.ok(reviewers(cfg).some(a => a.name === "codex"));
  assert.ok(!reviewers(cfg).some(a => a.name === "claude"));
  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "grok", role: "main" }] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.equal(judgeAgent(cfg).name, "grok");
  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "claude", enabled: false }] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.equal(judgeAgent(cfg), null);
  assert.equal(judgeAgent(cfg, "codex").name, "codex");
  await saveGlobalJudge(null, globalFile);
  assert.deepEqual(JSON.parse(await readFile(globalFile)), { unrelated: 7 });
  assert.equal(judgeAgent(await loadConfig(dir, { globalFile })).name, "codex");
});
