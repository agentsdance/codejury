import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { waitForOpenReceipt } from "./helpers/open-receipt.js";
import { writeRun } from "../lib/store.js";

const exec = promisify(execFile);
test("default web opens a URL selecting the current run, even on a fallback port", { timeout: 30000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jury-web-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo); await mkdir(bin);
  const git = (...args) => exec("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("commit", "--allow-empty", "-qm", "base");
  await git("checkout", "-qb", "feature");
  await writeRun(path.join(repo, "runs", "old-review"), {
    target: { state: "human", id: "#26", attempt: "20200101-0000" }, rounds: [], exchanges: [],
  });
  const receipt = path.join(root, "opened.json");
  // Capture the actual browser-open request and its first API response.
  const opener = `#!${process.execPath}\nconst fs = require('node:fs');\nfetch(new URL('/api/run', process.argv[2])).then(r => r.json()).then(payload => fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({url: process.argv[2], payload})));\n`;
  await writeFile(path.join(bin, process.platform === "darwin" ? "open" : "xdg-open"), opener, { mode: 0o755 });
  const occupied = net.createServer();
  occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port;
  const child = spawn(process.execPath, [path.resolve("bin/jury.js"), "review", "--dir", repo,
    "--trunk", "main", "--rounds", "1", "--dry-run", "--agents", "claude", "--port", String(port)],
    { cwd: repo, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => { output += b; });
  child.stderr.on("data", b => { output += b; });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  const opened = await waitForOpenReceipt(receipt);
  assert.ok(opened, output);
  const url = new URL(opened.url);
  assert.notEqual(Number(url.port), port);
  const slug = url.searchParams.get("run");
  assert.ok(slug);
  assert.notEqual(slug, "old-review");
  const runs = opened.payload.targets ?? [opened.payload];
  assert.equal(runs[0].slug, "old-review", "older human run still sorts first, exercising the original failure");
  // The round may have published by the time the separate opener fetches.
  // The unit test below checks pre-serve publication deterministically.
  assert.ok(runs.some(r => r.slug === slug), "opened URL must select a run available in the API response");
  assert.equal(runs.find(r => r.slug === slug).target.judge, "codex");
  assert.ok(output.includes(opened.url));
});

test("current run is published before the console server starts", async (t) => {
  const { startReviewConsole } = await import("../lib/review-console.js");
  const { readRun } = await import("../lib/store.js");
  const root = await mkdtemp(path.join(tmpdir(), "jury-console-order-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "runs", "current-review");
  const url = await startReviewConsole({ dir, cwd: root, port: 3080,
    target: { id: "#35", state: "review", judge: "codex" } }, async (options) => {
    const saved = await readRun(dir);
    assert.equal(saved.target.id, "#35");
    assert.equal(saved.target.stateNote, "starting review");
    assert.equal(options.cwd, root);
    return { url: "http://127.0.0.1:3081" };
  });
  assert.equal(url, "http://127.0.0.1:3081/?run=current-review");
});
