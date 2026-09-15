import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendEvent, readEvents } from "../lib/store.js";

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL("../bin/jury.js", import.meta.url).pathname;

test("review and reply combine reviewer aliases without launching duplicate or unselected agents", async t => {
  const repo = await mkdtemp(path.join(tmpdir(), "jury-selection-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => exec("git", ["-C", repo, ...args]);
  const invoke = args => exec(process.execPath, [cli, ...args], { cwd: repo });
  await git("init", "-q", "-b", "master");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.com");
  await writeFile(path.join(repo, "a.txt"), "before\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "feature");
  await writeFile(path.join(repo, "a.txt"), "after\n");
  await git("commit", "-qam", "change");
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    ...["codex", "claude", "grok", "droid", "agy"].map(name => ({ name, enabled: false })),
    ...["judge", "alpha", "beta", "unselected"].map(name => ({
      name, role: name === "judge" ? "main" : "reviewer", cwd: "worktree", report: "whole",
      argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"],
    })),
  ] }));

  const review = await invoke(["review", "--dir", repo, "--trunk", "master", "--rounds", "1",
    "--web=false", "--push=false", "--reviewer", " alpha, ", "--jury", "beta,alpha", "--jury", "beta"]);
  assert.match(review.stdout, /REVIEW COMPLETE/);
  const [slug] = await readdir(path.join(repo, "runs"));
  const dir = path.join(repo, "runs", slug);
  let events = await readEvents(dir);
  assert.deepEqual(events.filter(e => e.t === "agent.launch").map(e => e.agent).sort(), ["alpha", "beta"]);
  assert.equal(events.filter(e => e.t === "target").at(-1).target.judge, "judge");

  for (const agent of ["alpha", "beta"]) {
    await appendEvent(dir, { t: "finding.raised", id: `${agent}-selection`, round: 1, agent, claim: `${agent} claim` });
    await appendEvent(dir, { t: "finding.resolved", id: `${agent}-selection`, verdict: "rejected", reason: "Fixture verdict" });
  }
  await invoke(["reply", "--dir", repo, "--run", slug, "--reviewer", "alpha,", "--jury", "alpha"]);
  events = await readEvents(dir);
  assert.deepEqual(events.filter(e => e.t === "reply.answered").map(e => e.agent), ["alpha"]);

  for (const command of ["review", "reply"]) {
    for (const flag of ["--reviewer", "--jury"]) {
      const args = command === "review"
        ? ["--trunk", "master", "--web=false", "--push=false"] : ["--run", slug];
      await assert.rejects(invoke([command, "--dir", repo, ...args, `${flag}= , `]),
        error => error.code === 1 && /--reviewer needs at least one reviewer name/.test(error.stderr));
    }
  }
  assert.deepEqual(await readEvents(dir), events, "invalid selections must not append agent or reply events");
});
