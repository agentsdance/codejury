// Bind a PR URL to the checkout that jury is about to read and modify.
//
// A URL is not just a label. Letting it name one repository while every git
// command runs in another can review, commit, and push unrelated code under the
// PR's name. Keep this check independent of a hosting CLI so it also works for
// self-hosted GitHub and GitLab instances.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function normalized(host, pathname) {
  const path = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (!host || !path) return null;
  return { host: host.toLowerCase(), path, display: `${host.toLowerCase()}/${path}` };
}

/** Repository identity carried by a GitHub or GitLab-style PR URL. */
export function repositoryFromPrUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((p) => p === "pull" || p === "merge_requests");
  if (marker < 2 || !/^\d+$/.test(parts[marker + 1] ?? "")) return null;

  const repo = parts.slice(0, marker);
  // Canonical GitLab links use /group/project/-/merge_requests/123.
  if (repo.at(-1) === "-") repo.pop();
  if (repo.length < 2) return null;
  return normalized(url.hostname, repo.join("/"));
}

/** Repository identity carried by an HTTPS, SSH URL, or scp-style git remote. */
export function repositoryFromRemote(value) {
  const remote = String(value ?? "").trim();
  const scp = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    return normalized(scp[1], scp[2]);
  }

  try {
    const url = new URL(remote);
    return normalized(url.hostname, url.pathname);
  } catch {
    return null;
  }
}

/** Refuse to let a PR URL label operations in an unrelated local checkout. */
export function assertPrCheckout(prUrl, remoteUrl, dir) {
  const target = repositoryFromPrUrl(prUrl);
  if (!target) {
    throw new Error(`cannot identify a pull request repository from "${prUrl}"`);
  }

  const checkout = repositoryFromRemote(remoteUrl);
  if (!checkout) {
    throw new Error(
      `PR targets ${target.display}, but ${dir} has no identifiable origin — ` +
      `run from that repository or pass --dir /path/to/its/checkout`,
    );
  }

  if (checkout.host !== target.host || checkout.path !== target.path) {
    throw new Error(
      `PR targets ${target.display}, but ${dir} is ${checkout.display} — ` +
      `run from the target repository or pass --dir /path/to/${target.path.split("/").at(-1)}`,
    );
  }
}

function githubNumber(prUrl) {
  try {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    const marker = parts.indexOf("pull");
    return marker >= 0 && /^\d+$/.test(parts[marker + 1] ?? "") ? parts[marker + 1] : null;
  } catch {
    return null;
  }
}

function mergeRequestNumber(prUrl) {
  try {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    const marker = parts.indexOf("merge_requests");
    return marker >= 0 && /^\d+$/.test(parts[marker + 1] ?? "") ? parts[marker + 1] : null;
  } catch {
    return null;
  }
}

