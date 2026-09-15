// The autonomous loop: what makes it terminate, and what it shows while it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendEvent, readEvents, readArtifact } from "../lib/store.js";
import { MAX_TURNS, turnsFor, outstanding, deadlocked, conversation, refreshSettled, record, currentJudge } from "../lib/loop.js";
import { findingsIn } from "../lib/findings.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "jury-loop-"));

// The CLI's own `run` is private to bin/jury.js. A non-zero exit is a result
// here, not a throw: the loop is allowed to fail, and the assertions are about
// what it printed.
const exec = promisify(execFile);
const run = (cmd, args, opts) =>
  exec(cmd, args, opts).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));

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
  // A raised finding is not a turn: the reviewer already said it in its own
  // report, and a parsed copy underneath is the same words twice. What claude
  // did about it still is.
  assert.deepEqual(codex.turns.map((t) => t.who), ["claude", "claude", "claude"]);
  assert.equal(codex.turns.some((t) => t.kind === "finding"), false);
  // The verdict names the claim it answers, so it does not float free.
  assert.equal(codex.turns.find((t) => t.kind === "verdict").claim, "a");
  // A reviewer whose only event was a finding still gets a thread.
  assert.ok(threads.find((t) => t.agent === "agy"), "agy must not vanish");
  await rm(dir, { recursive: true, force: true });
});

test("a selected non-Claude judge owns its events without becoming its own reviewer", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "target", target: { judge: "codex" } });
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "agy", claim: "a" });
  await appendEvent(dir, { t: "finding.reproduced", id: "A", evidence: "reproduced" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "not a bug" });
  await appendEvent(dir, { t: "reply.sent", agent: "agy", text: "answered" });
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "codex", text: "judge explanation" });

  const [thread] = conversation(await readEvents(dir));
  assert.equal(thread.agent, "agy");
  assert.deepEqual(thread.turns.map((t) => t.who), ["codex", "codex", "codex", "codex"]);
  assert.equal(thread.turns.at(-1).text, "judge explanation");
  assert.equal((await findingsIn(dir)).get("A").contested, false,
    "the judge's own turn must not reopen its finding");

  await appendEvent(dir, { t: "finding.turn", id: "A", who: "agy", text: "still wrong" });
  assert.equal((await findingsIn(dir)).get("A").contested, true,
    "a reviewer's turn must still reopen the finding");
  await rm(dir, { recursive: true, force: true });
});

test("a reviewer's rebuttal is not the same words as the reply it was cut from", async () => {
  const dir = await tmp();
  // The shape replyRound writes: the whole answer, then an excerpt of that same
  // answer recorded against the finding it re-argues.
  const report = [
    "I checked the fix and it is still wrong.",
    "The validator does not normalize the path before comparing.",
  ].join("\n");
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex",
    claim: "the validator does not normalize the path", loc: "lib/x.js:10" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "misread" });
  await appendEvent(dir, { t: "reply.sent", agent: "codex", text: "here is what I did" });
  await appendEvent(dir, { t: "reply.answered", agent: "codex", verdict: "found", report });
  await appendEvent(dir, { t: "finding.turn", id: "A", agent: "codex", who: "codex", text: report });

  const [t] = conversation(await readEvents(dir));
  const answer = t.turns.find((x) => x.kind === "answer");
  const rebuttal = t.turns.find((x) => x.kind === "rebuttal");
  assert.equal(answer.text, report, "the reply itself is still shown whole");
  // The excerpt was a slice of the report directly above it; rendering both put
  // the reviewer's words on screen twice.
  assert.ok(!rebuttal.text, "a reviewer's rebuttal must not repeat the reply it was cut from");
  // What it is for: naming the claim that is being re-argued.
  assert.equal(rebuttal.claim, "the validator does not normalize the path");
  assert.equal(rebuttal.id, "A");
  // The event still has to reach findingsIn, or the turn limit is dead code.
  assert.equal((await findingsIn(dir)).get("A").contested, true);

  // Claude's own turn is not an excerpt of anything else on screen, so it keeps
  // its text.
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "claude", text: "here is why it is right" });
  const mine = conversation(await readEvents(dir))[0].turns
    .filter((x) => x.kind === "rebuttal").at(-1);
  assert.equal(mine.text, "here is why it is right");
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

