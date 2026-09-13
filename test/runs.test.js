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
  const dir = await mkdtemp(path.join(tmpdir(), "jury-runs-"));
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

test("listRuns puts the newest run first, across PRs as well as within one", async () => {
  const { dir, cleanup } = await scratch();
  const { writeRun } = await import("../lib/store.js");
  try {
    const mk = (id, attempt) => writeRun(
      path.join(dir, `agentsdance-aigit-${id.slice(1)}-${attempt}`),
      { target: { repo: "agentsdance/aigit", id, state: "review", attempt }, rounds: [], exchanges: [] },
    );
    // An older review of #3 and a newer one of #5. Sorting on the id first put
    // #3 on top, so bare `jury --web-only` opened the stale run.
    await mk("#3", "20260826-1000");
    await mk("#5", "20260826-1200");
    await mk("#5", "20260826-1100");

    const { runs } = await listRuns(dir);
    assert.deepEqual(
      runs.map((r) => r.target.attempt),
      ["20260826-1200", "20260826-1100", "20260826-1000"],
    );
    // The console's fallback is runs[0]; it must be the most recent review.
    assert.equal(runs[0].target.id, "#5");
  } finally {
    await cleanup();
  }
});

test("listRuns still ranks by state before recency", async () => {
  const { dir, cleanup } = await scratch();
  const { writeRun } = await import("../lib/store.js");
  try {
    const mk = (id, state, attempt) => writeRun(
      path.join(dir, `agentsdance-aigit-${id.slice(1)}-${attempt}`),
      { target: { repo: "agentsdance/aigit", id, state, attempt }, rounds: [], exchanges: [] },
    );
    // A newer merged run must not outrank an older one still awaiting a human.
    await mk("#7", "merged", "20260826-1200");
    await mk("#8", "human", "20260826-1000");

    const { runs } = await listRuns(dir);
    assert.deepEqual(runs.map((r) => r.target.state), ["human", "merged"]);
  } finally {
    await cleanup();
  }
});
