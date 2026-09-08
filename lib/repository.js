// Bind a PR URL to the checkout that jury is about to read and modify.
//
// A URL is not just a label. Letting it name one repository while every git
// command runs in another can review, commit, and push unrelated code under the
// PR's name. Keep this check independent of a hosting CLI so it also works for
// self-hosted GitHub and GitLab instances.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

/**
 * Fetch a merge request's head, falling back to numbered revision refs.
 *
 * Not every GitLab-compatible host publishes refs/merge-requests/<id>/head.
 * Some expose the individual revisions instead, as
 * refs/merge-requests/<shard>/<id>/<revision>, where the highest revision is the
 * current head. Returns the advertised sha when that fallback was used, so the
 * caller can check the fetched commit against what the remote said: a request
 * updated mid-fetch would otherwise be reviewed as though it were the head.
 */
async function fetchMergeRequestHead(exec, worktree, number) {
  const options = { cwd: worktree };
  try {
    await exec("git", ["fetch", "origin", `refs/merge-requests/${number}/head`], options);
    return null;
  } catch (err) {
    // Only a genuinely absent ref justifies looking elsewhere. An auth or
    // transport failure keeps its own error, or every network problem would be
    // reported as an unusual ref layout.
    if (!/couldn't find remote ref/i.test(String(err.stderr ?? "") + String(err.message))) throw err;
    // The shard can differ from the MR id (and can contain leading zeroes).
    // Discover it rather than assuming a particular host's sharding scheme.
    const { stdout } = await exec("git", ["ls-remote", "--refs", "origin", `refs/merge-requests/*/${number}/*`], options);
    const revisions = String(stdout).split("\n").flatMap((line) => {
      const [sha, ref] = line.trim().split(/\s+/);
      const match = ref?.match(/^refs\/merge-requests\/\d+\/(\d+)\/([1-9]\d*)$/);
      if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha ?? "") || match?.[1] !== number) return [];
      const revision = match[2];
      // Numeric, so revision 10 sorts above revision 9 rather than beside 1.
      return /^[1-9]\d*$/.test(revision) ? [{ sha, ref, revision: BigInt(revision) }] : [];
    });
    revisions.sort((a, b) => (a.revision > b.revision ? -1 : a.revision < b.revision ? 1 : 0));
    if (!revisions.length) throw err; // no revisions either: the original error is the true one
    const latest = revisions[0];
    if (revisions.some(r => r.revision === latest.revision && r.sha !== latest.sha)) {
      throw new MergeRequestCheckoutError(`merge request !${number} has conflicting latest revision refs`);
    }
    await exec("git", ["fetch", "--quiet", "origin", latest.ref], options);
    return latest.sha;
  }
}

/**
 * Make origin/<trunk> resolvable in a clone taken from local disk. Best effort:
 * offline the review may still fail, but it fails saying so rather than
 * appearing to resolve and then diffing against a ref that is not there.
 */
async function ensureTrunkRef(worktree, trunk, { exec }) {
  try {
    await exec("git", ["rev-parse", "--verify", `refs/remotes/origin/${trunk}^{commit}`], { cwd: worktree });
    return;
  } catch { /* not present: try to bring it in */ }
  try {
    await exec("git", ["fetch", "--quiet", "origin",
      `refs/heads/${trunk}:refs/remotes/origin/${trunk}`], { cwd: worktree });
  } catch { /* offline: leave it, the review reports the real failure */ }
}

/**
 * Whether a repository already contains a specific commit — and is the
 * repository the request actually names. The identity check is not optional:
 * an unrelated checkout holding the same commit would be reviewed under this
 * request's name.
 */
