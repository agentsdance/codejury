// Two conversations, one per reviewer. Run with `node --test`.
//
// The property under test is independence: a reviewer must not learn what
// another reviewer said. Two reviewers that read each other stop being
// independent, and their agreement stops being evidence of anything — which is
// the only reason to run more than one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReply, threadFor, replyArgv } from "../lib/reply.js";

const findings = new Map([
  ["r1-codex-1", {
    id: "r1-codex-1", agent: "codex", claim: "rename cannot replace a running exe",
    loc: "upgrade.go:69", body: "Windows locks the mapped image.", status: "deferred",
    reason: "Agreed; also raised by agy in r1-agy-1. Needs a Windows host.", reproduced: "read the code",
  }],
  ["r1-agy-1", {
    id: "r1-agy-1", agent: "agy", claim: "same rename defect",
    loc: "upgrade.go:69", body: "os.Rename over the running binary fails.", status: "deferred",
    reason: "Agreed. Same reasoning as the codex thread.", reproduced: "read the code",
  }],
  ["r1-agy-2", {
    id: "r1-agy-2", agent: "agy", claim: "unanswered one", loc: "main.go:31",
    body: "nil channel", status: "open", reason: "",
  }],
]);

test("a reviewer only ever sees its own findings", () => {
  const codex = buildReply({
    agent: "codex", thread: threadFor("codex", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: false, stopToken: "NO NEW FINDINGS", others: ["agy", "claude"],
  });
  assert.match(codex, /rename cannot replace a running exe/);
  assert.doesNotMatch(codex, /same rename defect/);
});

test("another reviewer's name and finding ids are redacted from verdicts", () => {
  // Isolation cannot depend on the operator remembering not to type the name.
  const codex = buildReply({
    agent: "codex", thread: threadFor("codex", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: false, stopToken: "NO NEW FINDINGS", others: ["agy", "claude"],
  });
  assert.doesNotMatch(codex, /\bagy\b/i);
  assert.doesNotMatch(codex, /r1-agy-1/i);
  assert.match(codex, /another reviewer/);

  const agy = buildReply({
    agent: "agy", thread: threadFor("agy", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: true, stopToken: "NO NEW FINDINGS", others: ["codex", "claude"],
  });
  assert.doesNotMatch(agy, /\bcodex\b/i);
  // "the codex thread" must not become "the another reviewer thread".
  assert.doesNotMatch(agy, /the another reviewer/i);
});

const replyWithText = (text, others) => buildReply({
  agent: "fixture", sha: "abc", worktree: "/wt", stopToken: "NO NEW FINDINGS", others,
  thread: [{ agent: "fixture", status: "rejected", claim: "A defect",
    reason: text, reproduced: text, test: text }],
});

for (const name of ["another", "reviewer", "finding"]) {
  test(`reviewer named ${name} cannot reprocess generated redaction text`, () => {
    const text = "codex agreed; r1-codex-1; 1-codex-reply-2; the codex; a codex.";
    const expected = "another reviewer agreed; another reviewer's finding; another reviewer's finding; another reviewer's; another reviewer's.";
    for (const names of [["codex", name], [name, "codex"], ["codex", name, "codex", name]]) {
      assert.equal(replyWithText(text, names), replyWithText(expected, []));
    }
  });
}

test("redacting original placeholder-word names is independent of reviewer order", () => {
  const permutations = values => values.length
    ? values.flatMap((value, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest]))
    : [[]];
  const text = "codex; another; REVIEWER; finding; r2-codex-7; 2-reviewer-reply-8; the codex; a reviewer.";
  const expected = "another reviewer; another reviewer; another reviewer; another reviewer; another reviewer's finding; another reviewer's finding; another reviewer's; another reviewer's.";
  for (const names of permutations(["codex", "another", "reviewer", "finding"])) {
    assert.equal(replyWithText(text, names), replyWithText(expected, []), names.join(", "));
  }
});

test("combined redaction preserves whole-name boundaries for overlapping slugs", () => {
  const names = ["peer", "peer-", "peer--", "peer-reviewer", "reviewer"];
  const text = "peer; peer-; peer--; peer-reviewer; r1-peer--2; 1-peer---reply-3; peer-reviewers; r1-peer-2x.";
  const expected = "another reviewer; another reviewer; another reviewer; another reviewer; another reviewer's finding; another reviewer's finding; peer-reviewers; r1-peer-2x.";
  const original = [...names];
  assert.equal(replyWithText(text, names), replyWithText(expected, []));
  assert.deepEqual(names, original, "the configured reviewer list must not be reordered");
  assert.equal(replyWithText(text, [...names].reverse()), replyWithText(expected, []));
});

test("redaction preserves nonmatching text and leaves empty reviewer lists alone", () => {
  const text = "reviewerish another-tool findings codex2 écodex codex² codex⃝ taſK r1-codex-1x 1-codex-reply-1x {{untouched}} $& $1 文😀\nsecond line";
  assert.equal(replyWithText(text, ["codex", "another", "reviewer", "finding", "task"]), replyWithText(text, []));
  const literal = "codex; another; reviewer; finding; r1-codex-1; 1-codex-reply-1.";
  assert.ok(replyWithText(literal, []).includes(literal));
});

test("an agent that cannot resume gets its own words quoted back", () => {
  const withSession = buildReply({
    agent: "codex", thread: threadFor("codex", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: false, stopToken: "X", others: ["agy"],
  });
  const without = buildReply({
    agent: "agy", thread: threadFor("agy", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: true, stopToken: "X", others: ["codex"],
  });
  // Without a session there is nothing carrying its review.
  assert.match(without, /You wrote:/);
  assert.match(without, /> os\.Rename over the running binary fails\./);
  // With one, repeating it back reads as though it had been misunderstood.
  assert.doesNotMatch(withSession, /You wrote:/);
});

test("unanswered findings are left out, not padded in as 'still open'", () => {
  const agy = buildReply({
    agent: "agy", thread: threadFor("agy", findings), sha: "f656a37",
    worktree: "/wt", quotePrior: true, stopToken: "X", others: ["codex"],
  });
  assert.doesNotMatch(agy, /unanswered one/);
  assert.doesNotMatch(agy, /still open/);
});

test("a thread with nothing answered produces no reply at all", () => {
  const only = new Map([["r1-x-1", { id: "r1-x-1", agent: "x", claim: "c", status: "open" }]]);
  assert.equal(
    buildReply({ agent: "x", thread: threadFor("x", only), sha: "s", worktree: "/wt", stopToken: "X" }),
    null,
  );
});

test("resume argv is used when the agent supports it, plain argv otherwise", () => {
  const resumes = {
    argv: ["codex", "exec", "{{promptText}}"],
    resume: { supported: true, argv: ["codex", "exec", "resume", "--last", "{{promptText}}"] },
  };
  const fresh = {
    argv: ["agy", "--print", "{{promptText}}"],
    resume: { supported: false, reason: "print mode starts a fresh session" },
  };
  const a = replyArgv(resumes, { promptText: "hi" });
  assert.deepEqual(a.argv, ["codex", "exec", "resume", "--last", "hi"]);
  assert.equal(a.resumed, true);

  const b = replyArgv(fresh, { promptText: "hi" });
  assert.deepEqual(b.argv, ["agy", "--print", "hi"]);
  assert.equal(b.resumed, false);
});
