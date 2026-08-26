// More than one PR at a time. Run with `node --test`.
//
// Each PR is its own run directory, so nothing here should ever need to reason
// about "the current run" — the failure this guards is one PR's findings or
// settled list leaking into another's prompt, which would have a reviewer
// arguing about a change it never saw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, slugFor, listRuns, foldEvents, readEvents } from "../lib/store.js";
import { findingsIn, settledList } from "../lib/findings.js";
import { buildPrompt } from "../lib/prompt.js";

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "macr-runs-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("two PRs in the same repo get separate run directories", () => {
  const a = slugFor({ repo: "agentsdance/aigit", id: "#48" });
  const b = slugFor({ repo: "agentsdance/aigit", id: "#46" });
  assert.notEqual(a, b);
  // The slug is what --run takes, so it must survive the characters a PR id
  // and a repo path actually contain.
  assert.equal(a, "agentsdance-aigit-48");
  assert.match(b, /^[\w.-]+$/);
});

test("a finding raised on one PR never appears on another", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const p48 = path.join(dir, "agentsdance-aigit-48");
    const p46 = path.join(dir, "agentsdance-aigit-46");
    await appendEvent(p48, {
      t: "finding.raised", id: "r1-codex-1", round: 1, agent: "codex",
      claim: "rename cannot replace a running exe", loc: "upgrade.go:69",
    });
    await appendEvent(p46, {
      t: "finding.raised", id: "r1-codex-1", round: 1, agent: "codex",
      claim: "version compare drops pre-release", loc: "update.go:147",
    });

    const f48 = await findingsIn(p48);
    const f46 = await findingsIn(p46);
    assert.equal(f48.size, 1);
    assert.equal(f46.size, 1);
    // Same finding id in both runs on purpose: ids are per-run, so the store
    // must not treat them as one item.
    assert.match(f48.get("r1-codex-1").claim, /running exe/);
    assert.match(f46.get("r1-codex-1").claim, /pre-release/);
  } finally {
    await cleanup();
  }
});

test("the settled list carried into a prompt is that PR's only", async () => {
  const { dir, cleanup } = await scratch();
  try {
    const p48 = path.join(dir, "agentsdance-aigit-48");
    await appendEvent(p48, {
      t: "finding.raised", id: "x1", round: 1, agent: "codex", claim: "48-only claim", loc: "a.go:1",
    });
    await appendEvent(p48, { t: "finding.resolved", id: "x1", verdict: "rejected", reason: "not valid" });

    const settled = settledList(await findingsIn(p48));
    assert.match(settled, /48-only claim/);

    // A PR with nothing settled must say so, not inherit the neighbour's list.
    const prompt = await buildPrompt({
      target: { repo: "agentsdance/aigit", id: "#46" }, trunk: "master",
      stopToken: "NO NEW FINDINGS",
      settledFile: path.join(dir, "agentsdance-aigit-46", "settled.md"),
    });
    assert.match(prompt, /nothing settled yet/);
    assert.doesNotMatch(prompt, /48-only claim/);
  } finally {
    await cleanup();
  }
});

test("listRuns reports every PR, and a broken one is skipped not hidden", async () => {
  const { dir, cleanup } = await scratch();
  try {
    for (const id of ["#46", "#48"]) {
      const d = path.join(dir, `agentsdance-aigit-${id.slice(1)}`);
      await appendEvent(d, { t: "target", target: { repo: "agentsdance/aigit", id, state: "review" } });
      const { writeRun } = await import("../lib/store.js");
      await writeRun(d, foldEvents(await readEvents(d), {}));
    }
    // A directory with events but no run.json is unreadable to the console.
    await appendEvent(path.join(dir, "agentsdance-aigit-99"), { t: "round.start", n: 1 });

    const { runs, skipped } = await listRuns(dir);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.target.id).sort(), ["#46", "#48"]);
    // Silently omitting it would read as "that PR was never reviewed".
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].dir, /99/);
  } finally {
    await cleanup();
  }
});

test("re-reviewing one PR puts the newest attempt first, not the alphabetical one", async () => {
  const { dir, cleanup } = await scratch();
  const { writeRun } = await import("../lib/store.js");
  try {
    // Same PR, same state: only the stamp separates them. Written oldest-last
    // so passing cannot depend on readdir order.
    for (const attempt of ["20260826-1033", "20260826-1454", "20260826-1411"]) {
      const d = path.join(dir, `owner-repo-3-${attempt}`);
      const target = { repo: "owner/repo", id: "#3", state: "review", attempt };
      await appendEvent(d, { t: "target", target });
      await writeRun(d, foldEvents(await readEvents(d), { target }));
    }

    const { runs } = await listRuns(dir);
    // The console opens runs[0] when nothing names one; the oldest attempt
    // winning that slot is how a fresh review opened a stale conversation.
    assert.equal(runs[0].target.attempt, "20260826-1454");
    assert.deepEqual(runs.map((r) => r.target.attempt),
      ["20260826-1454", "20260826-1411", "20260826-1033"]);
  } finally {
    await cleanup();
  }
});
