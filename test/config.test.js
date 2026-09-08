// Loading the agent registry. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, judgeAgent, reviewers, CONFIG_NAMES } from "../lib/config.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "jury-config-"));
const write = (dir, name, obj) =>
  writeFile(path.join(dir, name), JSON.stringify(obj));

const ONE = { agents: [{ name: "codex", enabled: true, role: "reviewer", argv: ["codex"] }] };

test("the two previous config names are still read", async () => {
  // A config that silently stops being found is worse than a deprecated
  // filename: the failure surfaces as "every agent is suddenly missing",
  // which reads like a broken install rather than a rename.
  for (const name of ["cr.config.json", "macr.config.json"]) {
    const dir = await tmp();
    await write(dir, name, ONE);
    const cfg = await loadConfig(dir);
    assert.ok(cfg.agents.some((a) => a.name === "codex"), `${name} must still load`);
    assert.equal(path.basename(cfg.configFile), name);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the new name wins when both are present", async () => {
  const dir = await tmp();
  await write(dir, "cr.config.json", { agents: [{ name: "codex", enabled: false }] });
  await write(dir, "jury.config.json", ONE);
  const cfg = await loadConfig(dir);
  assert.match(cfg.configFile, /[/\\]jury\.config\.json$/);
  assert.ok(cfg.agents.some((a) => a.name === "codex"), "jury.config.json enabled it");
  await rm(dir, { recursive: true, force: true });
});

test("no config at all is not an error — the defaults stand", async () => {
  const dir = await tmp();
  const cfg = await loadConfig(dir);
  assert.ok(cfg.agents.length > 0, "built-in agents must survive a missing config");
  await rm(dir, { recursive: true, force: true });
});

test("Codex is the default judge and an enabled agent can override it", async () => {
  const dir = await tmp();
  const cfg = await loadConfig(dir);
  assert.equal(judgeAgent(cfg).name, "codex");
  assert.ok(!reviewers(cfg).some((a) => a.name === "codex"));
  assert.ok(reviewers(cfg).some((a) => a.name === "claude"));
  assert.equal(judgeAgent(cfg, "claude").name, "claude");
  assert.equal(judgeAgent(cfg, "missing"), null);
  await rm(dir, { recursive: true, force: true });
});

test("malformed JSON names the file it could not read", async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, "jury.config.json"), "{ not json");
  await assert.rejects(() => loadConfig(dir), /jury\.config\.json is not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test("the preferred name is current and both old names remain listed", async () => {
  assert.equal(CONFIG_NAMES[0], "jury.config.json", "the current name must be tried first");
  assert.ok(CONFIG_NAMES.includes("cr.config.json"), "cr config must remain readable");
  assert.ok(CONFIG_NAMES.includes("macr.config.json"), "macr config must remain readable");
});

test("an explicit configured judge overrides the built-in Codex default", async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await write(dir, "jury.config.json", { agents: [{ name: "claude", role: "main" }] });
  const cfg = await loadConfig(dir);
  assert.equal(judgeAgent(cfg).name, "claude");
  assert.ok(reviewers(cfg).some((a) => a.name === "codex"));
  await write(dir, "jury.config.json", { agents: [
    { name: "claude", role: "main" }, { name: "codex", role: "main" },
  ] });
  await assert.rejects(loadConfig(dir), /only one agent/);
});
