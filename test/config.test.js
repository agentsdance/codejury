// Loading the agent registry. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, CONFIG_NAMES } from "../lib/config.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "cr-config-"));
const write = (dir, name, obj) =>
  writeFile(path.join(dir, name), JSON.stringify(obj));

const ONE = { agents: [{ name: "codex", enabled: true, role: "reviewer", argv: ["codex"] }] };

test("the tool was called macr once, so that config file is still read", async () => {
  // A config that silently stops being found is worse than a deprecated
  // filename: the failure surfaces as "every agent is suddenly missing",
  // which reads like a broken install rather than a rename.
  const dir = await tmp();
  await write(dir, "macr.config.json", ONE);
  const cfg = await loadConfig(dir);
  assert.ok(cfg.agents.some((a) => a.name === "codex"), "the old name must still load");
  assert.match(cfg.configFile, /macr\.config\.json$/);
  await rm(dir, { recursive: true, force: true });
});

test("the new name wins when both are present", async () => {
  const dir = await tmp();
  await write(dir, "macr.config.json", { agents: [{ name: "codex", enabled: false }] });
  await write(dir, "cr.config.json", ONE);
  const cfg = await loadConfig(dir);
  assert.match(cfg.configFile, /[/\\]cr\.config\.json$/);
  assert.ok(cfg.agents.some((a) => a.name === "codex"), "cr.config.json enabled it");
  await rm(dir, { recursive: true, force: true });
});

test("no config at all is not an error — the defaults stand", async () => {
  const dir = await tmp();
  const cfg = await loadConfig(dir);
  assert.ok(cfg.agents.length > 0, "built-in agents must survive a missing config");
  await rm(dir, { recursive: true, force: true });
});

test("malformed JSON names the file it could not read", async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, "cr.config.json"), "{ not json");
  await assert.rejects(() => loadConfig(dir), /cr\.config\.json is not valid JSON/);
  await rm(dir, { recursive: true, force: true });
});

test("the preferred name is the current one, and the old one is still listed", async () => {
  assert.equal(CONFIG_NAMES[0], "cr.config.json", "the current name must be tried first");
  assert.ok(CONFIG_NAMES.includes("macr.config.json"), "the old name must remain readable");
});
