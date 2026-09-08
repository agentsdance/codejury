// A related-PR task shares one agent workspace while keeping every Git history separate.
import { mkdir, mkdtemp, rm, readFile, writeFile, open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolvePrCheckout, repositoryFromPrUrl, repositoryFromRemote } from "./repository.js";
const exec = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const git = async (target, ...args) => (await exec("git", args, { cwd: target.worktree })).stdout.trim();

export function reviewUrls(positionals, flag) {
  const urls = [...(flag ? [flag] : []), ...positionals];
  for (const url of urls) {
    if (!/^https?:\/\//.test(url)) throw new Error(`unexpected argument "${url}" — pass pull request URLs`);
  }
  // Ignore view suffixes, query strings and fragments when identifying the same PR.
  return [...new Set(urls.map(url => {
    const match = url.match(/^(https?:\/\/[^?#]+?\/(?:pull|merge_requests)\/\d+)(?:\/[^?#]*)?(?:[?#].*)?$/);
    return match?.[1] ?? url;
  }))];
}

export function groupId(urls) {
  return createHash("sha256").update(JSON.stringify(urls)).digest("hex").slice(0, 16);
}

async function lock(workspace) {
  const file = path.join(workspace, ".jury-lock");
  try {
    const handle = await open(file, "wx");
    await handle.writeFile(String(process.pid)); await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`task lock needs inspection: ${file}`);
    try { process.kill(pid, 0); }
    catch (e) {
      if (e.code !== "ESRCH") throw e;
      // Serialize stale-lock recovery so a second reclaimer cannot unlink a new owner's lock.
      const reclaim = `${file}.reclaim`;
      const guard = await open(reclaim, "wx").catch(() => { throw new Error(`task lock recovery needs inspection: ${reclaim}`); });
      try {
        const current = Number(await readFile(file, "utf8"));
        try { process.kill(current, 0); }
        catch (dead) {
          if (dead.code !== "ESRCH") throw dead;
          await rm(file);
          return await lock(workspace);
        }
        throw new Error(`this review task is already running (pid ${current})`);
      } finally { await guard.close(); await rm(reclaim, { force: true }); }
    }
    throw new Error(`this review task is already running (pid ${pid})`);
  }
  return () => rm(file, { force: true });
}

export async function prepareGroup(urls, { root, dir, allowPush, trunk, previous,
  resolve = resolvePrCheckout } = {}) {
  if (trunk) throw new Error("multiple PRs use their own base branches; omit --trunk");
  if (previous) {
    if (!previous.workspace || JSON.stringify(previous.targets?.map(t => t.url)) !== JSON.stringify(urls)) {
      throw new Error("--resume requires the same PR URLs in the same order as the original task");
    }
    const cleanup = await lock(previous.workspace);
    try {
      const targets = structuredClone(previous.targets);
      for (const t of targets) {
        if (await git(t, "branch", "--show-current") !== t.checkoutBranch ||
            await git(t, "remote", "get-url", (t.pushTarget?.remote ?? "origin")) !== t.pushUrl) {
          throw new Error(`${t.key} checkout branch or push remote changed; start a new task`);
        }
        if (allowPush) {
          if (!t.pushTarget) throw new Error(`${t.key} has no known push target; start a new task with pushing enabled`);
          const remote = await remoteHead(t);
          const head = await git(t, "rev-parse", "HEAD");
          if (remote !== t.publishedSha && remote !== head) {
            throw new Error(`${t.key} remote branch changed since this task; start a new task to review it`);
          }
        }
      }
      await groupHead(targets);
      return { worktree: previous.workspace, targets, cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
  const base = path.join(root, "checkouts");
  await mkdir(base, { recursive: true });
  const worktree = await mkdtemp(path.join(base, "jury-group-"));
  const targets = [];
  try {
    const cleanup = await lock(worktree);
    for (const [i, url] of urls.entries()) {
      const key = `PR${i + 1}`;
      const resolved = await resolve(url, { root: worktree, dir, allowPush,
        makeTemp: async () => {
          const checkout = path.join(worktree, key);
          await mkdir(checkout);
          return checkout;
        },
      });
      const t = { key, url, repo: repositoryFromPrUrl(url)?.display,
        id: url.match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1], title: resolved.title ?? "",
        summary: resolved.summary ?? "", worktree: resolved.worktree, trunk: resolved.trunk,
        branch: resolved.branch, sha: resolved.sha, publishedSha: resolved.sha,
        pushTarget: resolved.pushTarget };
      if (!t.trunk) throw new Error(`${key} has no known base branch; resolve its remote HEAD before reviewing together`);
      t.checkoutBranch = await git(t, "branch", "--show-current");
      t.pushUrl = await git(t, "remote", "get-url", t.pushTarget?.remote ?? "origin");
      const identity = value => repositoryFromRemote(value)?.display ?? value;
      if (t.branch && targets.some(other => identity(other.pushUrl) === identity(t.pushUrl) && other.branch === t.branch)) {
        throw new Error(`${key} shares a source branch with another PR; review these requests separately`);
      }
      targets.push(t);
    }
    await writeFile(path.join(worktree, "README.md"), groupContext(targets));
    // Retain checkouts for resume, local-only commits, and failed pushes. Only release the lock.
    return { worktree, targets, cleanup };
  } catch (error) {
    await rm(worktree, { recursive: true, force: true });
    throw error;
  }
}

export async function groupHead(targets) {
  for (const t of targets) t.sha = await git(t, "rev-parse", "HEAD");
  return { sha: targets.map(t => `${t.key}=${t.sha}`).join(" "),
    commits: Object.fromEntries(targets.map(t => [t.key, t.sha])) };
}

async function remoteHead(t) {
  const out = await git(t, "ls-remote", "--exit-code", t.pushTarget.remote, `refs/heads/${t.branch}`);
  return out.split(/\s/)[0];
}

// A clean report must refer to committed code, and to published code when pushing is enabled.
export async function groupReady(targets, push) {
  try {
    for (const t of targets) {
      if (await git(t, "rev-parse", "HEAD") !== t.sha) return `${t.key} HEAD changed during review`;
      if (await git(t, "status", "--porcelain")) return `${t.key} has uncommitted changes`;
      if (await git(t, "branch", "--show-current") !== t.checkoutBranch) return `${t.key} checkout branch changed`;
      if (push && await remoteHead(t) !== t.sha) return `${t.key} reviewed HEAD has not reached its PR branch`;
    }
    return null;
  } catch (error) { return `could not verify PR branches: ${error.message.split("\n")[0]}`; }
}

// Retry retained, committed fixes only on an explicit resume. Pushes are always fast-forward.
export async function pushRetained(targets, onPush) {
  for (const t of targets) {
    if (t.sha === await remoteHead(t)) continue;
    if (await git(t, "status", "--porcelain")) throw new Error(`${t.key} has uncommitted changes; inspect its saved checkout before resuming with push`);
    await git(t, "push", t.pushTarget.remote, `HEAD:refs/heads/${t.branch}`);
    t.publishedSha = t.sha;
    await onPush?.(t);
  }
}

export function groupContext(targets) {
  return `Review these related PRs as ONE coordinated change. Assess every PR and their cross-PR dependencies and compatibility together.
Each PR has a separate checkout. Read each checkout's repository guidance. Do not merge their Git branches.
Use current HEAD in EACH checkout, comparing to its own merge base (never the trunk tip).
Use WHERE: PR1/path/to/file:line (or PR2/, etc.) for every finding. For a cross-PR issue, cite the primary location and name all affected PRs in the explanation.

${targets.map(t => `${t.key}: ${t.url}
Repository: ${t.repo}; branch ${t.branch} → ${t.trunk}; HEAD ${t.sha}
Checkout: ${t.worktree}
Title: ${t.title}
Description: ${t.summary || "(none supplied)"}
Diff: git -C ${quote(t.worktree)} diff $(git -C ${quote(t.worktree)} merge-base HEAD ${quote(`origin/${t.trunk}`)}) HEAD`).join("\n\n")}`;
}

export function findingPr(loc, targets = []) {
  return targets.find(t => String(loc ?? "").startsWith(`${t.key}/`))?.key ?? null;
}

export async function assertGroupCheckout(t) {
  if (await git(t, "branch", "--show-current") !== t.checkoutBranch ||
      await git(t, "remote", "get-url", t.pushTarget?.remote ?? "origin") !== t.pushUrl) {
    throw new Error(`${t.key} checkout branch or push remote changed; refusing to commit or push`);
  }
}