test("an abandoned launch ends at its own round, not at the present moment", async () => {
  const { foldEvents } = await import("../lib/store.js");
  // Round 1 is killed mid-flight; rounds 2 and 3 run later. Running round 1's
  // unfinished span to the newest event drew it across the whole timeline —
  // "963.7 min · unfinished" over every round that followed.
  const t = (min) => new Date(Date.parse("2026-08-25T09:00:00Z") + min * 60000).toISOString();
  const run = foldEvents([
    { ts: t(0), t: "round.start", n: 1, sha: "a" },
    { ts: t(0), t: "agent.launch", agent: "codex", round: 1 },
    { ts: t(0), t: "agent.launch", agent: "agy", round: 1 },
    { ts: t(3), t: "agent.report", agent: "agy", round: 1, verdict: "found" },
    // codex never reports: killed.
    { ts: t(960), t: "round.start", n: 2, sha: "b" },
    { ts: t(960), t: "agent.launch", agent: "codex", round: 2 },
    { ts: t(970), t: "agent.report", agent: "codex", round: 2, verdict: "found" },
    { ts: t(980), t: "round.start", n: 3, sha: "c" },
    { ts: t(980), t: "agent.launch", agent: "codex", round: 3 },
  ]);

  const codex = run.lanes.find((l) => l.who === "codex");
  const dead = codex.segs.find((s) => s.r === 1);
  assert.equal(dead.abandoned, true, "an earlier round's unfinished launch is abandoned, not live");
  assert.ok(dead.e <= 3, `abandoned span must end with its own round, got ${dead.e}`);
  assert.equal(dead.open, undefined, "abandoned is not the same as still running");

  // The newest round genuinely is still going, and must still be drawn.
  const live = codex.segs.find((s) => s.r === 3);
  assert.equal(live.open, true);
  assert.match(live.t, /still running/);
});

test("a non-streaming reviewer shows a heartbeat, and its report replaces it", async () => {
  const dir = await tmp();
  // codex writes nothing until it exits — an 8.9s run produced one 7-byte chunk
  // at 8.5s — so without a heartbeat its column is empty for the whole round
  // and "thinking" is indistinguishable from "wedged".
  await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: 5 });
  await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: 10 });

  let turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1, "one waiting turn, not one per heartbeat");
  assert.equal(turns[0].kind, "waiting");
  assert.equal(turns[0].seconds, 10, "it counts up rather than restarting");

  await appendEvent(dir, { t: "agent.report", agent: "codex", round: 1, verdict: "found", report: "FINDING: x" });
  turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1, "the report replaces the heartbeat, not appends to it");
  assert.equal(turns[0].kind, "report");
  await rm(dir, { recursive: true, force: true });
});

test("an agent that does stream never shows a heartbeat", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "agent.alive", agent: "agy", round: 1, seconds: 5 });
  await appendEvent(dir, { t: "agent.chunk", agent: "agy", round: 1, text: "reading the diff" });

  const turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1, "real output supersedes the placeholder");
  assert.equal(turns[0].kind, "streaming");
  assert.equal(turns[0].text, "reading the diff");
  await rm(dir, { recursive: true, force: true });
});

test("an agent that takes an assigned session id resumes that exact conversation", async () => {
  const { replyArgv } = await import("../lib/reply.js");
  const grok = {
    name: "grok", argv: ["grok", "--session-id", "{{sessionId}}", "-p", "{{promptText}}"],
    newSession: true,
    resume: { supported: true, argv: ["grok", "--resume", "{{sessionId}}", "-p", "{{promptText}}"] },
  };

  const withId = replyArgv(grok, { promptText: "hi", sessionId: "abc-123" });
  assert.equal(withId.resumed, true);
  assert.ok(withId.argv.includes("abc-123"), "the reply must name the session it is answering");
  assert.ok(!withId.argv.some((a) => a.includes("{{")), "no placeholder may survive into argv");

  // With no session recorded, resuming would either blank the argument or —
  // with a --last style flag — deliver the verdict into whichever conversation
  // ran most recently. A fresh session is the honest fallback.
  const without = replyArgv(grok, { promptText: "hi", sessionId: null });
  assert.equal(without.resumed, false);
  assert.ok(!without.argv.includes("--resume"));
});

