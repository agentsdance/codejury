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
