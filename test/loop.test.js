// The autonomous loop: what makes it terminate, and what it shows while it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readEvents, readArtifact } from "../lib/store.js";
import { MAX_TURNS, turnsFor, outstanding, deadlocked, conversation, refreshSettled, record } from "../lib/loop.js";
import { findingsIn } from "../lib/findings.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "macr-loop-"));

test("a finding is set down once it has been argued MAX_TURNS times", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "X1", round: 1, agent: "codex", claim: "c" });
  for (let i = 0; i < MAX_TURNS; i++) {
    assert.equal(deadlocked(await readEvents(dir), "X1"), i >= MAX_TURNS);
    await appendEvent(dir, { t: "finding.turn", id: "X1", who: "codex", text: "still wrong" });
  }
  const ev = await readEvents(dir);
  assert.equal(turnsFor(ev, "X1"), MAX_TURNS);
  assert.equal(deadlocked(ev, "X1"), true, "must stop arguing, or the run cannot end");
  await rm(dir, { recursive: true, force: true });
});

test("turn counting is per finding, so one contested claim cannot end another's argument", async () => {
  const dir = await tmp();
  for (const id of ["A", "B"]) {
    await appendEvent(dir, { t: "finding.raised", id, round: 1, agent: "codex", claim: id });
  }
  for (let i = 0; i < MAX_TURNS; i++) {
    await appendEvent(dir, { t: "finding.turn", id: "A", who: "codex", text: "no" });
  }
  const ev = await readEvents(dir);
  assert.equal(deadlocked(ev, "A"), true);
  assert.equal(deadlocked(ev, "B"), false);
  await rm(dir, { recursive: true, force: true });
});

test("an answered finding leaves the outstanding list; a contested one comes back", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "a" });
  await appendEvent(dir, { t: "finding.raised", id: "B", round: 1, agent: "codex", claim: "b" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "no" });

  let f = await findingsIn(dir);
  let ev = await readEvents(dir);
  assert.deepEqual(outstanding(f, ev).map((x) => x.id), ["B"], "answered findings are done");

  // The reviewer pushes back. This goes through the log and a refold, not by
  // setting the flag by hand: `contested` was read by outstanding() and written
  // by nothing, so a test that assigned it directly passed while the real path
  // could never re-open an argument.
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "codex", text: "still wrong" });
  f = await findingsIn(dir);
  ev = await readEvents(dir);
  assert.equal(f.get("A").contested, true, "a reviewer's rebuttal must survive the fold");
  assert.deepEqual(outstanding(f, ev).map((x) => x.id).sort(), ["A", "B"]);

  // Answering it again settles it, or one rebuttal would keep it open forever.
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "still no" });
  f = await findingsIn(dir);
  assert.equal(f.get("A").contested, false);
  assert.deepEqual(outstanding(f, await readEvents(dir)).map((x) => x.id), ["B"]);
  await rm(dir, { recursive: true, force: true });
});

test("the settled list is regenerated from the log, so a deferred finding is not re-raised", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "jitter is deletable", loc: "m.go:1" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "deferred", reason: "pre-existing" });
  const text = await refreshSettled(dir);
  assert.match(text, /jitter is deletable/);
  assert.match(text, /deferred/);
  // buildPrompt reads it off disk; nothing regenerated it before, which is why
  // every round carried an empty list and reviewers re-raised the same items.
  assert.match(await readArtifact(dir, "settled.md"), /jitter is deletable/);
  await rm(dir, { recursive: true, force: true });
});

test("the gate still refuses an acceptance the loop never demonstrated", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "a" });
  const findings = await findingsIn(dir);

  const bad = await record(dir, findings, "A", { verdict: "accepted", reason: "trust me" });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /reproduce/);
  assert.equal((await readEvents(dir)).filter((e) => e.t === "finding.resolved").length, 0,
    "a refused verdict must not reach the log");

  // Rejecting needs no reproduction — the point of the loop is that a third of
  // suggestions do not survive contact.
  assert.equal((await record(dir, findings, "A", { verdict: "rejected", reason: "misread" })).ok, true);
  await rm(dir, { recursive: true, force: true });
});

test("the conversation puts claude and the reviewer on their own sides, one thread each", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "a" });
  await appendEvent(dir, { t: "finding.raised", id: "B", round: 1, agent: "agy", claim: "b" });
  await appendEvent(dir, { t: "finding.reproduced", id: "A", evidence: "reproduced it" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "accepted", reason: "fixed", test: "t" });
  await appendEvent(dir, { t: "reply.sent", agent: "codex", resumed: true, text: "here is what I did" });

  const threads = conversation(await readEvents(dir));
  assert.deepEqual(threads.map((t) => t.agent).sort(), ["agy", "codex"]);

  const codex = threads.find((t) => t.agent === "codex");
  // A reviewer must never see another reviewer's findings: two that read each
  // other stop being independent, and their agreement stops being evidence.
  assert.equal(codex.turns.some((t) => t.id === "B"), false);
  assert.deepEqual(codex.turns.map((t) => t.who), ["codex", "claude", "claude", "claude"]);
  await rm(dir, { recursive: true, force: true });
});

test("streaming chunks collapse into one live turn, and the report replaces it", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "agent.chunk", agent: "codex", round: 1, text: "reading " });
  await appendEvent(dir, { t: "agent.chunk", agent: "codex", round: 1, text: "the diff" });

  let turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1, "one live turn, not one per chunk");
  assert.equal(turns[0].text, "reading the diff");

  await appendEvent(dir, { t: "agent.report", agent: "codex", round: 1, verdict: "found", report: "FINDING: x", seconds: 9 });
  turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1, "the finished report replaces the placeholder it was streamed into");
  assert.equal(turns[0].kind, "report");
  await rm(dir, { recursive: true, force: true });
});

test("a reviewer with nothing to answer is not a sign-off", async () => {
  const { replyRound } = await import("../lib/loop.js");
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "a" });
  const findings = await findingsIn(dir);

  // Every finding still open, so buildReply produces nothing to send. Reporting
  // that as clean let a run with everything unaddressed announce convergence.
  const out = await replyRound({
    dir, pool: [{ name: "codex", argv: ["codex"], resume: { supported: true } }],
    cfg: { stopToken: "NO NEW FINDINGS" }, worktree: dir, sha: "abc", round: 1,
    findings, dryRun: true,
  });
  assert.equal(out[0].skipped, true);
  assert.equal(out[0].clean, false, "nothing asked cannot mean agreed");
  await rm(dir, { recursive: true, force: true });
});

test("a reviewer that could not run is never counted as agreement", async () => {
  const { replyRound } = await import("../lib/loop.js");
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "a" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "misread" });
  const findings = await findingsIn(dir);

  // A quota wall, an auth failure and a timeout all arrive as a failed run.
  const out = await replyRound({
    dir, pool: [{ name: "codex", argv: ["definitely-not-a-real-binary-xyz"], resume: { supported: false } }],
    cfg: { stopToken: "NO NEW FINDINGS" }, worktree: dir, sha: "abc", round: 1,
    findings, dryRun: false,
  });
  assert.equal(out[0].failed, true);
  assert.equal(out[0].clean, false, "a reviewer that never ran agreed to nothing");
  await rm(dir, { recursive: true, force: true });
});
