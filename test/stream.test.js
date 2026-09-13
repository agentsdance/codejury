// Streaming a reviewer's output. Run with `node --test`.
//
// The property: a reviewer that takes twenty minutes must be readable during
// those twenty minutes, not only after. Before this, stdout accumulated in a
// string and nothing reached disk until close — "still thinking" and "wedged"
// looked identical to anyone watching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openArtifact } from "../lib/store.js";
import { runAgent } from "../lib/agents.js";

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-stream-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("chunks are readable before the writer is closed", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const sink = await openArtifact(dir, "round-1.codex.stdout.txt");
    await sink.write("first line\n");
    // Deliberately read while the handle is still open.
    assert.equal(await readFile(path.join(dir, "round-1.codex.stdout.txt"), "utf8"), "first line\n");
    await sink.write("second line\n");
    assert.match(await readFile(path.join(dir, "round-1.codex.stdout.txt"), "utf8"), /second line/);
    await sink.close();
  } finally {
    await cleanup();
  }
});

test("interleaved writes keep their order", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const sink = await openArtifact(dir, "out.txt");
    // Not awaited individually: fs handles do not queue concurrent writes, so
    // without an internal chain these would interleave or drop.
    for (let i = 0; i < 50; i++) sink.write(`${i}\n`);
    await sink.close();
    const body = await readFile(path.join(dir, "out.txt"), "utf8");
    assert.deepEqual(body.trim().split("\n"), Array.from({ length: 50 }, (_, i) => String(i)));
  } finally {
    await cleanup();
  }
});

test("writing after close is a no-op rather than a crash", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const sink = await openArtifact(dir, "out.txt");
    await sink.write("kept\n");
    await sink.close();
    await sink.write("dropped\n");   // a late chunk must not throw on a closed handle
    await sink.close();              // and closing twice must be safe
    assert.equal(await readFile(path.join(dir, "out.txt"), "utf8"), "kept\n");
  } finally {
    await cleanup();
  }
});

test("runAgent hands each chunk to onChunk as it arrives", async () => {
  // Every assertion here used to run after `await runAgent(...)` returned,
  // which an implementation that buffered all stdout and called onChunk once at
  // exit would satisfy — the test would pass with streaming removed entirely.
  // The proof has to happen DURING the run: AAA must be in hand before the
  // child has even written BBB.
  const chunks = [];
  const sawAAA = Promise.withResolvers
    ? Promise.withResolvers()
    : (() => { let r; const p = new Promise((res) => (r = res)); return { promise: p, resolve: r }; })();

  // The child writes AAA, waits, then writes BBB only after it sees a signal
  // that AAA was already delivered. If runAgent buffers, that signal never
  // arrives, the child exits on its timeout having written nothing more, and
  // BBB is missing — the test fails rather than passing on a technicality.
  const agent = {
    name: "fake",
    argv: ["node", "-e", `
      process.stdout.write("AAA\\n");
      const started = Date.now();
      const tick = setInterval(() => {
        if (require("fs").existsSync(process.env.MACR_TEST_FLAG)) {
          clearInterval(tick);
          process.stdout.write("BBB\\n");
        } else if (Date.now() - started > 4000) {
          clearInterval(tick); // gave up: nothing acknowledged AAA
        }
      }, 20);
    `],
    cwd: "flag",
    report: "whole",
    expectSeconds: 5,
  };

  const { dir, cleanup } = await scratch();
  const flag = path.join(dir, "aaa-was-delivered");
  process.env.MACR_TEST_FLAG = flag;
  try {
    const r = await runAgent(agent, {
      worktree: process.cwd(), prompt: "unused", stopToken: "NO NEW FINDINGS",
      onChunk: (c) => {
        chunks.push(c);
        // Touch the flag the moment AAA reaches us, while the child is still
        // running. This is the assertion: it can only happen mid-run.
        if (c.includes("AAA") && !existsSync(flag)) {
          writeFileSync(flag, "");
          sawAAA.resolve(chunks.length);
        }
      },
    });

    const streamed = chunks.join("");
    assert.match(streamed, /AAA/);
    assert.match(streamed, /BBB/,
      "BBB is only written after AAA was acknowledged mid-run; missing means nothing streamed");
    assert.ok(chunks.length >= 2, `expected separate chunks, got ${chunks.length}`);
    // AAA must have arrived in an earlier callback than BBB, not together.
    assert.ok(chunks.findIndex((c) => c.includes("AAA")) < chunks.findIndex((c) => c.includes("BBB")),
      "AAA and BBB arrived in the same callback — that is buffering, not streaming");
    // What was streamed must match what the final buffer reports, or the console
    // would show something the record does not.
    assert.equal(streamed, r.raw);
  } finally {
    delete process.env.MACR_TEST_FLAG;
    await cleanup();
  }
});

test("a dry run streams nothing and still returns a report", async () => {
  const chunks = [];
  const r = await runAgent(
    { name: "fake", argv: ["true"], cwd: "flag", report: "whole" },
    { worktree: process.cwd(), prompt: "x", stopToken: "NO NEW FINDINGS", dryRun: true,
      onChunk: (c) => chunks.push(c) },
  );
  assert.equal(chunks.length, 0);
  assert.equal(r.verdict, "clean");
});
