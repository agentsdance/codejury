// Parsing what a reviewer said. Run with `node --test`.
//
// These guard the two failure modes that actually bit: a reviewer's real
// findings being read as quoted material and vanishing, and the prompt's own
// template being filed as findings the reviewer never raised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFindings, hasStopToken, extractReport } from "../lib/agents.js";

test("a fenced FINDING/WHERE block is the reviewer speaking, not a quote", () => {
  // Verbatim shape from agy on aigit#48: the prompt shows the header inside a
  // fence, so the reviewer answers in the same shape. Reading it as a quote
  // lost all five findings it raised.
  const report = [
    "### Finding 1: Self-upgrade fails on Windows",
    "```",
    "FINDING: Self-upgrade fails on Windows due to file locking",
    "WHERE: upgrade.go:69",
    "```",
    "On Windows a running executable is locked by the OS.",
    "",
    "### Finding 2: nil channel hang",
    "```",
    "FINDING: nil updateNotice blocks for the full timeout",
    "WHERE: main.go:31",
    "```",
    "Reading from a nil channel blocks forever.",
  ].join("\n");

  const found = parseFindings(report);
  assert.equal(found.length, 2);
  assert.equal(found[0].loc, "upgrade.go:69");
  assert.equal(found[1].loc, "main.go:31");
  // The prose under a fenced header belongs to that finding.
  assert.match(found[0].body, /running executable is locked/);
  // And must not bleed into the next one.
  assert.doesNotMatch(found[0].body, /nil channel/);
});

test("a fence holding anything else stays quoted", () => {
  const report = [
    "Here is the hunk I am looking at:",
    "```",
    "FINDING: this line is quoted from elsewhere",
    "+ someCode()",
    "```",
    "No problems.",
  ].join("\n");
  assert.equal(parseFindings(report).length, 0);
});

test("the prompt's own template is not a finding", () => {
  // A reviewer that echoes the instructions back would otherwise have the
  // placeholder filed against it, and a clean round read as not converged.
  const echoed = [
    "I will use this format:",
    "```",
    "FINDING: <the claim, one line>",
    "WHERE: <file:line>",
    "```",
    "NO NEW FINDINGS",
  ].join("\n");
  assert.equal(parseFindings(echoed).length, 0);
  assert.equal(hasStopToken(echoed, "NO NEW FINDINGS"), true);
});

test("unfenced headers still parse, with markdown decoration stripped", () => {
  const report = [
    "**FINDING:** accounting leaks a reservation",
    "1. WHERE: pool.go:212",
    "The guard consumes the job without releasing it.",
  ].join("\n");
  const [f] = parseFindings(report);
  assert.equal(f.claim, "accounting leaks a reservation");
  assert.equal(f.loc, "pool.go:212");
});

test("the stop token must stand on its own line", () => {
  assert.equal(hasStopToken("NO NEW FINDINGS", "NO NEW FINDINGS"), true);
  // Bolded output must still be able to end the loop — otherwise a reviewer
  // that formats its answer costs a wasted round every time.
  assert.equal(hasStopToken("**NO NEW FINDINGS**", "NO NEW FINDINGS"), true);
  assert.equal(
    hasStopToken("I would say NO NEW FINDINGS but actually...", "NO NEW FINDINGS"),
    false,
  );
});

test("a verbose transcript is read from its final turn", () => {
  // The transcript contains the prompt, so the stop token appears in the
  // instruction as well as the answer.
  const transcript = [
    "user",
    'say exactly "NO NEW FINDINGS" if you find nothing',
    "codex",
    "FINDING: real one",
    "WHERE: a.go:1",
  ].join("\n");
  const tail = extractReport(transcript, "tail");
  assert.equal(parseFindings(tail).length, 1);
  assert.equal(hasStopToken(tail, "NO NEW FINDINGS"), false);
});

test("a reviewer's explanation inside its own fence does not kill the finding", () => {
  // Reviewers routinely put the headers AND their prose in one fence. Requiring
  // every line to be a header discarded the whole finding — caught by agy
  // reviewing this very parser.
  const report = [
    "```",
    "FINDING: real bug",
    "WHERE: lib/reply.js:115",
    "The placeholder is blanked before runAgent can fill it.",
    "```",
  ].join("\n");
  const found = parseFindings(report);
  assert.equal(found.length, 1);
  assert.equal(found[0].loc, "lib/reply.js:115");
});

test("a fence opening with FINDING: but carrying code is still quoted", () => {
  // The looser rule must not swallow a diff a reviewer is quoting back.
  const report = [
    "Here is what the agent wrote:",
    "```",
    "FINDING: quoted from somewhere else",
    "+ someCode();",
    "```",
  ].join("\n");
  assert.equal(parseFindings(report).length, 0);
});
