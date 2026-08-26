// Triage: the judgement half of the loop. Run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, triagePrompt } from "../lib/triage.js";

test("the last JSON object wins, so an echoed example cannot beat the real answer", () => {
  // Agents narrate before answering, and they routinely restate the schema they
  // were given. Taking the first match filed the prompt's own example as the
  // verdict.
  const out = `I will answer in this shape:
{"reproduced": "<what you observed>", "verdict": "accepted | rejected", "test": null}

Checking now... the lock IS released on the error path.

{"reproduced": null, "verdict": "rejected", "reason": "the defer runs on both paths", "test": null}`;
  const v = parseVerdict(out);
  assert.equal(v.verdict, "rejected");
  assert.equal(v.reason, "the defer runs on both paths");
  assert.equal(v.reproduced, null);
});

test("nested objects in the reasoning do not break the scan", () => {
  const out = `Here is the config I read: {"agents": {"codex": {"resume": {"supported": true}}}}
{"reproduced": "all 6 backoff tests pass with delay returned directly", "verdict": "accepted", "reason": "the assertion only checked the mean", "test": "TestBackoffJitter fails with the fix reverted"}`;
  const v = parseVerdict(out);
  assert.equal(v.verdict, "accepted");
  assert.match(v.reproduced, /6 backoff tests/);
  assert.match(v.test, /fails with the fix reverted/);
});

test("agents writing 'null' and 'none' as strings mean nothing, not something", () => {
  // A literal "null" string passed the gate's `if (!finding.reproduced)` check,
  // so an acceptance with no reproduction would have been recorded as proven.
  const v = parseVerdict('{"reproduced": "null", "verdict": "rejected", "reason": "x", "test": "none"}');
  assert.equal(v.reproduced, null);
  assert.equal(v.test, null);
});

test("an unrecognised verdict is no verdict, not a silent pass", () => {
  const v = parseVerdict('{"verdict": "probably fine", "reason": "looks ok"}');
  assert.equal(v.verdict, null, "an unknown verdict must leave the finding open");
});

test("output with no JSON at all yields null rather than throwing", () => {
  assert.equal(parseVerdict("I could not determine whether this reproduces."), null);
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict(undefined), null);
});

test("the prompt demands a reproduction before an acceptance", () => {
  const p = triagePrompt({
    finding: { claim: "jitter is deletable", loc: "m_test.go:22", body: "detail" },
    trunk: "master", stopToken: "NO NEW FINDINGS",
  });
  assert.match(p, /jitter is deletable/);
  assert.match(p, /m_test\.go:22/);
  assert.match(p, /REPRODUCE/);
  // The reviewer's claim is a hypothesis; rejecting one with evidence is the
  // point, not a failure to be helpful.
  assert.match(p, /third of review findings do not survive/);
  assert.match(p, /FAILS/);
  assert.match(p, /Do not commit/);
});

test("a reproduction recorded now is visible to the gate now", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { appendEvent } = await import("../lib/store.js");
  const { findingsIn, gate } = await import("../lib/findings.js");

  const dir = await mkdtemp(path.join(tmpdir(), "macr-gate-"));
  try {
    await appendEvent(dir, { t: "finding.raised", id: "A", round: 1, agent: "codex", claim: "c" });

    // The loop folds findings, then appends a reproduction, then records the
    // verdict. Handing gate() the PRE-reproduction map refused every acceptance
    // moments after writing the proof for it — the fix is real, the finding
    // stays open, and the round reports nothing done.
    const stale = await findingsIn(dir);
    await appendEvent(dir, { t: "finding.reproduced", id: "A", evidence: "observed it", test: "T fails without the fix" });

    assert.ok(gate(stale.get("A"), { verdict: "accepted", test: "T fails without the fix" }),
      "a stale map cannot see the reproduction just written — this is the bug");

    const fresh = await findingsIn(dir);
    assert.equal(gate(fresh.get("A"), { verdict: "accepted", test: "T fails without the fix" }), null,
      "refolded, the same acceptance must pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI defines every helper the triage path calls", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../bin/macr.js", import.meta.url), "utf8");
  // `beat(...)` was called on the first trackable finding and never declared,
  // so the loop died with a ReferenceError the moment triage began. Folding
  // synthetic events in a test never touches that path.
  for (const fn of ["beat", "commitFixes", "publishRun", "describe", "resolveRun"]) {
    assert.match(src, new RegExp(`(function|const)\\s+${fn}\\b`), `${fn}() is called but never defined`);
  }
});

test("a failed push is not reported as pushed", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../bin/macr.js", import.meta.url), "utf8");
  // commitFixes swallowed the push error and returned the sha anyway, so the
  // caller emitted commit.pushed and later rounds reviewed a commit the PR
  // never received — and could converge on it.
  assert.match(src, /return \{ sha, pushed:/, "commitFixes must report whether the push happened");
  assert.match(src, /pushFailed/, "a failed push must block convergence");
});
