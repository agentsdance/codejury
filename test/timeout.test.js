import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, writeFileSync } from "node:fs";
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
      const timer = original(() => {
        if (!ready() && Date.now() - started < 5000) { timer.refresh(); return; }
        fn(...args);
      }, 400);
      return timer;
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

// Delayed variants simulate startup taking longer than the shortened deadline.
for (const startupDelay of [0, 600]) {
  test(`output and even a stop token cannot extend the deadline or approve a timed-out review (${startupDelay} ms startup)`, async t => {
    const chunks = [];
    shortTimers(t, () => chunks.join("").includes("still working\n"));
    const result = await runAgent(fake(`
      setTimeout(() => {
        console.log("NO NEW FINDINGS");
        console.error("partial diagnostic");
        setInterval(() => console.log("still working"), 20);
      }, ${startupDelay});
    `), { ...options, timeoutSeconds: 1200, onChunk: chunk => chunks.push(chunk) });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.timeoutSeconds, 1200, "an explicit override is preserved");
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
}

for (const verboseStream of ["stdout", "stderr"]) {
  test(`timed-out reports keep the message and a bounded tail of verbose ${verboseStream}`, async t => {
    let streamed = "";
    const ready = "output-ready\n";
    shortTimers(t, () => streamed.endsWith(ready));
    const stdoutSize = verboseStream === "stdout" ? 1024 * 1024 : 32;
    const stderrSize = verboseStream === "stderr" ? 1024 * 1024 : 32;
    const stdout = `stdout-start\n${"o".repeat(stdoutSize)}\nstdout-tail\n${ready}`;
    const stderr = `stderr-start\n${"e".repeat(stderrSize)}\nstderr-tail\n`;
    const result = await runAgent(fake(`
      process.stderr.write("stderr-start\\n" + "e".repeat(${stderrSize}) + "\\nstderr-tail\\n", () => {
        process.stdout.write("stdout-start\\n" + "o".repeat(${stdoutSize}) + "\\nstdout-tail\\n${ready.trim()}\\n");
      });
      setInterval(() => {}, 1000);
    `, { report: "tail" }), { ...options, onChunk: chunk => { streamed += chunk; } });
    const prefix = "Timed out after 10 minutes\n\n";
    assert.equal(result.timedOut, true);
    assert.equal(result.raw, stdout, "the raw stdout transcript must remain complete");
    assert.ok(result.report.length <= prefix.length + 4000,
      `timeout report must be bounded, got ${result.report.length} characters`);
    assert.equal(result.report, prefix + `${stdout.trim()}\n\n${stderr.trim()}`.slice(-4000));
  });
}

test("SIGKILL drains stdout and stderr written just before the kill", {
  skip: process.platform === "win32",
}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-kill-output-"));
  const trigger = path.join(dir, "write");
  const written = path.join(dir, "written");
  const chunks = [];
  let pid;
  const kill = process.kill.bind(process);
  t.after(async () => {
    if (pid) { try { kill(-pid, "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  });
  shortTimers(t, () => Boolean(pid));
  let killed = false;
  t.mock.method(process, "kill", (target, signal) => {
    if (target === -pid && signal === "SIGKILL" && !killed) {
      killed = true;
      // Hold the parent's event loop until both real pipe writes complete.
      // These bytes cannot reach the data callbacks before the kill returns.
      writeFileSync(trigger, "");
      const started = Date.now();
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(written) && Date.now() - started < 5000) {
        Atomics.wait(sleeper, 0, 0, 10);
      }
    }
    return kill(target, signal);
  });
  const result = await runAgent(fake(`
    const { existsSync, writeFileSync, writeSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    console.log("pid=" + process.pid);
    const poll = setInterval(() => {
      if (!existsSync(${JSON.stringify(trigger)})) return;
      clearInterval(poll);
      writeSync(1, "last stdout diagnostic\\n");
      writeSync(2, "last stderr diagnostic\\n");
      writeFileSync(${JSON.stringify(written)}, "");
    }, 5);
    setInterval(() => {}, 1000);
  `), { ...options, onChunk: chunk => {
    chunks.push(chunk);
    pid = Number(chunks.join("").match(/pid=(\d+)\n/)?.[1]) || undefined;
  } });
  assert.ok(killed, "the reviewer must reach SIGKILL");
  assert.ok(existsSync(written), "both pipe writes must complete before SIGKILL");
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.match(result.raw, /last stdout diagnostic\n/);
  assert.match(result.report, /last stderr diagnostic/);
  assert.equal(chunks.join(""), result.raw);
  const count = chunks.length;
  await delay(150);
  assert.equal(chunks.length, count, "no output callbacks after settlement");
});

test("SIGKILL drain wait is bounded when a detached descendant holds the pipes", {
  skip: process.platform === "win32", timeout: 10000,
}, async t => {
  let output = "";
  let pid;
  let escaped;
  let timedOutAt;
  t.after(() => {
    for (const target of [pid, escaped]) {
      if (target) { try { process.kill(-target, "SIGKILL"); } catch {} }
    }
  });
  shortTimers(t, () => Boolean(pid && escaped));
  const result = await runAgent(fake(`
    process.on("SIGTERM", () => {});
    console.log("pid=" + process.pid);
    require("node:child_process").spawn(process.execPath, ["-e", \`
      console.log("escaped=" + process.pid);
      setInterval(() => {}, 1000);
    \`], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    setInterval(() => {}, 1000);
  `), { ...options, onTimeout: () => { timedOutAt = performance.now(); }, onChunk: chunk => {
    output += chunk;
    pid = Number(output.match(/pid=(\d+)\n/)?.[1]) || undefined;
    escaped = Number(output.match(/escaped=(\d+)\n/)?.[1]) || undefined;
  } });
  assert.ok(pid && escaped, "both fixture processes must start");
  assert.doesNotThrow(() => process.kill(escaped, 0), "the detached descendant still holds the pipes");
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.raw, output);
  assert.ok(performance.now() - timedOutAt < 2000, "open pipes must not block timeout settlement");
});

for (const parentIgnores of [false, true]) {
  for (const startupDelay of [0, 600]) {
    test(`timeout kills descendants that ignore SIGTERM (${parentIgnores ? "stubborn" : "exiting"} parent, ${startupDelay} ms tool startup)`,
      { skip: process.platform === "win32" }, async t => {
        let pids = [];
        let output = "";
        let timedOutAt;
        shortTimers(t, () => pids.length === 2);
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
            setTimeout(() => {
              process.on("SIGTERM", () => {});
              console.log("pid=" + process.pid);
              setInterval(() => {}, 1000);
            }, ${startupDelay});
          \`], { stdio: ["ignore", "pipe", "ignore"] });
          child.stdout.on("data", chunk => process.stdout.write(chunk));
          setInterval(() => {}, 1000);
        `), { ...options, onTimeout: () => { timedOutAt = performance.now(); }, onChunk: chunk => {
          output += chunk;
          pids = [...output.matchAll(/pid=(\d+)\n/g)].map(match => Number(match[1]));
        } });
        const shutdownMs = performance.now() - timedOutAt;
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
        assert.ok(shutdownMs < 2000, "termination must have a bounded grace period");
      });
  }
}

for (const exitCode of [0, 1]) {
  test(`reviewer exit ${exitCode} kills background descendants without a timeout`, {
    skip: process.platform === "win32", timeout: 15000,
  }, async t => {
    let output = "";
    let pids = [];
    t.after(() => {
      if (pids[0]) { try { process.kill(-pids[0], "SIGKILL"); } catch {} }
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    });
    const onTimeout = t.mock.fn();
    const result = await runAgent(fake(`
      const { spawn } = require("node:child_process");
      console.log("pid=" + process.pid);
      const child = spawn(process.execPath, ["-e", \`
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
        process.send("ready");
      \`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.once("message", () => {
        console.log("pid=" + child.pid);
        console.log("NO NEW FINDINGS");
        child.disconnect();
        child.unref();
        process.exitCode = ${exitCode};
      });
    `), { ...options, timeoutSeconds: 5, onTimeout, onChunk: chunk => {
      output += chunk;
      pids = [...output.matchAll(/pid=(\d+)\n/g)].map(match => Number(match[1]));
    } });
    assert.equal(pids.length, 2, "the reviewer must wait for its background tool to start");
    assert.equal(result.ok, exitCode === 0);
    assert.equal(result.verdict, exitCode === 0 ? "clean" : "error");
    assert.equal(result.timedOut, undefined);
    assert.equal(onTimeout.mock.callCount(), 0);
    if (exitCode !== 0) assert.match(result.report, /exited 1/);
    const descendant = pids[1];
    // Signal delivery and orphan reaping can lag runAgent's settlement.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(descendant, 0); } catch { break; }
      await delay(10);
    }
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" },
      `background tool ${descendant} survived reviewer exit ${exitCode}`);
  });
}

