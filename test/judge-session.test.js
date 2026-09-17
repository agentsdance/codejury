import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { triageOne } from "../lib/triage.js";

test("judge triage resumes one provider session across findings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-judge-session-"));
  const calls = path.join(dir, "calls.log");
  const fake = path.join(dir, "fake-judge.js");
  await writeFile(fake, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, (process.argv.includes("--resume") ? "resume " + process.argv[process.argv.indexOf("--resume") + 1] : "first") + "\\n");
console.log("SESSION=judge-session-1");
console.log(JSON.stringify({reproduced:null, verdict:"rejected", reason:"not reproducible", test:null}));
`);
  await chmod(fake, 0o755);
  const agent = {
    name: "fake-judge", promptDelivery: "argv", cwd: "worktree",
    argv: [fake, "{{promptText}}"],
    resume: { supported: true, argv: [fake, "--resume", "{{sessionId}}", "{{promptText}}"], idFrom: "SESSION=([a-z0-9-]+)" },
    report: "whole", expectSeconds: 1,
  };
  const finding = { id: "F1", agent: "reviewer", claim: "something is wrong", loc: "a.txt:1" };
  try {
    const first = await triageOne(agent, finding, { worktree: dir, trunk: "master", stopToken: "NO NEW FINDINGS", context: "" });
    assert.equal(first.verdict, "rejected");
    assert.equal(first.sessionId, "judge-session-1");
    const second = await triageOne(agent, { ...finding, id: "F2" }, {
      worktree: dir, trunk: "master", stopToken: "NO NEW FINDINGS", context: "", sessionId: first.sessionId,
    });
    assert.equal(second.verdict, "rejected");
    assert.equal(second.sessionId, first.sessionId);
    const lines = (await readFile(calls, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "first");
    assert.equal(lines[1], "resume judge-session-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
