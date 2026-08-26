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
