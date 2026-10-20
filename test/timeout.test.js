import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "../lib/agents.js";
import { readEvents, readRun } from "../lib/store.js";
import { conversation } from "../lib/loop.js";
import { testEnvironment } from "../scripts/test-environment.mjs";

const options = { worktree: process.cwd(), prompt: "unused", stopToken: "NO NEW FINDINGS" };
const fake = (script, extra = {}) => ({
  name: "trae", argv: [process.execPath, "-e", script],
  cwd: "worktree", report: "whole", expectSeconds: 900, ...extra,
});

// Keep real child processes and IO, shortening only the long production timers.
function shortTimers(t, ready = () => true) {
  const original = globalThis.setTimeout;
  const deadlines = [];
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms >= 600_000) deadlines.push(ms);
    if (ms >= 600_000) {
      const started = Date.now();
      const fire = () => {
        if (!ready() && Date.now() - started < 5000) return original(fire, 10);
        fn(...args);
      };
      return original(fire, 400);
    }
    return original(fn, ms === 5000 ? 100 : ms, ...args);
  });
  return deadlines;
}

test("silent TRAE defaults to a hard ten-minute deadline and records the timeout", async t => {
  const deadlines = shortTimers(t);
  const result = await runAgent(fake("setInterval(() => {}, 1000)"), options);
  assert.deepEqual(deadlines, [600_000], "expectSeconds must not extend the default deadline");
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "error");
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSeconds, 600);
  assert.match(result.report, /^Timed out after 10 minutes/);
  assert.ok(result.seconds >= 0.3);
});

test("output and even a stop token cannot extend the deadline or approve a timed-out review", async t => {
  shortTimers(t);
  const chunks = [];
  const result = await runAgent(fake(`
    console.log("NO NEW FINDINGS");
    console.error("partial diagnostic");
    setInterval(() => console.log("still working"), 20);
  `), { ...options, timeoutSeconds: 0.3, onChunk: chunk => chunks.push(chunk) });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSeconds, 0.3, "an explicit override is preserved");
  assert.equal(result.verdict, "error");
  assert.deepEqual(result.findings, []);
  assert.match(result.raw, /NO NEW FINDINGS/);
  assert.match(result.raw, /still working/);
  assert.match(result.report, /partial diagnostic/);
  assert.equal(chunks.join(""), result.raw);
  const count = chunks.length;
  await delay(150);
  assert.equal(chunks.length, count, "no output callbacks after the result has settled");
});

for (const parentIgnores of [false, true]) {
  test(`timeout kills descendants that ignore SIGTERM (${parentIgnores ? "stubborn" : "exiting"} parent)`,
    { skip: process.platform === "win32" }, async t => {
      shortTimers(t);
      const pids = [];
      t.after(() => {
        for (const pid of pids) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      });
      const result = await runAgent(fake(`
        const { spawn } = require("node:child_process");
        ${parentIgnores ? 'process.on("SIGTERM", () => console.log("ignored TERM"));' : ""}
        console.log("pid=" + process.pid);
        const child = spawn(process.execPath, ["-e", \`
          process.on("SIGTERM", () => {});
          console.log("pid=" + process.pid);
          setInterval(() => {}, 1000);
        \`], { stdio: ["ignore", "pipe", "ignore"] });
        child.stdout.on("data", chunk => process.stdout.write(chunk));
        setInterval(() => {}, 1000);
      `), { ...options, timeoutSeconds: 0.4, onChunk: chunk => {
        for (const match of chunk.matchAll(/pid=(\d+)/g)) pids.push(Number(match[1]));
      } });
      assert.equal(pids.length, 2, "both local fixture processes must start");
      // SIGKILL delivery and OS process reaping can lag the result slightly.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pids.every(pid => {
          try { process.kill(pid, 0); return false; } catch { return true; }
        })) break;
        await delay(10);
      }
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `process ${pid} survived timeout`);
      }
      assert.equal(result.timedOut, true);
      assert.equal(result.ok, false);
      assert.ok(result.seconds < 2, "termination must have a bounded grace period");
    });
}

test("normal completion and spawn errors clear the deadline without a timeout status", async t => {
  shortTimers(t);
  const good = await runAgent(fake("console.log('NO NEW FINDINGS')"), options);
  const bad = await runAgent({ ...fake(""), argv: ["/jury-test-missing-agent"] }, options);
  assert.equal(good.verdict, "clean");
  assert.equal(good.timedOut, undefined);
  assert.equal(bad.verdict, "error");
  assert.equal(bad.timedOut, undefined);
  await delay(500);
});

test("explicit longer limits still apply and a graceful zero exit cannot erase a timeout", async t => {
  let ready = false;
  const deadlines = shortTimers(t, () => ready);
  let notified = 0;
  const result = await runAgent(fake(`
    process.on("SIGTERM", () => { console.log("NO NEW FINDINGS"); process.exit(0); });
    console.log("ready");
    setInterval(() => {}, 1000);
  `), { ...options, timeoutSeconds: 1200, onTimeout: () => notified++,
    onChunk: chunk => { if (chunk.includes("ready")) ready = true; } });
  assert.deepEqual(deadlines, [1_200_000]);
  assert.equal(notified, 1);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSeconds, 1200);
  assert.match(result.report, /^Timed out after 20 minutes/);
  assert.match(result.raw, /NO NEW FINDINGS/);
});