async function hasCommit(dir, sha, { exec, target }) {
  if (!dir || !sha || !await sameRepository(dir, target, { exec })) return false;
  try {
    await exec("git", ["-C", dir, "rev-parse", "--verify", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit a merge request points at, if this machine already has it.
 *
 * The head ref is the fragile part of resolving a merge request: GitLab prunes
 * refs/merge-requests/<id>/head once a request is merged or old, so fetching it
 * fails for requests that are otherwise perfectly reviewable. A repository that
 * already contains the commits does not need that ref at all — and reviewing a
 * branch you already have is the common case, not the exception.
 *
 * Read-only by construction: this resolves a revision and never checks anything
 * out, because `jury <url>` run from master must not move the caller's tree.
 */
/**
 * Whether a directory is a checkout of the repository the URL names.
 *
 * The URL names one repository; a local checkout of a DIFFERENT one that
 * happens to hold the same ref or commit would review unrelated code under this
 * request's name. Every local shortcut passes through here first.
 */
async function sameRepository(dir, target, { exec }) {
  if (!dir || !target) return false;
  try {
    const { stdout } = await exec("git", ["-C", dir, "remote", "-v"]);
    return String(stdout).split("\n").some((line) => {
      const url = line.split(/\s+/)[1];
      return url && repositoryFromRemote(url)?.display === target.display;
    });
  } catch {
    return false; // not a repository, or no remotes: nothing to match against
  }
}

async function localHead(dir, target, number, { exec, namespace, branch = null }) {
  if (!dir || !await sameRepository(dir, target, { exec })) return null;

  // Only the numbered ref. FETCH_HEAD was also consulted here, and it is not
  // evidence of anything: it holds whatever the last fetch left behind, which
  // after `git fetch origin main` is main. That resolved the wrong commit under
  // this request's name, and — since branchAtHead then matched main on the
  // remote — could make main the push target of a review that never examined it.
  try {
    const { stdout } = await exec(
      "git", ["-C", dir, "rev-parse", "--verify", `${namespace}/${number}/head^{commit}`],
    );
    if (stdout.trim()) return stdout.trim();
  } catch { /* an ordinary clone has no numbered ref; try the branch below */ }

  // The numbered ref is the exception, not the rule: a normal clone or a
  // source-branch checkout has none of them, only branches. Requiring it made
  // this path unreachable for exactly the people the error told to "check out
  // the source branch and pass --dir" — advice that could not work.
  if (!branch) return null;
  for (const rev of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--verify", `${rev}^{commit}`]);
      if (stdout.trim()) return stdout.trim();
    } catch { /* try the next candidate */ }
  }
  return null;
}

async function resolveMergeRequestCheckout(prUrl, target, number, {
  allowPush, exec, makeTemp, remove, dir, home = homedir(),
}) {
  // Where the clone lands when one is needed: the same ~/.jury the rest of the
  // CLI already uses, rather than the system temp directory. The checkout is
  // still removed when the review ends — this puts jury's working files under
  // one predictable, inspectable root, and does not make them persist.
  const worktree = await makeTemp(path.join(home, ".jury", "checkouts", `jury-mr-${number}-`));
  let advertisedSha = null;
  // Refresh the cached ref before trusting it. A ref fetched before the author
  // pushed again names an obsolete head, and nothing about matching repository
  // identity makes it current — a silent review of superseded code. When the
  // refresh fails (offline, pruned) the cached ref is still better than nothing,
  // which is the whole point of the local path.
  if (dir && await sameRepository(dir, target, { exec })) {
    try {
      await exec("git", ["-C", dir, "fetch", "--quiet", "origin",
        `refs/merge-requests/${number}/head:refs/merge-requests/${number}/head`, "--force"]);
    } catch { /* keep whatever is cached */ }
  }
  const local = await localHead(dir, target, number, { exec, namespace: "refs/merge-requests" });
  try {
    if (local) {
      // The commits are already here. Clone from disk rather than the network:
      // no credentials, no head ref, and nothing the host may have pruned.
      await exec("git", ["clone", "--quiet", "--no-checkout", dir, worktree]);
      await exec("git", ["checkout", "--quiet", "-b", `jury-mr-${number}`, local], { cwd: worktree });
      // Cloning from disk points origin at a filesystem path. Left alone, the
      // branch lookup below would read the local clone and pushTarget would
      // push into it — a review that never reaches the real remote. Repoint
      // origin at the repository the URL actually names.
      await exec("git", ["remote", "set-url", "origin",
        cloneUrlForMergeRequest(prUrl, target.path)], { cwd: worktree });
    } else {
      await exec("git", ["clone", "--quiet", "--no-checkout", cloneUrlForMergeRequest(prUrl, target.path), worktree]);
      advertisedSha = await fetchMergeRequestHead(exec, worktree, number);
      await exec("git", ["checkout", "--quiet", "-b", `jury-mr-${number}`, "FETCH_HEAD"], { cwd: worktree });
    }

    const { stdout: actualOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
    const sha = actualOut.trim();
    if (advertisedSha && sha !== advertisedSha) {
      throw new MergeRequestCheckoutError(
        `merge request !${number} changed while it was being fetched; run the review again`,
      );
    }
    // origin/HEAD comes from the clone SOURCE. Cloning the caller's repository
    // copies whatever they had checked out, so a user sitting on the request's
    // own source branch got that branch reported as trunk — and the review then
    // diffed the branch against itself and saw nothing. Ask the real remote
    // when the clone came from disk; fall back to the copied ref offline.
    let trunk = "";
    if (local) {
      try {
        const { stdout } = await exec("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: worktree });
        trunk = String(stdout).match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? "";
      } catch { /* offline: fall through to the local ref */ }
    }
    if (!trunk && !local) {
      // Only for a network clone, where origin/HEAD came from the host. In a
      // clone taken from disk it was copied from whatever the caller had
      // checked out — often this request's own source branch, which would make
      // the review diff the branch against itself and report an empty change.
      const { stdout: trunkOut } = await exec(
        "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: worktree },
      );
      trunk = trunkOut.trim().replace(/^origin\//, "");
    }
    // A network clone with no default branch is a broken repository, and saying
    // so is right. A local clone that simply could not reach the host is not:
    // the CLI applies its own --trunk after this returns, so failing here would
    // refuse a run the user had already told where trunk is. Leave it empty and
    // let that flag win; the CLI reports a missing trunk itself if there is none.
    if (!trunk && !local) throw new MergeRequestCheckoutError(
      `merge request !${number} repository has no default branch`,
    );

    // Only when a push target is actually needed. This ran unconditionally, so
    // a --no-push review with every commit already on disk still failed the
    // moment the network was unreachable — the one case the local path exists
    // to serve.
    let branch = null;
    if (allowPush) {
      const { stdout: headsOut } = await exec("git", ["ls-remote", "--heads", "origin"], { cwd: worktree });
      branch = branchAtHead(headsOut, sha);
    }
    if (allowPush && !branch) {
      throw new MergeRequestCheckoutError(
        `Fetched merge request !${number}, but couldn't identify a single source branch to push fixes to.\n` +
        "The branch may have been deleted or moved to a different commit, or multiple branches may match.\n\n" +
        "You can still review this commit. Add --no-push to your command and run it again.\n" +
        "This allows local fixes but does not push them to the remote repository.",
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
    // Preserve the diagnostic even when a connection warning precedes it.
    // Missing refs alone do not establish whether an MR is open or closed.
    const said = [err.stderr, err.message].map((t) => String(t ?? "").trim()).find(Boolean) ?? "";
    const missingRef = /couldn't find remote ref|no matching remote head/i.test(said);
    throw new Error(
      `could not resolve ${target.display} merge request !${number}: ${said}\n` +
      (missingRef
        ? "No usable merge request ref was found. Check out the source branch locally, omit the MR URL, " +
          "and run jury --dir /path/to/checkout --trunk <target-branch>."
        : "check Git authentication and refs/merge-requests support, or check out the source branch and pass --dir"),
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
  // Creates the parent too: a checkout under ~/.jury has a directory that may
  // not exist yet, and a caller that injects this must not need the real one.
  makeTemp = async (prefix) => {
    await mkdir(path.dirname(prefix), { recursive: true });
    return mkdtemp(prefix);
  },
  remove = (dir) => rm(dir, { recursive: true, force: true }),
  // The caller's checkout, when it has one. Consulted before the network: a
  // repository that already holds the request's commits needs no head ref.
  dir = null,
  home = homedir(),
} = {}) {
  const target = repositoryFromPrUrl(prUrl);
  const number = githubNumber(prUrl);
  const mrNumber = mergeRequestNumber(prUrl);
  if (target && mrNumber) {
    return resolveMergeRequestCheckout(prUrl, target, mrNumber, {
      allowPush, exec, makeTemp, remove, dir, home,
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

  const worktree = await makeTemp(path.join(home, ".jury", "checkouts", `jury-pr-${number}-`));
  // `gh` already gave the authoritative head oid, so that — not a cached ref —
  // is what to look for locally. Consulting refs/pull/<id>/head first checked
  // out whatever it pointed at when it was last fetched, which then failed the
  // assertion below: a stale ref blocked a review whose real head was sitting
  // in the same repository.
  // `gh` gives both the oid and the branch name, so a plain checkout of the PR
  // branch resolves here without any refs/pull ref existing.
  const local = dir && await hasCommit(dir, details.headRefOid, { exec, target })
    ? details.headRefOid
    : await localHead(dir, target, number, {
      exec, namespace: "refs/pull", branch: details.headRefName,
    });
  try {
    if (local) {
      await exec("git", ["clone", "--quiet", "--no-checkout", dir, worktree]);
      await exec("git", ["checkout", "--quiet", "-b", `jury-pr-${number}`, local], { cwd: worktree });
      await exec("git", ["remote", "set-url", "origin", cloneUrlForMergeRequest(prUrl, target.path)],
        { cwd: worktree });
      // Same as the merge request path: a clone of a developer's checkout has
      // their local branches, not origin/<base>, and every review prompt needs it.
      await ensureTrunkRef(worktree, details.baseRefName, { exec });
    } else {
      await exec("gh", ["repo", "clone", target.display, worktree, "--", "--quiet"]);
      await exec("git", ["fetch", "origin", `refs/pull/${number}/head`], { cwd: worktree });
      await exec("git", ["checkout", "--quiet", "-b", `jury-pr-${number}`, "FETCH_HEAD"], { cwd: worktree });
    }

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
