// Streaming a reviewer's output. Run with `node --test`.
//
// The property: a reviewer that takes twenty minutes must be readable during
// those twenty minutes, not only after. Before this, stdout accumulated in a
// string and nothing reached disk until close — "still thinking" and "wedged"
// looked identical to anyone watching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openArtifact } from "../lib/store.js";
import { runAgent } from "../lib/agents.js";

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "macr-stream-"));
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
  const chunks = [];
  const agent = {
    name: "fake",
    // Emits, pauses, emits again: one chunk would pass even without streaming.
    argv: ["node", "-e", "process.stdout.write('AAA\\n'); setTimeout(()=>process.stdout.write('BBB\\n'), 60)"],
    cwd: "flag",
    report: "whole",
    expectSeconds: 5,
  };
  const r = await runAgent(agent, {
    worktree: process.cwd(), prompt: "unused", stopToken: "NO NEW FINDINGS",
    onChunk: (c) => chunks.push(c),
  });
  assert.ok(chunks.length >= 1, "onChunk was never called");
  const streamed = chunks.join("");
  assert.match(streamed, /AAA/);
  assert.match(streamed, /BBB/);
  // What was streamed must match what the final buffer reports, or the console
  // would show something the record does not.
  assert.equal(streamed, r.raw);
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