function cloneUrlForMergeRequest(prUrl, repoPath) {
  const url = new URL(prUrl);
  url.pathname = `/${repoPath}.git`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function branchAtHead(stdout, sha) {
  const branches = String(stdout ?? "").split("\n").flatMap((line) => {
    const [hash, ref] = line.trim().split(/\s+/, 2);
    return hash === sha && ref?.startsWith("refs/heads/") ? [ref.slice(11)] : [];
  });
  return branches.length === 1 ? branches[0] : null;
}

class MergeRequestCheckoutError extends Error {}

async function resolveMergeRequestCheckout(prUrl, target, number, {
  allowPush, exec, makeTemp, remove,
}) {
  const worktree = await makeTemp(path.join(tmpdir(), `jury-mr-${number}-`));
  try {
    await exec("git", ["clone", "--quiet", "--no-checkout", cloneUrlForMergeRequest(prUrl, target.path), worktree]);
    await exec("git", ["fetch", "--quiet", "origin", `refs/merge-requests/${number}/head`], { cwd: worktree });
    await exec("git", ["checkout", "--quiet", "-b", `jury-mr-${number}`, "FETCH_HEAD"], { cwd: worktree });

    const { stdout: actualOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
    const sha = actualOut.trim();
    const { stdout: trunkOut } = await exec(
      "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: worktree },
    );
    const trunk = trunkOut.trim().replace(/^origin\//, "");
    if (!trunk) throw new MergeRequestCheckoutError(
      `merge request !${number} repository has no default branch`,
    );

    const { stdout: headsOut } = await exec("git", ["ls-remote", "--heads", "origin"], { cwd: worktree });
    const branch = branchAtHead(headsOut, sha);
    if (allowPush && !branch) {
      throw new MergeRequestCheckoutError(
        `resolved merge request !${number}, but its source branch is not uniquely available on origin — ` +
        "use --no-push for a read-only review, or check out the source branch and pass --dir",
      );
    }

    return {
      worktree,
      state: "OPEN",
      trunk,
      branch: branch ?? `merge-request/${number}`,
      sha,
      pushTarget: branch ? { remote: "origin", branch } : null,
      cleanup: () => remove(worktree),
    };
  } catch (err) {
    await remove(worktree);
    if (err instanceof MergeRequestCheckoutError) throw err;
    throw new Error(
      `could not resolve ${target.display} merge request !${number}: ${String(err.message).split("\n")[0]} — ` +
      "check Git authentication and refs/merge-requests support, or check out the source branch and pass --dir",
    );
  }
}

function remoteForRepository(origin, repoPath) {
  const scp = String(origin).match(/^((?:[^@/\s]+@)?[^:/\s]+):(.+)$/);
  if (scp && !/^[a-z][a-z\d+.-]*:\/\//i.test(origin)) return `${scp[1]}:${repoPath}.git`;
  const url = new URL(origin);
  url.pathname = `/${repoPath}.git`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Resolve a GitHub PR or GitLab-style MR to an isolated checkout of its exact head.
 *
 * The checkout is a clone rather than a mutation of the caller's repository:
 * running `jury <url>` from master (or from an unrelated repo) must not switch
 * that working tree out from under the user. The returned cleanup is owned by
 * the CLI and runs after the review finishes or fails.
 */
export async function resolvePrCheckout(prUrl, {
  allowPush = true,
  exec = run,
  makeTemp = mkdtemp,
  remove = (dir) => rm(dir, { recursive: true, force: true }),
} = {}) {
  const target = repositoryFromPrUrl(prUrl);
  const number = githubNumber(prUrl);
  const mrNumber = mergeRequestNumber(prUrl);
  if (target && mrNumber) {
    return resolveMergeRequestCheckout(prUrl, target, mrNumber, {
      allowPush, exec, makeTemp, remove,
    });
  }
  if (!target || !number) {
    throw new Error(
      `cannot resolve the PR head from "${prUrl}" automatically — ` +
      "supported URL forms are GitHub /pull/<id> and GitLab-style /merge_requests/<id>; " +
      "otherwise run from its checked-out branch with --dir",
    );
  }

  let details;
  try {
    const { stdout } = await exec("gh", [
      "pr", "view", prUrl, "--json",
      "title,body,state,baseRefName,headRefName,headRefOid,headRepository",
    ]);
    details = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `could not resolve ${target.display} pull request #${number}: ${String(err.message).split("\n")[0]} — ` +
      "check gh authentication, or check out the PR and pass --dir",
    );
  }

  const headRepo = details.headRepository?.nameWithOwner;
  if (!details.headRefOid || !details.headRefName || !details.baseRefName || !headRepo) {
    throw new Error(`pull request #${number} does not expose a usable head branch`);
  }
  if (allowPush && details.state !== "OPEN") {
    throw new Error(
      `pull request #${number} is ${String(details.state).toLowerCase()} — ` +
      "use --no-push for a read-only review",
    );
  }

  const worktree = await makeTemp(path.join(tmpdir(), `jury-pr-${number}-`));
  try {
    await exec("gh", ["repo", "clone", target.display, worktree, "--", "--quiet"]);
    await exec("git", ["fetch", "--quiet", "origin", `refs/pull/${number}/head`], { cwd: worktree });
    await exec("git", ["checkout", "--quiet", "-b", `jury-pr-${number}`, "FETCH_HEAD"], { cwd: worktree });

    const { stdout: actual } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
    if (actual.trim() !== details.headRefOid) {
      throw new Error(
        `resolved PR head ${details.headRefOid.slice(0, 12)}, but checked out ${actual.trim().slice(0, 12)}`,
      );
    }

    const { stdout: origin } = await exec("git", ["remote", "get-url", "origin"], { cwd: worktree });
    let pushRemote = "origin";
    if (headRepo !== target.path) {
      pushRemote = "pr-head";
      await exec("git", ["remote", "add", pushRemote, remoteForRepository(origin.trim(), headRepo)], { cwd: worktree });
    }

    return {
      worktree,
      title: details.title || undefined,
      summary: details.body ? details.body.replace(/\r/g, "").trim().slice(0, 4000) : undefined,
      state: details.state,
      trunk: details.baseRefName,
      branch: details.headRefName,
      sha: details.headRefOid,
      pushTarget: { remote: pushRemote, branch: details.headRefName },
      cleanup: () => remove(worktree),
    };
  } catch (err) {
    await remove(worktree);
    throw err;
  }
}
