import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertPrCheckout,
  repositoryFromPrUrl,
  repositoryFromRemote,
  resolvePrCheckout,
} from "../lib/repository.js";

const run = promisify(execFile);

test("GitHub and GitLab PR URLs retain the full repository identity", () => {
  assert.deepEqual(
    repositoryFromPrUrl("https://github.com/acme/widgets/pull/42"),
    { host: "github.com", path: "acme/widgets", display: "github.com/acme/widgets" },
  );
  assert.deepEqual(
    repositoryFromPrUrl("https://git.example.com/acme/platform/widgets/-/merge_requests/195"),
    {
      host: "git.example.com",
      path: "acme/platform/widgets",
      display: "git.example.com/acme/platform/widgets",
    },
  );
});

test("HTTPS and scp-style remotes normalize to the same identity", () => {
  assert.deepEqual(
    repositoryFromRemote("git@github.com:acme/widgets.git"),
    repositoryFromRemote("https://github.com/acme/widgets.git"),
  );
});

test("a PR cannot operate on an unrelated checkout", () => {
  assert.throws(
    () => assertPrCheckout(
      "https://git.example.com/example/project/merge_requests/195",
      "git@github.com:agentsdance/codejury.git",
      "/work/codejury",
    ),
    /PR targets git\.example\.com\/example\/project, but .* is github\.com\/agentsdance\/codejury.*--dir/,
  );
});

test("the CLI gives checkout guidance when a merge request clone fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-repo-binding-"));
  try {
    const g = (...args) => run("git", ["-C", dir, ...args]);
    await g("init", "-q", "-b", "master");
    await g("config", "user.email", "t@example.com");
    await g("config", "user.name", "t");
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await g("add", "-A");
    await g("commit", "-qm", "base");
    await g("remote", "add", "origin", "git@github.com:someone/other.git");

    const cli = path.resolve("bin/jury.js");
    await assert.rejects(
      run(process.execPath, [
        cli,
        "https://git.example.com/example/project/merge_requests/195",
        "--dir", dir,
        "--agents", "codex",
        "--rounds", "1",
        "--dry-run",
      ]),
      (err) => {
        assert.match(err.stderr, /could not resolve .* merge request !195/);
        assert.match(err.stderr, /check Git authentication.*source branch and pass --dir/);
        assert.doesNotMatch(err.stderr, /refusing --push onto master/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a GitHub PR is cloned and checked out at its exact head", async () => {
  const calls = [];
  let removed = null;
  const head = "a".repeat(40);
  const exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === "gh" && args[0] === "pr") {
      return { stdout: JSON.stringify({
        title: "Fix it",
        body: "The intent",
        state: "OPEN",
        baseRefName: "master",
        headRefName: "fix/it",
        headRefOid: head,
        headRepository: { nameWithOwner: "acme/widgets" },
      }) };
    }
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
      return { stdout: "git@github.com:acme/widgets.git\n" };
    }
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout("https://github.com/acme/widgets/pull/42", {
    exec,
    makeTemp: async () => "/tmp/jury-pr-42-test",
    remove: async (dir) => { removed = dir; },
  });

  assert.equal(resolved.worktree, "/tmp/jury-pr-42-test");
  assert.equal(resolved.branch, "fix/it");
  assert.equal(resolved.trunk, "master");
  assert.deepEqual(resolved.pushTarget, { remote: "origin", branch: "fix/it" });
  assert.ok(calls.some((c) => c.command === "gh" && c.args.join(" ").includes("repo clone github.com/acme/widgets")));
  assert.ok(calls.some((c) => c.command === "git" && c.args.includes("refs/pull/42/head")));
  assert.ok(calls.some((c) => c.command === "git" && c.args.includes("FETCH_HEAD")));

  await resolved.cleanup();
  assert.equal(removed, "/tmp/jury-pr-42-test");
});

test("a GitLab-style merge request is cloned and checked out from its standard ref", async () => {
  const calls = [];
  let removed = null;
  const head = "b".repeat(40);
  const exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (command === "git" && args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    if (command === "git" && args[0] === "ls-remote") {
      return { stdout: `${head}\trefs/heads/fix/widget\n` };
    }
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/platform/widgets/-/merge_requests/195",
    { exec, makeTemp: async () => "/tmp/jury-mr-195-test", remove: async (dir) => { removed = dir; } },
  );

  assert.equal(resolved.worktree, "/tmp/jury-mr-195-test");
  assert.equal(resolved.branch, "fix/widget");
  assert.equal(resolved.trunk, "main");
  assert.equal(resolved.sha, head);
  assert.deepEqual(resolved.pushTarget, { remote: "origin", branch: "fix/widget" });
  assert.ok(calls.some((c) => c.args.includes("https://git.example.com/acme/platform/widgets.git")));
  assert.ok(calls.some((c) => c.args.includes("refs/merge-requests/195/head")));

  await resolved.cleanup();
  assert.equal(removed, "/tmp/jury-mr-195-test");
});

test("a merge request with no unique source branch requires --no-push", async () => {
  const head = "c".repeat(40);
  const exec = async (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (command === "git" && args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    if (command === "git" && args[0] === "ls-remote") return { stdout: "" };
    return { stdout: "" };
  };
  await assert.rejects(
    resolvePrCheckout("https://git.example.com/acme/widgets/merge_requests/7", {
      exec, makeTemp: async () => "/tmp/jury-mr-7-test", remove: async () => {},
    }),
    /source branch is not uniquely available.*--no-push/,
  );

  const readOnly = await resolvePrCheckout(
    "https://git.example.com/acme/widgets/merge_requests/7",
    {
      allowPush: false, exec, makeTemp: async () => "/tmp/jury-mr-7-read-only-test",
      remove: async () => {},
    },
  );
  assert.equal(readOnly.branch, "merge-request/7");
  assert.equal(readOnly.pushTarget, null);
});
