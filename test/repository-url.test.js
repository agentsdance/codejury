import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const entry = process.env.JURY_TEST_CLI ? pathToFileURL(process.env.JURY_TEST_CLI) : new URL("../bin/jury.js", import.meta.url);
const { repositoryFromPrUrl, assertPrCheckout, resolvePrCheckout } = await import(new URL("../lib/repository.js", entry));
const { reviewUrls } = await import(new URL("../lib/review-group.js", entry));

const cases = [
  ["github.com", "acme/widgets", "pull", "42"],
  ["github.com", "wei/pull", "pull", "676"],
  ["github.com", "acme/merge_requests", "pull", "42"],
  ["github.com", "pull/widgets", "pull", "42"],
  ["github.com", "pull/123", "pull", "42"],
  ["github.com", "merge_requests/123", "pull", "42"],
  ["github.example.com", "acme/pull-tools", "pull", "42"],
  ["git.example.com", "acme/platform/widgets", "-/merge_requests", "195"],
  ["git.example.com", "acme/pull/widgets", "-/merge_requests", "195"],
  ["git.example.com", "acme/pull/123/widgets", "-/merge_requests", "195"],
  ["git.example.com", "acme/merge_requests/123/widgets", "-/merge_requests", "195"],
  ["git.example.com", "acme/merge_requests", "-/merge_requests", "195"],
  ["git.example.com", "acme/platform/widgets", "merge_requests", "195"],
  ["git.example.com", "acme/pull/widgets", "merge_requests", "195"],
  ["git.example.com", "acme/merge_requests", "merge_requests", "195"],
  ["git.example.com", "acme/platform/pull/123/widgets", "merge_requests", "195"],
  ["git.example.com", "acme/platform/merge_requests/123/widgets", "merge_requests", "195"],
];

for (const [host, repo, route, number] of cases) {
  test(`PR route preserves ${host}/${repo}/${route}/${number}`, async () => {
    const url = `https://${host}/${repo}/${route}/${number}`;
    const view = `${url}/${route === "pull" ? "files" : "diffs"}?view=1#note`;
    const identity = { host, path: repo, display: `${host}/${repo}` };
    assert.deepEqual(repositoryFromPrUrl(view), identity);
    assert.doesNotThrow(() => assertPrCheckout(view, `git@${host}:${repo}.git`, "/fixture"));
    assert.throws(() => assertPrCheckout(view, `git@${host}:unrelated/project.git`, "/fixture"), /PR targets/);
    assert.deepEqual(reviewUrls([url, view], url), [url]);

    const calls = [];
    const sha = "a".repeat(40);
    const exec = async (command, args) => {
      calls.push({ command, args });
      if (command === "gh" && args[0] === "pr") return { stdout: JSON.stringify({
        title: "fixture", state: "OPEN", baseRefName: "main", headRefName: "fix/it",
        headRefOid: sha, headRepository: { nameWithOwner: repo },
      }) };
      if (command === "git" && args[0] === "rev-parse") return { stdout: `${sha}\n` };
      if (command === "git" && args[0] === "symbolic-ref") return { stdout: "origin/main\n" };
      if (command === "git" && args[0] === "ls-remote") return { stdout: `${sha}\trefs/heads/fix/it\n` };
      if (command === "git" && args[0] === "remote") return { stdout: `git@${host}:${repo}.git\n` };
      return { stdout: "" };
    };
    const resolved = await resolvePrCheckout(view, { exec, dir: null, allowPush: false,
      makeTemp: async () => "/fixture/never-created", remove: async () => {} });
    assert.equal(resolved.sha, sha);
    assert.equal(resolved.trunk, "main");
    const github = route === "pull";
    assert.equal(calls.some(c => c.command === "gh"), github, "select the matching hosting route");
    const ref = `refs/${github ? "pull" : "merge-requests"}/${number}/head`;
    assert.ok(calls.some(c => c.command === "git" && c.args[0] === "fetch" && c.args.at(-1) === ref),
      "fetch the route's request number, not a numeric namespace component");
    if (github) assert.ok(calls.some(c => c.command === "gh" && c.args[0] === "repo" && c.args[2] === identity.display));
    else assert.ok(calls.some(c => c.command === "git" && c.args[0] === "clone" && c.args.includes(`https://${host}/${repo}.git`)));
    await resolved.cleanup();
  });
}

test("PR route parsing keeps invalid URL controls invalid", async () => {
  for (const url of ["not a URL", "https://github.com/acme/widgets", "https://github.com/acme/widgets/pull",
    "https://github.com/acme/widgets/pull/nope", "https://github.com/acme/pull/42",
    "https://git.example.com/acme/-/merge_requests/42", "https://git.example.com/acme/widgets/-/merge_requests/nope"]) {
    assert.equal(repositoryFromPrUrl(url), null, url);
    let called = false;
    await assert.rejects(resolvePrCheckout(url, { exec: async () => { called = true; throw new Error("unexpected command"); } }), /cannot resolve the PR head/);
    assert.equal(called, false, "invalid URLs fail before commands run");
  }
});
