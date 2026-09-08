import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { groupFixture } from "./helpers/group-fixture.js";
import { conversation } from "../lib/loop.js";
import { readEvents } from "../lib/store.js";
import { reviewUrls, prepareGroup, groupId, groupHead, groupReady, assertGroupCheckout } from "../lib/review-group.js";

test("related PRs share every review and push cross-PR fixes to separate real branches", async t => {
  const f = await groupFixture(t);
  const result = await f.review();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /REVIEW COMPLETE/);
  const { run, dir } = await f.saved();
  assert.equal(run.target.state, "converged");
  assert.equal(run.target.targets.length, 2);
  assert.deepEqual(Object.keys(run.target.reviewedCommits), ["PR1", "PR2"]);
  for (const [i, m] of f.members.entries()) {
    const head = await f.git(m.remote, "rev-parse", m.branch);
    assert.notEqual(head, m.sha);
    assert.equal(run.target.reviewedCommits[`PR${i + 1}`], head);
    assert.equal(await f.git(m.remote, "show", `${m.branch}:contract.txt`), "v3");
    assert.equal(await f.git(m.remote, "rev-parse", m.base), m.baseSha, "base branch must remain untouched");
  }
  const receipts = await f.receipts();
  for (const name of ["alpha", "beta"]) {
    const turns = receipts.filter(r => r.role === name);
    assert.ok(turns.length >= 3, "initial review, reply, and fresh review of all PRs");
    assert.deepEqual(turns[0].values, ["v1", "v2"]);
    assert.ok(turns[0].diffs.every(d => d.includes("contract.txt")));
    assert.deepEqual(turns.at(-1).values, ["v3", "v3"]);
    assert.deepEqual(turns.at(-1).heads, Object.values(run.target.reviewedCommits));
  }
  const events = await readEvents(dir);
  assert.deepEqual(events.filter(e => e.t === "commit.pushed").map(e => [e.pr, e.pushed]), [["PR1", true], ["PR2", true]]);
  assert.ok(run.exchanges.every(e => e.pr === "PR1"));
  if (process.env.JURY_KEEP_FIXTURE) console.log(`GROUP_FIXTURE=${f.root}\nGROUP_RUN=${dir}`);
});

test("local-only fixes survive resume, preserve the push setting, and can be published explicitly", async t => {
  const f = await groupFixture(t);
  assert.equal((await f.review(["--push=false"])).code, 0);
  let saved = await f.saved();
  assert.equal(saved.run.target.state, "converged");
  const workspace = saved.run.target.workspace;
  assert.equal(saved.run.target.pushEnabled, false);
  for (const m of f.members) assert.equal(await f.git(m.remote, "rev-parse", m.branch), m.sha);
  const resumed = await f.review(["--resume", saved.slug]);
  assert.equal(resumed.code, 0, resumed.stderr);
  saved = await f.saved();
  assert.equal(saved.run.target.workspace, workspace);
  assert.equal(saved.run.target.pushEnabled, false);
  for (const m of f.members) assert.equal(await f.git(m.remote, "rev-parse", m.branch), m.sha);
  const pushed = await f.review(["--resume", saved.slug, "--push=true"]);
  assert.equal(pushed.code, 0, pushed.stderr);
  for (const m of f.members) assert.equal(await f.git(m.remote, "show", `${m.branch}:contract.txt`), "v3");
});

