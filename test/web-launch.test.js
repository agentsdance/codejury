import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { waitForOpenReceipt } from "./helpers/open-receipt.js";
import { cleanupStack } from "./helpers/cleanup-stack.js";
import { writeRun } from "../lib/store.js";

const exec = promisify(execFile);

// These success cases need room above the occupied port for normal fallback.
// Exhaustion at 65535 is checked deterministically in server-port.test.js.
async function reserveFallbackPort(cleanup) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reserved = net.createServer();
    cleanup(async () => {
      if (reserved.listening) await new Promise(resolve => reserved.close(resolve));
    });
    reserved.listen(0, "127.0.0.1");
    await once(reserved, "listening");
    const port = reserved.address().port;
    if (port <= 65515) return port;
    await new Promise(resolve => reserved.close(resolve));
  }
  throw new Error("Could not reserve an occupied port with fallback headroom");
}

// Observe the CLI-to-listener handoff without replacing real socket behavior.
async function listenProbe(root) {
  const file = path.join(root, "listen-attempts.jsonl");
  const module = path.join(root, "listen-probe.cjs");
  await writeFile(module, `
const { appendFileSync } = require("node:fs");
const { Server } = require("node:net");
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  appendFileSync(${JSON.stringify(file)}, JSON.stringify(args[0]) + "\\n");
  return Reflect.apply(listen, this, args);
};
`);
  return { module, firstPort: async () => JSON.parse((await readFile(file, "utf8")).split("\n")[0]) };
}

test("web-only reports an occupied maximum port without attempting an invalid port", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "jury-port-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempts = path.join(root, "attempts.jsonl");
  const module = path.join(root, "occupied-port.cjs");
  await writeFile(module, `
const { appendFileSync } = require("node:fs");
const { Server } = require("node:net");
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(args[0]) + "\\n");
  if (args[0] === 65535) {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("listen EADDRINUSE: occupied port 65535"), { code: "EADDRINUSE" })));
    return this;
  }
  return Reflect.apply(listen, this, args);
};
`);
  await assert.rejects(exec(process.execPath, ["--require", module,
    process.env.JURY_TEST_CLI ?? path.resolve("bin/jury.js"), "--web-only", "--dir", root, "--port", "65535"],
  { timeout: 5000 }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /jury: listen EADDRINUSE: occupied port 65535/);
    assert.doesNotMatch(error.stderr, /ERR_SOCKET_BAD_PORT|RangeError/);
    assert.doesNotMatch(error.stdout, /console:/);
    return true;
  });
  assert.deepEqual((await readFile(attempts, "utf8")).trim().split("\n").map(JSON.parse), [65535]);
});

for (const automaticPort of [false, true]) {
test(`default web opens the current run on ${automaticPort ? "an OS-assigned" : "a fallback"} port`, { timeout: 30000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jury-web-test-"));
  const cleanup = cleanupStack(t);
  cleanup(() => rm(root, { recursive: true, force: true }));
  const listening = await listenProbe(root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo); await mkdir(bin);
  const git = (...args) => exec("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("commit", "--allow-empty", "-qm", "base");
  await git("update-ref", "refs/remotes/origin/main", "HEAD");
  await git("checkout", "-qb", "feature");
  await writeRun(path.join(repo, "runs", "old-review"), {
    target: { state: "human", id: "#26", attempt: "20200101-0000" }, rounds: [], exchanges: [],
  });
  const receipt = path.join(root, "opened.json");
  // Capture the actual browser-open request and its first API response.
  const opener = `#!${process.execPath}\nconst fs = require('node:fs');\nfetch(new URL('/api/run', process.argv[2])).then(r => r.json()).then(payload => fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({url: process.argv[2], payload})));\n`;
  await writeFile(path.join(bin, process.platform === "darwin" ? "open" : "xdg-open"), opener, { mode: 0o755 });
  let port = 0;
  if (!automaticPort) {
    port = await reserveFallbackPort(cleanup);
  }
  const child = spawn(process.execPath, ["--require", listening.module, process.env.JURY_TEST_CLI ?? path.resolve("bin/jury.js"), "review", "--dir", repo,
    "--trunk", "main", "--rounds", "1", "--dry-run", "--agents", "claude", "--port", String(port)],
    { cwd: repo, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => { output += b; });
  child.stderr.on("data", b => { output += b; });
  const exited = once(child, "exit");
  cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  const opened = await waitForOpenReceipt(receipt);
  assert.ok(opened, output);
  assert.equal(await listening.firstPort(), port, "the CLI must pass the requested port unchanged to the listener");
  const url = new URL(opened.url);
  if (automaticPort) assert.ok(Number(url.port) > 0, "browser URL must use the OS-assigned port");
  // Neighbors may also be occupied. Exact retry order is tested without sockets.
  else assert.ok(Number(url.port) > port && Number(url.port) <= port + 20,
    "an occupied port must fall back within the retry range");
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
}

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

for (const automaticPort of [false, true]) {
test(`web-only opens a saved run on ${automaticPort ? "an OS-assigned" : "a fallback"} port without starting a review`, { timeout: 15000, skip: process.platform === "win32" }, async t => {
  const { appendEvent, readEvents } = await import("../lib/store.js");
  const root = await mkdtemp(path.join(tmpdir(), "jury-saved-console-"));
  const cleanup = cleanupStack(t);
  cleanup(() => rm(root, { recursive: true, force: true }));
  const listening = await listenProbe(root);
  const dir = path.join(root, "runs", "saved");
  const target = { id: "#1", state: "converged" };
  await appendEvent(dir, { t: "target", target });
  await writeRun(dir, { target, rounds: [], exchanges: [] });
  const bin = path.join(root, "bin"); await mkdir(bin);
  const receipt = path.join(root, "opened.json");
  await writeFile(path.join(bin, process.platform === "darwin" ? "open" : "xdg-open"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({url:process.argv[2]}));\n`, { mode: 0o755 });
  let port = 0;
  if (!automaticPort) {
    port = await reserveFallbackPort(cleanup);
  }
  const child = spawn(process.execPath, ["--require", listening.module, process.env.JURY_TEST_CLI ?? path.resolve("bin/jury.js"), "--web-only",
    "--dir", root, "--run", "saved", "--port", String(port)],
    { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stderr.on("data", b => output += b);
  const exited = once(child, "exit");
  cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  const opened = await waitForOpenReceipt(receipt);
  assert.ok(opened, output);
  assert.equal(await listening.firstPort(), port, "the CLI must pass the requested port unchanged to the listener");
  const openedPort = Number(new URL(opened.url).port);
  assert.ok(openedPort > 0, "browser URL must use the listening port");
  if (!automaticPort) assert.ok(openedPort > port && openedPort <= port + 20,
    "an occupied port must fall back within the retry range");
  assert.equal(new URL(opened.url).searchParams.get("run"), "saved");
  const response = await fetch(new URL("/api/run", opened.url));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok((payload.targets ?? [payload]).some(r => r.slug === "saved"));
  assert.equal((await readEvents(dir)).length, 1, "viewing must not append a round or launch agents");
});
}