test("interleaved heartbeats from two rounds collapse per round, not per beat", async () => {
  const dir = await tmp();
  // A killed run leaks its heartbeat interval, so an old round keeps beating
  // while a new one starts. Matching "is it the last turn?" failed on every
  // alternation: a nine-minute round grew 81 bubbles instead of one.
  for (let i = 1; i <= 4; i++) {
    await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: i * 5 });
    await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 2, seconds: i * 5 + 500 });
  }
  const turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 2, "one waiting turn per round, however they interleave");
  assert.deepEqual(turns.map((t) => t.round), [1, 2]);
  assert.deepEqual(turns.map((t) => t.seconds), [20, 520], "each keeps its own latest elapsed");
  await rm(dir, { recursive: true, force: true });
});

test("a heartbeat arriving after the report does not resurrect the placeholder", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: 5 });
  await appendEvent(dir, { t: "agent.report", agent: "codex", round: 1, verdict: "found", report: "FINDING: x" });
  // A leaked interval can fire after the round is over; it must not replace the
  // report with "working 0:10".
  await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: 10 });

  const turns = conversation(await readEvents(dir))[0].turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, "report");
  await rm(dir, { recursive: true, force: true });
});

test("each invocation is its own run, so re-reviewing a PR does not merge into the last one", async () => {
  const { slugFor, attemptStamp } = await import("../lib/store.js");
  const target = { repo: "acme/api", id: "48" };

  // Without an attempt, three `jury review <same-pr>` invocations all wrote to
  // one directory: three separate reviews merged into rounds 1-5 of a single
  // run, and a killed run's open rounds interleaved with the next one's.
  const bare = slugFor(target);
  const a = slugFor({ ...target, attempt: attemptStamp(new Date(2026, 7, 26, 10, 24)) });
  const b = slugFor({ ...target, attempt: attemptStamp(new Date(2026, 7, 26, 10, 27)) });

  assert.notEqual(a, b, "two invocations must not share a run directory");
  assert.match(a, /-20260826-1024$/);
  assert.match(b, /-20260826-1027$/);
  // Stamps sort chronologically, so the directory listing reads in order.
  assert.ok(a < b);
  // Resuming still targets the original, attempt-less shape.
  assert.equal(bare, "acme-api-48");
});

test("the main agent's triage heartbeat survives the reviewer's report, in production order", async () => {
  const dir = await tmp();
  // The real order for a round: the reviewer streams, reports, its findings are
  // raised, and only THEN does the main agent start triaging. Keying the
  // "real output supersedes the placeholder" rule on the thread rather than the
  // speaker meant the report suppressed every triage heartbeat — the events
  // were written and the fold ignored them, so the console was blank for the
  // longest stretch of the round.
  await appendEvent(dir, { t: "agent.chunk", agent: "codex", round: 1, text: "reading" });
  await appendEvent(dir, { t: "agent.report", agent: "codex", round: 1, verdict: "found", report: "FINDING: x" });
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "c" });
  await appendEvent(dir, { t: "agent.alive", agent: "claude", forAgent: "codex", round: 1, seconds: 5 });
  await appendEvent(dir, { t: "agent.alive", agent: "claude", forAgent: "codex", round: 1, seconds: 10 });

  const threads = conversation(await readEvents(dir));
  assert.deepEqual(threads.map((t) => t.agent), ["codex"], "no thread of its own");
  const waiting = threads[0].turns.filter((t) => t.kind === "waiting");
  assert.equal(waiting.length, 1, "one waiting turn, collapsed, not one per beat");
  assert.equal(waiting[0].who, "claude", "attributed to the main agent");
  assert.equal(waiting[0].seconds, 10, "and kept up to date");
  // The reviewer's own report must still be there, not replaced.
  assert.ok(threads[0].turns.some((t) => t.kind === "report"), "report survives");
  await rm(dir, { recursive: true, force: true });
});

