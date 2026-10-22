import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareGroup } from "../lib/review-group.js";

const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? new URL("../bin/jury.js", import.meta.url).pathname;

async function repository(root, name, env) {
  const dir = path.join(root, name);
  await mkdir(dir);
  const git = async (...args) => (await exec("git", args, { cwd: dir, env })).stdout.trim();
  await git("init", "-q", "-b", "main");
  await writeFile(path.join(dir, "value.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "feature");
  await writeFile(path.join(dir, "value.txt"), "change\n");
  await git("commit", "-qam", "change");
  return { dir, git, sha: await git("rev-parse", "HEAD") };
}

test("related-PR metadata uses the routed request number", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "jury-route-group-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const urls = [
    "https://github.com/pull/123/pull/42",
    "https://git.example.com/acme/merge_requests/123/widgets/-/merge_requests/195",
  ];
  const repos = await Promise.all([repository(root, "github", env), repository(root, "gitlab", env)]);
  for (const [i, repo] of repos.entries()) await repo.git("remote", "add", "origin", path.join(root, `remote-${i}.git`));
  const group = await prepareGroup(urls, {
    root,
    allowPush: false,
    resolve: async url => {
      const index = urls.indexOf(url);
      const repo = repos[index];
      return { worktree: repo.dir, trunk: "main", branch: "feature", sha: repo.sha,
        title: "fixture", summary: "", cleanup: async () => {} };
    },
  });
  try {
    assert.deepEqual(group.targets.map(target => target.id), ["42", "195"]);
  } finally {
    await group.discard();
  }
});

test("CLI saves the routed GitHub request ID", { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "jury-route-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  await mkdir(bin);
  await mkdir(state);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const source = await repository(root, "source", env);
  await writeFile(path.join(source.dir, "jury.config.json"), JSON.stringify({ agents: [
    { name: "fixture-reviewer", role: "reviewer", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
    { name: "fixture-judge", role: "main", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
  ] }));
  await source.git("add", "jury.config.json");
  await source.git("commit", "-qm", "config");
  const head = await source.git("rev-parse", "HEAD");
  const remote = path.join(root, "source.git");
  await exec("git", ["clone", "--bare", "-q", source.dir, remote], { env });
  await exec("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env });
  await exec("git", ["--git-dir", remote, "update-ref", "refs/pull/42/head", head], { env });
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ title: "fixture", body: "", state: "OPEN", baseRefName: "main", headRefName: "feature", headRefOid: ${JSON.stringify(head)}, headRepository: { nameWithOwner: "pull/123" } }));
} else if (args[0] === "repo" && args[1] === "clone") {
  cp.execFileSync("git", ["clone", "--quiet", ${JSON.stringify(remote)}, args[3]]);
} else { console.error("unexpected gh command", args); process.exit(1); }
`, { mode: 0o755 });

  await exec(process.execPath, [cli, "review", "https://github.com/pull/123/pull/42",
    "--dir", state, "--web=false", "--push=false", "--rounds", "1",
    "--reviewer", "fixture-reviewer", "--judge", "fixture-judge"],
  { cwd: root, env, timeout: 15000 });
  const [slug] = await readdir(path.join(state, "runs"));
  const saved = JSON.parse(await readFile(path.join(state, "runs", slug, "run.json"), "utf8"));
  assert.equal(saved.target.id, "#42");
  assert.match(slug, /-42-/);
});
