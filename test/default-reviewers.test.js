import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  loadConfig, defaultReviewers, readGlobalConfig, saveGlobalJudge, saveGlobalReviewers,
} from "../lib/config.js";
import { automaticRoles } from "../lib/roles.js";
import { pickerKey, pickerState, renderPicker } from "../lib/picker.js";
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL("../bin/jury.js", import.meta.url));

async function scratch(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("saved default reviewers round-trip beside the judge and reject empty or malformed lists", async t => {
  const dir = await scratch(t, "jury-reviewers-save-");
  const file = path.join(dir, "config.json");
  await saveGlobalJudge("claude", file);
  await saveGlobalReviewers(["droid", "amp"], file);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { judge: "claude", reviewers: ["droid", "amp"] });
  await assert.rejects(saveGlobalReviewers([], file), /at least one/);
  await saveGlobalReviewers(null, file);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { judge: "claude" });
  for (const reviewers of [[], "claude", [""], [3]]) {
    await writeFile(file, JSON.stringify({ reviewers }));
    await assert.rejects(readGlobalConfig(file), /reviewers to be a nonempty list/);
  }
});

test("precedence: repository reviewer roles, then saved reviewers, then the built-in pool", async t => {
  const dir = await scratch(t, "jury-reviewers-precedence-");
  const globalFile = path.join(dir, "global.json");
  let cfg = await loadConfig(dir, { globalFile });
  const builtin = defaultReviewers(cfg, "codex").map(a => a.name);
  assert.ok(builtin.length > 1);

  // Saved: exactly these, opt-in agents included, in the saved order.
  await writeFile(globalFile, JSON.stringify({ reviewers: ["amp", "claude"] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.deepEqual(defaultReviewers(cfg, "codex").map(a => a.name), ["amp", "claude"]);
  // A saved list is an explicit role choice, so automatic assignment stays off.
  assert.equal(await automaticRoles(cfg, { check: async () => ({ ok: true }) }), null);

  // The judge is left out; a list of only the judge is an error, not an empty jury.
  assert.deepEqual(defaultReviewers(cfg, "claude").map(a => a.name), ["amp"]);
  await writeFile(globalFile, JSON.stringify({ reviewers: ["claude"] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.throws(() => defaultReviewers(cfg, "claude"), /saved default reviewers.*only "claude", which is the selected judge/);

  // A repository that disables a saved reviewer fails loudly, naming both.
  await writeFile(globalFile, JSON.stringify({ reviewers: ["claude", "droid"] }));
  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "droid", enabled: false }] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.throws(() => defaultReviewers(cfg, "codex"), /saved default reviewers.*"droid" is disabled in jury\.config\.json/);

  // A saved name that is no longer an agent at all.
  await writeFile(globalFile, JSON.stringify({ reviewers: ["claude", "gone"] }));
  await rm(path.join(dir, "jury.config.json"));
  cfg = await loadConfig(dir, { globalFile });
  assert.throws(() => defaultReviewers(cfg, "codex"), /"gone" is not a configured agent/);

  // Repository reviewer roles win over the saved list.
  await writeFile(globalFile, JSON.stringify({ reviewers: ["amp"] }));
  await writeFile(path.join(dir, "jury.config.json"), JSON.stringify({ agents: [{ name: "grok", role: "reviewer" }] }));
  cfg = await loadConfig(dir, { globalFile });
  assert.equal(cfg.savedReviewers, null);
  assert.deepEqual(cfg.globalReviewers, ["amp"]);
  assert.ok(!defaultReviewers(cfg, "codex").some(a => a.name === "amp"));
  assert.ok(defaultReviewers(cfg, "codex").some(a => a.name === "grok"));
});

test("jury agents jury saves, shows, validates and resets the global default", async t => {
  const home = await scratch(t, "jury-reviewers-cli-");
  const cwd = path.join(home, "work");
  await mkdir(cwd);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
  const file = path.join(home, ".jury", "config.json");

  assert.match(run(["agents", "jury"]), /Default reviewers: not set/);
  assert.match(run(["agents", "jury", "claude,amp", "droid"]), /Default reviewers: claude, amp, droid/);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).reviewers, ["claude", "amp", "droid"]);
  assert.match(run(["agents", "jury"]), /Default reviewers: claude, amp, droid/);

  const before = await readFile(file, "utf8");
  for (const args of [["typo"], ["claude,typo"], [","], ["--bogus"], ["--reset", "claude"]]) {
    const bad = spawnSync(process.execPath, [cli, "agents", "jury", ...args], { cwd, env, encoding: "utf8" });
    assert.notEqual(bad.status, 0, args.join(" "));
    assert.equal(await readFile(file, "utf8"), before);
  }
  assert.match(run(["agents", "jury", "--help"]), /jury agents jury/);

  const listing = spawnSync(process.execPath, [cli, "agents"], { cwd, env, encoding: "utf8" });
  assert.match(listing.stdout, /claude .*\(default reviewer\)/);
  assert.match(listing.stdout, /Default reviewers: claude, amp, droid/);
  assert.doesNotMatch(listing.stdout, /grok .*\(default reviewer\)/);

  assert.match(run(["agents", "jury", "--reset"]), /reset/);
  assert.match(run(["agents", "jury"]), /not set/);
});

test("a review without --jury uses the saved default reviewers", async t => {
  const home = await scratch(t, "jury-reviewers-run-");
  const repo = path.join(home, "repo");
  await mkdir(repo);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { env });
  g("init", "-q", "-b", "master");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  g("checkout", "-q", "-b", "feature");
  await writeFile(path.join(repo, "a.txt"), "two\n");
  g("commit", "-qam", "change");
  await mkdir(path.join(home, ".jury"));
  await writeFile(path.join(home, ".jury", "config.json"), JSON.stringify({ reviewers: ["droid", "codex"] }));

  const review = (...extra) => spawnSync(process.execPath, [cli, "review", "--dir", repo, "--trunk", "master",
    "--rounds", "1", "--web=false", "--dry-run", ...extra], { cwd: repo, env, encoding: "utf8" });
  let result = review();
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /judge\s+codex/);
  assert.match(result.stdout, /juries\s+droid(?!,)/);

  result = review("--jury", "claude");
  assert.match(result.stdout, /juries\s+claude/);

  result = review("--judge", "claude");
  assert.match(result.stdout, /juries\s+droid, codex/);
});

