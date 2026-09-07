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
    (err) => {
      assert.match(err.message, /^resolved merge request !7, but its source branch/);
      assert.match(err.message, /--no-push/);
      assert.doesNotMatch(err.message, /could not resolve/);
      return true;
    },
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

test("a merge request already in the caller's repository resolves without the head ref", async () => {
  const head = "3ca15f0dd883a810f31c87b54627d0fe41bcdacf";
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args: args.join(" "), cwd: options?.cwd });
    const a = args.join(" ");
    if (a.includes("remote -v")) {
      return { stdout: "origin\thttps://git.example.com/acme/platform/widgets.git (fetch)\n" };
    }
    if (a.includes("rev-parse --verify")) return { stdout: `${head}\n` };
    if (args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    if (args[0] === "ls-remote") return { stdout: `${head}\trefs/heads/fix/widget\n` };
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/platform/widgets/-/merge_requests/195",
    {
      exec, dir: "/repos/widgets", home: "/home/dev",
      makeTemp: async (prefix) => prefix + "test", remove: async () => {},
    },
  );

  assert.equal(resolved.sha, head);
  // The whole point: a host that pruned refs/merge-requests/195/head cannot
  // break a review whose commits are already on this machine.
  assert.ok(!calls.some((c) => c.args.startsWith("fetch")));
  assert.ok(calls.some((c) => c.args.includes("clone --quiet --no-checkout /repos/widgets")));
  // Cloning from disk leaves origin pointing at a filesystem path; pushing
  // there would never reach the real remote.
  assert.ok(calls.some((c) =>
    c.args === "remote set-url origin https://git.example.com/acme/platform/widgets.git"));
  assert.ok(resolved.worktree.startsWith("/home/dev/.jury/checkouts/"));
});

