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
      "git@github.com:zzxwill/multiple-agents-code-reivew.git",
      "/work/multiple-agents-code-reivew",
    ),
    /PR targets git\.example\.com\/example\/project, but .* is github\.com\/zzxwill\/multiple-agents-code-reivew.*--dir/,
  );
});

test("the CLI rejects a mismatched PR before the trunk push check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cr-repo-binding-"));
  try {
    const g = (...args) => run("git", ["-C", dir, ...args]);
    await g("init", "-q", "-b", "master");
    await g("config", "user.email", "t@example.com");
    await g("config", "user.name", "t");
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await g("add", "-A");
    await g("commit", "-qm", "base");
    await g("remote", "add", "origin", "git@github.com:someone/other.git");

    const cli = path.resolve("bin/cr.js");
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
        assert.match(err.stderr, /PR targets git\.example\.com\/example\/project/);
        assert.doesNotMatch(err.stderr, /refusing --push onto master/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