test("a partial push failure cannot converge; retained commits can be resumed after recovery", async t => {
  const f = await groupFixture(t);
  const hook = path.join(f.members[1].remote, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\necho 'fixture push rejected' >&2\nexit 1\n", { mode: 0o755 });
  const failed = await f.review();
  assert.doesNotMatch(failed.stdout, /REVIEW COMPLETE/);
  const saved = await f.saved();
  assert.equal(saved.run.target.state, "human");
  const commits = conversation(await readEvents(saved.dir))[0].turns.filter(t => t.kind === "commit");
  assert.deepEqual(commits.map(t => [t.pr, t.pushed]), [["PR1", true], ["PR2", false]]);
  assert.equal(await f.git(f.members[1].remote, "rev-parse", f.members[1].branch), f.members[1].sha);
  assert.equal((await readFile(path.join(saved.run.target.workspace, "PR2", "contract.txt"), "utf8")).trim(), "v3");
  await rm(hook);
  const resumed = await f.review(["--resume", saved.slug]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /REVIEW COMPLETE/);
  assert.equal(await f.git(f.members[1].remote, "show", `${f.members[1].branch}:contract.txt`), "v3");
});

test("a failed reviewer or an ambiguous finding cannot report completion", async t => {
  for (const env of [{ JURY_FIXTURE_FAIL: "beta" }, { JURY_BAD_LOCATION: "1" }]) {
    const f = await groupFixture(t);
    const result = await f.review(["--push=false"], env);
    assert.doesNotMatch(result.stdout, /REVIEW COMPLETE/);
    assert.equal((await f.saved()).run.target.state, "human");
  }
});

test("partial checkout failure removes the group and never launches agents", async t => {
  const f = await groupFixture(t);
  const result = await f.review([], { JURY_FIXTURE_MISSING: "client" });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(path.join(f.state, "checkouts")), []);
  await assert.rejects(f.receipts(), { code: "ENOENT" });
});

test("resume refuses a different PR set, concurrent use, and an independently changed remote", async t => {
  const f = await groupFixture(t);
  await f.review(["--push=false"]);
  const { run } = await f.saved();
  const urls = f.members.map(m => m.url);
  await assert.rejects(prepareGroup([...urls].reverse(), { previous: run.target }), /same PR URLs/);
  const held = await prepareGroup(urls, { previous: run.target });
  try { await assert.rejects(prepareGroup(urls, { previous: run.target }), /already running/); }
  finally { await held.cleanup(); }
  await f.git(f.members[0].remote, "update-ref", `refs/heads/${f.members[0].branch}`, f.members[0].baseSha);
  await assert.rejects(prepareGroup(urls, { previous: run.target, allowPush: true }), /remote branch changed/);
});

test("PR URLs are deduplicated without confusing identical PR numbers in different repositories", () => {
  const a = "https://github.com/a/repo/pull/7", b = "https://github.com/b/repo/pull/7";
  assert.deepEqual(reviewUrls([a, `${a}/files?x=1`, b], a), [a, b]);
  assert.notEqual(groupId([a, b]), groupId([b, a]));
  assert.throws(() => reviewUrls([a, "extra"]), /unexpected argument/);
});

test("duplicate source branches are rejected and read-only checkouts need no push target", async t => {
  const f = await groupFixture(t);
  const m = f.members[0];
  const resolve = async (_url, { makeTemp }) => {
    const worktree = await makeTemp();
    await f.git(f.root, "clone", "--quiet", m.remote, worktree);
    await f.git(worktree, "checkout", "--quiet", m.branch);
    return { worktree, branch: m.branch, trunk: m.base, sha: m.sha, pushTarget: { remote: "origin", branch: m.branch } };
  };
  const urls = f.members.map(m => m.url);
  await assert.rejects(prepareGroup(urls, { root: f.state, resolve }), /shares a source branch/);
  assert.deepEqual(await readdir(path.join(f.state, "checkouts")), []);
  const group = await prepareGroup(urls, { root: f.state, allowPush: false,
    resolve: async (...args) => ({ ...await resolve(...args), branch: null, pushTarget: null }) });
  try {
    await groupHead(group.targets);
    assert.equal(await groupReady(group.targets, false), null);
    await f.git(group.targets[0].worktree, "commit", "--allow-empty", "-qm", "unexpected reviewer commit");
    assert.match(await groupReady(group.targets, false), /HEAD changed during review/);
    await f.git(group.targets[0].worktree, "checkout", "-qb", "unexpected-branch");
    await assert.rejects(assertGroupCheckout(group.targets[0]), /refusing to commit or push/);
  } finally { await group.cleanup(); }
});

test("a stale task lock can be reclaimed by only one resumer", async t => {
  const f = await groupFixture(t);
  await f.review(["--push=false"]);
  const { run } = await f.saved();
  await writeFile(path.join(run.target.workspace, ".jury-lock"), "2147483647");
  const attempts = await Promise.allSettled([1, 2].map(() => prepareGroup(f.members.map(m => m.url), { previous: run.target })));
  const acquired = attempts.filter(r => r.status === "fulfilled");
  assert.equal(acquired.length, 1);
  await acquired[0].value.cleanup();
});
