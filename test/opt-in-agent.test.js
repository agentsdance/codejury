// An opt-in built-in agent, driven through the real CLI.
//
// This lives in its own file rather than alongside the other loop tests: it
// spawns a full review, and adding that to loop.test.js pushed the whole file
// past its budget on the slower CI runners ("test did not finish before its
// parent and was cancelled" on Node 20 and 22, while Node 24 passed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEvents } from "../lib/store.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "jury-optin-"));
const exec = promisify(execFile);
const run = (cmd, args, opts) =>
  exec(cmd, args, opts).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));

test("an opt-in built-in agent runs when named, without being enabled first", async () => {
  // The agents added for issues #75-#81 ship opt-in so a default install does
  // not demand every supported CLI. Naming one must still work straight away —
  // otherwise "supported" would mean nothing more than "documented".
  const repo = await tmp();
  const g = async (...a) => run("git", ["-C", repo, ...a]);
  await g("init", "-q", "-b", "master");
  await g("config", "user.email", "t@example.com");
  await g("config", "user.name", "t");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await g("add", "-A");
  await g("commit", "-qm", "base");
  await g("checkout", "-q", "-b", "feature");
  await writeFile(path.join(repo, "a.txt"), "two\n");
  await g("commit", "-qam", "change");
  // Only the executable is stubbed; qwen keeps its built-in role and opt-in
  // status, which is the part under test.
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    { name: "codex", enabled: false },
    { name: "grok", enabled: false },
    { name: "droid", enabled: false },
    { name: "claude", role: "main", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
    { name: "qwen", report: "whole", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
  ] }));

  const result = await run(process.execPath, [
    path.resolve("bin/jury.js"), "review", "--rounds", "1", "--web=false", "--push=false",
    "--judge", "claude", "--dir", repo, "--trunk", "master", "--reviewer", "qwen",
  ], { cwd: repo });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /qwen\s+.*clean/);

  const [slug] = await readdir(path.join(repo, "runs"));
  const events = await readEvents(path.join(repo, "runs", slug));
  assert.deepEqual(events.filter((e) => e.t === "agent.launch").map((e) => e.agent), ["qwen"],
    "the named opt-in agent must be the one that ran");
  await rm(repo, { recursive: true, force: true });
});