test("picker keys move, toggle, refuse an empty save, and cancel", () => {
  const items = [
    { name: "claude", status: "ok", notes: [] },
    { name: "grok", status: "MISSING", notes: [] },
    { name: "codex", status: "ok", notes: ["judge — excluded"] },
  ];
  let s = pickerState(items, ["claude"]);
  assert.deepEqual(s.selected, ["claude"]);
  s = pickerKey(s, { name: "up" });
  assert.equal(s.cursor, 2);
  s = pickerKey(s, { name: "down" });
  s = pickerKey(s, { name: "j" });
  assert.equal(s.cursor, 1);
  s = pickerKey(s, { name: "space" });
  assert.deepEqual(s.selected, ["claude", "grok"]);
  s = pickerKey(pickerKey(s, { name: "space" }), { name: "k" });
  s = pickerKey(s, { name: "space" });
  assert.deepEqual(s.selected, []);
  s = pickerKey(s, { name: "return" });
  assert.equal(s.done, null);
  assert.match(s.error, /at least one/);
  assert.ok(renderPicker(s, "Default reviewers").includes("Select at least one reviewer."));
  s = pickerKey(pickerKey(s, { name: "space" }), { name: "return" });
  assert.equal(s.done, "save");
  assert.deepEqual(s.selected, ["claude"]);

  const lines = renderPicker(pickerState(items, ["claude"]), "Default reviewers");
  assert.match(lines[1], /^> \[x\] claude\s+ok$/);
  assert.match(lines[2], /\[ \] grok\s+MISSING/);
  assert.match(lines[3], /codex\s+ok\s+judge — excluded/);

  for (const key of [{ name: "escape" }, { name: "q" }, { name: "c", ctrl: true }]) {
    assert.equal(pickerKey(pickerState(items, []), key).done, "cancel");
  }
});
