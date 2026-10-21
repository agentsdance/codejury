import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const trunkRef = trunk => `refs/remotes/origin/${trunk}`;

// --trunk names a branch, not an arbitrary revision. Check it before launching
// agents, including the shared ancestry required by a branch review.
export async function assertTrunk(worktree, trunk) {
  const git = (...args) => exec('git', args, { cwd: worktree });
  try {
    if (!trunk) throw new Error('missing branch');
    await git('check-ref-format', `refs/heads/${trunk}`);
    await git('rev-parse', '--verify', `${trunkRef(trunk)}^{commit}`);
    await git('merge-base', 'HEAD', trunkRef(trunk));
  } catch {
    throw new Error(`invalid trunk ${JSON.stringify(trunk)}: expected a bare branch name with an available origin tracking ref and a merge base with HEAD. Use --trunk master (not origin/master or refs/remotes/origin/master), and fetch the base branch if needed.`);
  }
}

export function diffCommand(trunk, worktree) {
  // Git computes the merge base itself. Unlike $(git merge-base ...), a failed
  // lookup cannot silently become `git diff HEAD` and hide committed changes.
  return `git${worktree ? ` -C ${quote(worktree)}` : ''} diff ${quote(`${trunkRef(trunk)}...HEAD`)} --`;
}