for (const startupMs of [0, 600]) {
  test(`normal completion and spawn errors clear the deadline without a timeout status (${startupMs} ms startup)`, async t => {
    // Let the shortened deadlines fire only after both results so slow CI can
    // exercise normal completion. An uncleared timer will then fire below.
    let settled = false;
    shortTimers(t, () => settled);
    const onTimeout = t.mock.fn();
    const runOptions = { ...options, onTimeout };
    const good = await runAgent(fake(`setTimeout(() => console.log('NO NEW FINDINGS'), ${startupMs})`), runOptions);
    const bad = await runAgent({ ...fake(""), argv: ["/jury-test-missing-agent"] }, runOptions);
    settled = true;
    assert.equal(good.verdict, "clean");
    assert.equal(good.timedOut, undefined);
    assert.equal(bad.verdict, "error");
    assert.equal(bad.timedOut, undefined);
    await delay(500);
    assert.equal(onTimeout.mock.callCount(), 0, "neither settled review may fire its deadline callback");
  });
}

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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
  test(`interrupting Jury with ${signal} also terminates its isolated reviewer groups`,
    { skip: process.platform === "win32" }, async t => {
      const source = new URL("../lib/agents.js", import.meta.url).href;
      const reviewer = fake(`
        console.log("pid=" + process.pid);
        require("node:child_process").spawn(process.execPath, ["-e",
          "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"
        ], { stdio: "inherit" });
        setInterval(() => {}, 1000);
      `);
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { runAgent } from ${JSON.stringify(source)};
        await runAgent(${JSON.stringify(reviewer)}, {
          ...${JSON.stringify(options)}, onChunk: chunk => process.stdout.write(chunk),
        });
      `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const exited = once(child, "exit");
      let pids = [];
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk;
        pids = [...output.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
      });
      t.after(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        for (const pid of pids) {
          try { process.kill(-pid, "SIGKILL"); } catch {}
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      });
      for (let i = 0; pids.length < 2 && i < 500; i++) await delay(10);
      assert.equal(pids.length, 2, "fixture reviewer and its tool must start");
      process.kill(-child.pid, signal);
      assert.deepEqual(await exited, [null, signal], "preserve Jury's signal exit");
      const alive = pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      for (let i = 0; pids.some(alive) && i < 100; i++) await delay(10);
      assert.deepEqual(pids.filter(alive), [], `reviewer and tool must not survive ${signal}`);
    });
}

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
  const readyFile = path.join(repo, "reviewer-ready");
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    { ...fake(`setTimeout(() => {
        // stderr preserves a diagnostic without making the stdout heartbeat
        // quiet-period filter hide a missing onTimeout clearInterval.
        process.on("SIGTERM", () => console.error("partial review"));
        require("node:fs").writeFileSync(process.env.JURY_TEST_READY, "");
        setInterval(() => {}, 1000);
      }, 1200)`),
      env: { JURY_TEST_READY: readyFile }, enabled: true, role: "reviewer" },
    { ...fake("console.log('NO NEW FINDINGS')"), name: "peer", role: "reviewer" },
    { ...fake("console.log('NO NEW FINDINGS')"), name: "fake-judge", role: "main" },
  ] }));
  const clock = path.join(repo, "short-clock.mjs");
  const deadlineFile = path.join(repo, "deadline.txt");
  const heartbeatFile = path.join(repo, "heartbeat-callbacks.ndjson");
  // Simulate a loaded CI machine: the fake reviewer deliberately starts later
  // than our shortened clock. Advance the deadline only after its handler is
  // installed, so this tests shutdown output rather than OS scheduling speed.
  await writeFile(clock, `
    import { existsSync, writeFileSync, appendFileSync, promises as fs } from "node:fs";
    import { AsyncLocalStorage } from "node:async_hooks";
    import { syncBuiltinESMExports } from "node:module";
    const later = globalThis.setTimeout;
    const every = globalThis.setInterval;
    const heartbeat = new AsyncLocalStorage();
    const mkdir = fs.mkdir;
    const append = fs.appendFile;
    // A heartbeat that starts before the deadline can finish its asynchronous
    // mkdir afterward. Preserve callback timing independently of write timing.
    fs.mkdir = async (...args) => {
      await new Promise(resolve => later(resolve, 75));
      return mkdir(...args);
    };
    fs.appendFile = (file, data, ...args) => {
      if (String(file).endsWith("events.ndjson")) {
        const event = JSON.parse(data);
        if (event.t === "agent.alive" && event.agent === "trae") {
          appendFileSync(${JSON.stringify(heartbeatFile)}, JSON.stringify(heartbeat.getStore() ?? null) + "\\n");
        }
      }
      return append(file, data, ...args);
    };
    syncBuiltinESMExports();
    globalThis.setTimeout = (fn, ms, ...args) => {
      const started = Date.now();
      const timer = later(() => {
        if (ms >= 600000 && !existsSync(${JSON.stringify(readyFile)}) && Date.now() - started < 5000) {
          timer.refresh();
          return;
        }
        if (ms >= 600000) writeFileSync(${JSON.stringify(deadlineFile)}, String(Date.now()));
        fn(...args);
      }, ms >= 600000 ? 1000 : ms === 5000 ? 200 : ms);
      return timer;
    };
    globalThis.setInterval = (fn, ms, ...args) => ms === 5000
      ? every(() => heartbeat.run({
          afterDeadline: existsSync(${JSON.stringify(deadlineFile)}),
        }, fn, ...args), 50)
      : every(fn, ms, ...args);
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
  assert.match(timeout.report, /partial review/);
  assert.equal(await readFile(path.join(dir, timeout.rawFile), "utf8"), "");
  assert.equal(reports.find(e => e.agent === "peer").verdict, "clean");
  const beats = events.filter(e => e.t === "agent.alive" && e.agent === "trae");
  assert.ok(beats.length, "a silent reviewer must have heartbeats before the deadline");
  const callbacks = (await readFile(heartbeatFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(callbacks.length, beats.length, "every saved heartbeat must have callback evidence");
  assert.ok(callbacks.every(sample => sample?.afterDeadline === false),
    "no heartbeat callbacks during timeout shutdown, regardless of delayed event writes");
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