test("interrupting Jury also terminates its isolated reviewer groups",
  { skip: process.platform === "win32" }, async t => {
    const source = new URL("../lib/agents.js", import.meta.url).href;
    const reviewer = fake("console.log('pid=' + process.pid); setInterval(() => {}, 1000)");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { runAgent } from ${JSON.stringify(source)};
      await runAgent(${JSON.stringify(reviewer)}, {
        ...${JSON.stringify(options)}, onChunk: chunk => process.stdout.write(chunk),
      });
    `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let pid;
    let output = "";
    child.stdout.on("data", chunk => {
      output += chunk;
      pid = Number(output.match(/pid=(\d+)/)?.[1]) || undefined;
    });
    t.after(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    });
    for (let i = 0; !pid && i < 500; i++) await delay(10);
    assert.ok(pid, "fixture reviewer must start");
    process.kill(-child.pid, "SIGTERM");
    assert.deepEqual(await exited, [null, "SIGTERM"], "preserve Jury's signal exit");
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(10);
    }
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });

test("CLI saves a timeout, stops its heartbeat, and retains the other reviewer's result", async t => {
  const repo = await mkdtemp(path.join(tmpdir(), "jury-timeout-"));
  const isolated = testEnvironment();
  t.after(async () => { isolated.dispose(); await rm(repo, { recursive: true, force: true }); });
  const exec = promisify(execFile);
  const env = { ...isolated.env };
  const git = (...args) => exec("git", args, { cwd: repo, env });
  await git("init", "-q", "-b", "master");
  await writeFile(path.join(repo, "a.txt"), "before\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "feature");
  await writeFile(path.join(repo, "a.txt"), "after\n");
  await git("commit", "-qam", "change");
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    { ...fake(`process.on("SIGTERM", () => console.log("partial review")); setInterval(() => {}, 1000)`),
      enabled: true, role: "reviewer" },
    { ...fake("console.log('NO NEW FINDINGS')"), name: "peer", role: "reviewer" },
    { ...fake("console.log('NO NEW FINDINGS')"), name: "fake-judge", role: "main" },
  ] }));
  const clock = path.join(repo, "short-clock.mjs");
  const deadlineFile = path.join(repo, "deadline.txt");
  await writeFile(clock, `
    import { writeFileSync } from "node:fs";
    const later = globalThis.setTimeout;
    const every = globalThis.setInterval;
    globalThis.setTimeout = (fn, ms, ...args) => later(() => {
      if (ms >= 600000) writeFileSync(${JSON.stringify(deadlineFile)}, String(Date.now()));
      fn(...args);
    }, ms >= 600000 ? 1000 : ms === 5000 ? 200 : ms);
    globalThis.setInterval = (fn, ms, ...args) => every(fn, ms === 5000 ? 50 : ms, ...args);
  `);
  const cli = process.env.JURY_TEST_CLI ?? path.resolve("bin/jury.js");
  const result = await exec(process.execPath, ["--import", clock, cli, "review",
    "--dir", repo, "--trunk", "master", "--judge", "fake-judge", "--agents", "trae,peer",
    "--rounds", "1", "--web=false", "--push=false"],
  { cwd: repo, env, timeout: 15000 }).catch(error => {
    if (error.killed) throw error;
    return error;
  });
  assert.match(result.stderr, /Review stopped: reviewers failed: trae/);
  assert.equal(result.code, 1, "an incomplete review must fail the CLI invocation");
  assert.match(result.stdout, /Timed out after 10 minutes/);
  assert.match(result.stdout, /trae\s+.*timed out/);
  assert.match(result.stdout, /REVIEW INCOMPLETE/);
  assert.doesNotMatch(result.stdout, /REVIEW COMPLETE/);
  const [slug] = await readdir(path.join(repo, "runs"));
  const dir = path.join(repo, "runs", slug);
  const events = await readEvents(dir);
  const reports = events.filter(e => e.t === "agent.report");
  assert.equal(reports.length, 2);
  const timeout = reports.find(e => e.agent === "trae");
  assert.equal(timeout.verdict, "error");
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.timeoutSeconds, 600);
  assert.match(timeout.report, /^Timed out after 10 minutes/);
  assert.match(await readFile(path.join(dir, timeout.rawFile), "utf8"), /partial review/);
  assert.equal(reports.find(e => e.agent === "peer").verdict, "clean");
  const deadline = Number(await readFile(deadlineFile, "utf8"));
  const beats = events.filter(e => e.t === "agent.alive" && e.agent === "trae");
  assert.ok(beats.length, "a silent reviewer must have heartbeats before the deadline");
  assert.ok(beats.every(e => Date.parse(e.ts) <= deadline), "no heartbeats during timeout shutdown");
  const run = await readRun(dir);
  assert.equal(run.target.state, "human");
  const saved = run.rounds[0].verdicts.find(v => v.a === "trae");
  assert.equal(saved.timedOut, true);
  assert.equal(saved.timeoutSeconds, 600);
  assert.equal(saved.t, "Timed out after 10 minutes");
  const turns = conversation(events).find(thread => thread.agent === "trae").turns;
  assert.equal(turns.some(turn => turn.kind === "waiting" || turn.kind === "streaming"), false);
  assert.match(turns.find(turn => turn.kind === "report").text, /Timed out after 10 minutes/);
});
