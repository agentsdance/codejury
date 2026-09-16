import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
const cli = process.env.JURY_TEST_CLI ?? new URL("../bin/jury.js", import.meta.url).pathname;
const help = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
test("command help works without executing a command and is scoped to its topic", () => {
  for (const topic of ["review", "finding", "reply", "runs", "agents", "version"]) {
    const out = help("help", topic);
    assert.equal(out, help(topic, "--help"));
    assert.match(out, new RegExp(topic));
    assert.notEqual(out, help("help"));
  }
  const review = help("review", "-h");
  assert.match(review, /--rounds/);
  assert.doesNotMatch(review, /review-once flags|finding commands/);
  const invalid = spawnSync(process.execPath, [cli, "help", "missing"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown help topic/);
});