test("a local repository for a different project is never reviewed under this request's name", async () => {
  const calls = [];
  const exec = async (command, args) => {
    const a = args.join(" ");
    calls.push(a);
    // The caller is sitting in an unrelated repository that happens to have a
    // ref by the same number. Trusting it would review the wrong code.
    if (a.includes("remote -v")) {
      return { stdout: "origin\thttps://git.example.com/acme/other-project.git (fetch)\n" };
    }
    if (a.includes("rev-parse --verify")) return { stdout: "cafebabe\n" };
    if (args[0] === "rev-parse") return { stdout: "deadbeef\n" };
    if (args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    if (args[0] === "ls-remote") return { stdout: "deadbeef\trefs/heads/fix/widget\n" };
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/platform/widgets/-/merge_requests/195",
    { exec, dir: "/repos/unrelated", home: "/home/dev",
      makeTemp: async (prefix) => prefix + "test", remove: async () => {} },
  );

  assert.equal(resolved.sha, "deadbeef");
  assert.ok(calls.some((a) => a.includes("clone --quiet --no-checkout https://git.example.com/acme/platform/widgets.git")));
  assert.ok(!calls.some((a) => a.includes("clone --quiet --no-checkout /repos/unrelated")));
});

test("a pruned merge request head ref is reported as pruned, not as an auth problem", async () => {
  const exec = async (command, args) => {
    if (args.join(" ").startsWith("fetch")) {
      const err = new Error("Command failed: git fetch origin refs/merge-requests/1/head");
      err.stderr = "fatal: couldn't find remote ref refs/merge-requests/1/head";
      throw err;
    }
    return { stdout: "" };
  };

  await assert.rejects(
    resolvePrCheckout("https://git.example.com/acme/widgets/-/merge_requests/1",
      { exec, dir: null, home: "/home/dev",
        makeTemp: async (prefix) => prefix + "test", remove: async () => {} }),
    (err) => {
      // git's own words survive, and the guidance names the real cause.
      assert.match(err.message, /couldn't find remote ref/);
      assert.match(err.message, /hosts prune it once a request is merged or old/);
      assert.doesNotMatch(err.message, /check Git authentication/);
      return true;
    },
  );
});

test("FETCH_HEAD is never accepted as a merge request head", async () => {
  const calls = [];
  const exec = async (command, args) => {
    const a = args.join(" ");
    calls.push(a);
    if (a.includes("remote -v")) {
      return { stdout: "origin\thttps://git.example.com/acme/widgets.git (fetch)\n" };
    }
    // The numbered ref is absent; FETCH_HEAD holds main from an earlier fetch.
    if (a.includes("rev-parse --verify refs/merge-requests/")) throw new Error("no such ref");
    if (a.includes("rev-parse --verify FETCH_HEAD")) return { stdout: "ma11111111111111111111111111111111111111\n" };
    if (args[0] === "rev-parse") return { stdout: "de11111111111111111111111111111111111111\n" };
    if (args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    if (args[0] === "ls-remote") return { stdout: "de11111111111111111111111111111111111111\trefs/heads/fix/widget\n" };
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/widgets/-/merge_requests/195",
    { exec, dir: "/repos/widgets", home: "/home/dev",
      makeTemp: async (prefix) => prefix + "test", remove: async () => {} },
  );

  // Falling back to FETCH_HEAD would have reviewed main under !195's name, and
  // branchAtHead could then have made main the push target.
  assert.ok(!calls.some((a) => a.includes("checkout --quiet -b jury-mr-195 ma1111")));
  assert.ok(calls.some((a) => a.startsWith("fetch origin refs/merge-requests/195/head")));
  assert.equal(resolved.sha, "de11111111111111111111111111111111111111");
});

test("trunk comes from the real remote, not the branch the caller had checked out", async () => {
  const head = "3ca15f0dd883a810f31c87b54627d0fe41bcdacf";
  const exec = async (command, args) => {
    const a = args.join(" ");
    if (a.includes("remote -v")) {
      return { stdout: "origin\thttps://git.example.com/acme/widgets.git (fetch)\n" };
    }
    if (a.includes("rev-parse --verify")) return { stdout: `${head}\n` };
    if (args[0] === "rev-parse") return { stdout: `${head}\n` };
    // The clone source had the request's own branch checked out, so the copied
    // origin/HEAD names it. Believing that diffs the branch against itself.
    if (args[0] === "symbolic-ref") return { stdout: "origin/fix/widget\n" };
    if (a.startsWith("ls-remote --symref")) {
      return { stdout: "ref: refs/heads/main\tHEAD\n" };
    }
    if (args[0] === "ls-remote") return { stdout: `${head}\trefs/heads/fix/widget\n` };
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/widgets/-/merge_requests/195",
    { exec, dir: "/repos/widgets", home: "/home/dev",
      makeTemp: async (prefix) => prefix + "test", remove: async () => {} },
  );
  assert.equal(resolved.trunk, "main");
});

test("a --no-push review of local commits touches the network for nothing", async () => {
  const head = "3ca15f0dd883a810f31c87b54627d0fe41bcdacf";
  const exec = async (command, args) => {
    const a = args.join(" ");
    if (a.includes("remote -v")) {
      return { stdout: "origin\thttps://git.example.com/acme/widgets.git (fetch)\n" };
    }
    if (a.includes("rev-parse --verify")) return { stdout: `${head}\n` };
    if (args[0] === "rev-parse") return { stdout: `${head}\n` };
    if (args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
    // Every network operation is unreachable. A read-only review of commits
    // already on disk must still succeed.
    if (args[0] === "ls-remote" || args[0] === "fetch") throw new Error("offline");
    return { stdout: "" };
  };

  const resolved = await resolvePrCheckout(
    "https://git.example.com/acme/widgets/-/merge_requests/195",
    { allowPush: false, exec, dir: "/repos/widgets", home: "/home/dev",
      makeTemp: async (prefix) => prefix + "test", remove: async () => {} },
  );
  assert.equal(resolved.sha, head);
  assert.equal(resolved.pushTarget, null);
});