test("the main agent's triage heartbeat lands in the reviewer's thread, not its own", async () => {
  const dir = await tmp();
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "c" });
  // Threads are per reviewer; the main agent is a participant in each, not a
  // thread of its own. Filing its heartbeat under "claude" opened a second
  // conversation and split one exchange in two.
  await appendEvent(dir, { t: "agent.alive", agent: "claude", forAgent: "codex", round: 1, seconds: 5 });

  const threads = conversation(await readEvents(dir));
  assert.deepEqual(threads.map((t) => t.agent), ["codex"], "no thread of its own");
  const waiting = threads[0].turns.find((t) => t.kind === "waiting");
  assert.ok(waiting, "the heartbeat must appear inside the reviewer's thread");
  assert.equal(waiting.who, "claude", "but still attributed to the main agent");
  await rm(dir, { recursive: true, force: true });
});

test("a reviewer's own heartbeat still opens its own thread", async () => {
  const dir = await tmp();
  // No forAgent: this is the reviewer itself working, not the main agent
  // judging on its behalf.
  await appendEvent(dir, { t: "agent.alive", agent: "codex", round: 1, seconds: 5 });
  const threads = conversation(await readEvents(dir));
  assert.deepEqual(threads.map((t) => t.agent), ["codex"]);
  assert.equal(threads[0].turns[0].who, "codex");
  await rm(dir, { recursive: true, force: true });
});

// A clean round is not convergence while a finding from an earlier round is
// still open. `runRound` returning clean used to exit the loop immediately,
// ahead of the still-open check at the end of the round body — so a finding
// that triage left open, or one a reply raised after the round's last triage,
// was never answered. The reviewers cannot re-raise it either: settled.md
// lists only findings that already have a verdict, so an open one is invisible
// to them and they sign off in good faith.
test("a clean round does not converge while an earlier finding is still open", async () => {
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

  // One reviewer, one main agent. Both are dry-run: the reviewer emits the stop
  // token (clean), which is exactly the round this bug needs.
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({
    agents: [
      { name: "claude", role: "main", command: "true", args: [] },
      { name: "codex", command: "true", args: [] },
    ],
  }));

  // Seed a run whose previous round left a finding open — no finding.resolved.
  const runDir = path.join(repo, "runs", "acme-api-1");
  await appendEvent(runDir, { t: "round.start", n: 1, sha: "deadbee" });
  await appendEvent(runDir, {
    t: "finding.raised", id: "1-codex-reply-1", round: 1, agent: "codex",
    claim: "the reply raised this and nobody triaged it", loc: "a.txt:1",
  });
  await appendEvent(runDir, { t: "round.end", n: 1 });

  const r = await run(process.execPath, [
    path.resolve("bin/jury.js"), "agent",
    "--dir", repo, "--resume", runDir, "--trunk", "master",
    "--rounds", "1", "--web=false", "--dry-run",
  ], { cwd: repo });

  // Round 2's reviewer is clean. Exiting there would announce convergence with
  // the round-1 finding untouched.
  assert.doesNotMatch(r.stdout, /REVIEW COMPLETE/,
    "a clean round must not converge past a finding nobody answered");
  assert.match(r.stdout, /ROUND CLEAN/, "the clean round itself is still reported accurately");
  assert.match(r.stdout, /still open/,
    "the loop must say why it is not stopping");
  const intermediateTarget = (await readEvents(runDir))
    .filter((e) => e.t === "target" && /checking outstanding/.test(e.target?.stateNote ?? ""))
    .at(-1)?.target;
  assert.ok(intermediateTarget, "the clean intermediate round must be recorded");
  assert.equal(Object.hasOwn(intermediateTarget, "reviewedCommit"), false,
    "an intermediate round must not erase or invent a completed commit");
  // And it must actually deal with it rather than merely refusing to stop.
  const f = await findingsIn(runDir);
  assert.notEqual(f.get("1-codex-reply-1").status, "open",
    "the open finding must reach triage");

  await rm(repo, { recursive: true, force: true });
});

