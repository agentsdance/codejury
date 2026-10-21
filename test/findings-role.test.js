import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readEvents } from "../lib/store.js";
import { findingsIn } from "../lib/findings.js";
import { outstanding, replyRound } from "../lib/loop.js";

async function fixture(t, judge, reviewer = judge) {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-rebuttal-role-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await appendEvent(dir, { t: "target", target: { judge } });
  await appendEvent(dir, { t: "finding.raised", id: "A", round: 1,
    agent: reviewer, claim: "validator accepts an invalid path", loc: "validator.js:10" });
  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "checked" });
  return dir;
}

for (const name of ["claude", "codex"]) {
  test(`${name} rebuttal returns to triage when one CLI is both judge and reviewer`, async t => {
    const dir = await fixture(t, name);
    const findings = await findingsIn(dir);
    assert.equal(findings.get("A").contested, false);
    const report = "validator.js:10 still accepts an invalid path; I disagree with the rejection.";
    const answers = await replyRound({
      dir, pool: [{
        name, argv: [process.execPath, "-e", `console.log(${JSON.stringify(report)})`],
        cwd: "worktree", report: "whole", resume: { supported: false },
      }],
      cfg: { stopToken: "NO NEW FINDINGS" }, worktree: dir, sha: "abc1234",
      round: 1, findings, judge: name,
    });
    assert.equal(answers[0].failed, false);
    assert.equal(answers[0].clean, false);
    assert.equal(answers[0].raised, 0, "the reviewer is disputing the existing finding");
    const events = await readEvents(dir);
    const rebuttal = events.find(e => e.t === "finding.turn");
    assert.equal(rebuttal.agent, name, "replyRound records the reviewer role");
    assert.equal(rebuttal.who, name, "both participants have the same CLI name");
    const contested = await findingsIn(dir);
    assert.equal(contested.get("A").contested, true);
    assert.deepEqual(outstanding(contested, events).map(f => f.id), ["A"],
      "the judge must be asked to reconsider the reviewer's disagreement");

    await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected", reason: "checked again" });
    await appendEvent(dir, { t: "finding.turn", id: "A", who: name, text: "judge explanation" });
    assert.equal((await findingsIn(dir)).get("A").contested, false,
      "the judge's own explanation must not reopen the resolved finding");
  });
}

test("legacy turns without an explicit reviewer role use the judge in force at that event", async t => {
  const dir = await fixture(t, "codex", "claude");
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "codex", text: "judge explanation" });
  assert.equal((await findingsIn(dir)).get("A").contested, false);
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "claude", text: "reviewer disagrees" });
  assert.equal((await findingsIn(dir)).get("A").contested, true);

  await appendEvent(dir, { t: "finding.resolved", id: "A", verdict: "rejected" });
  await appendEvent(dir, { t: "target", target: { judge: "claude" } });
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "claude", text: "new judge explanation" });
  assert.equal((await findingsIn(dir)).get("A").contested, false);
  await appendEvent(dir, { t: "finding.turn", id: "A", who: "codex", text: "legacy reviewer disagrees" });
  assert.equal((await findingsIn(dir)).get("A").contested, true);
});