test("--judge selects one judge, excludes it from reviewers, and records the choice", async () => {
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

  const result = await run(process.execPath, [
    path.resolve("bin/jury.js"), "agent", "--dir", repo, "--trunk", "master",
    "--rounds", "1", "--web=false", "--dry-run", "--judge", "codex", "--agents", "droid",
  ], { cwd: repo });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /judge\s+codex/);
  assert.match(result.stdout, /agents\s+droid/);
  assert.match(result.stdout, /REVIEW COMPLETE/);
  assert.match(result.stdout, /Reviewed commit [0-9a-f]+\./);
  assert.doesNotMatch(result.stdout, /\bconverged\b/i);

  const [slug] = await readdir(path.join(repo, "runs"));
  const events = await readEvents(path.join(repo, "runs", slug));
  assert.equal(currentJudge(events), "codex");
  const target = events.filter((e) => e.t === "target").at(-1).target;
  assert.equal(target.stateNote, "Review complete");
  assert.match(target.reviewedCommit, /^[0-9a-f]+$/);
  assert.deepEqual(events.filter((e) => e.t === "agent.launch").map((e) => e.agent), ["droid"]);

  const repeated = await run(process.execPath, [
    path.resolve("bin/jury.js"), "agent", "--judge", "codex", "--judge", "claude",
  ], { cwd: repo });
  assert.match(repeated.stderr, /--judge accepts exactly one agent/);

  const missing = await run(process.execPath, [
    path.resolve("bin/jury.js"), "agent", "--dir", repo, "--trunk", "master",
    "--rounds", "1", "--web=false", "--dry-run", "--agents", "traecli",
  ], { cwd: repo });
  assert.match(missing.stderr, /requested reviewer "traecli" is not configured or is disabled/);
  assert.match(missing.stderr, /Add or enable it with role "reviewer" in jury\.config\.json/);
  assert.match(missing.stderr, /Available reviewers:/);
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({
    agents: [{ name: "codex", argv: ["jury-missing-judge-test"] }],
  }));
  const unavailable = await run(process.execPath, [path.resolve("bin/jury.js"), "review",
    "--dir", repo, "--trunk", "master", "--web=false", "--rounds", "1"], { cwd: repo });
  assert.match(unavailable.stderr, /judge "codex" is not installed/);
  assert.doesNotMatch(unavailable.stdout, /round 1|console/);

  await rm(repo, { recursive: true, force: true });
});

test("an explicitly requested configured reviewer is actually launched", async () => {
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
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    { name: "codex", enabled: false },
    { name: "claude", role: "main", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
    { name: "grok", enabled: false },
    { name: "droid", enabled: false },
    {
      name: "traecli", role: "reviewer", promptDelivery: "argv", cwd: "worktree",
      argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"], report: "whole",
    },
  ] }));

  const result = await run(process.execPath, [
    path.resolve("bin/jury.js"), "review", "--rounds", "1", "--web=false", "--push=false", "--judge", "claude", "--dir", repo, "--trunk", "master",
    "--agents", "traecli",
  ], { cwd: repo });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /traecli\s+.*clean/);
  assert.match(result.stdout, /REVIEW COMPLETE/);

  const [slug] = await readdir(path.join(repo, "runs"));
  const events = await readEvents(path.join(repo, "runs", slug));
  assert.deepEqual(events.filter((e) => e.t === "agent.launch").map((e) => e.agent), ["traecli"]);
  assert.equal(events.find((e) => e.t === "agent.report")?.verdict, "clean");
  await rm(repo, { recursive: true, force: true });
});

test("an opt-in built-in agent runs when named, without being enabled first", async () => {
  // The six agents added for issues #75-#81 ship opt-in so a default install
  // does not demand every supported CLI. Naming one must still work straight
  // away — otherwise "supported" would mean nothing more than "documented".
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
  // Only the executable is stubbed; qwen keeps its built-in role and reviewer
  // status, which is the part under test.
  await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents: [
    { name: "codex", enabled: false },
    { name: "grok", enabled: false },
    { name: "droid", enabled: false },
    { name: "claude", role: "main", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
    { name: "qwen", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
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
