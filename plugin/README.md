# Code Jury for Claude Code

Review and fix pull requests with a Claude reviewer and a separate Claude judge.

You need Node.js 20.10+, npm, Git, and a signed-in Claude Code CLI. GitHub PRs
also need a signed-in `gh` CLI. The plugin checks your global `jury` installation
and installs it globally if missing.

## Install

In your **terminal**, install the plugin and start a new Claude Code session:

```sh
claude plugin marketplace add agentsdance/codejury
claude plugin install codejury@codejury
claude
```

## Review

At the **Claude Code prompt**, enter this with your PR URL:

```text
/codejury:review https://github.com/owner/repo/pull/123
```

Claude starts the review, opens a browser console, and summarizes the findings
and fixes when it finishes. Both reviewer and judge use separate Claude sessions.
A PR URL is required.

**Pushing is off by default.** The judge can still edit and commit. Single-PR
checkouts are temporary; unpushed fixes are removed during cleanup.

Optional flags to add to the review command:

- `--push` — push fixes to the PR branch.
- `--rounds 3` — stop after at most three rounds.
- `--web=false` — skip the browser console, which otherwise stays open after review.

## Update

Run in your terminal, then start a new Claude Code session:

```sh
claude plugin marketplace update codejury
claude plugin update codejury@codejury
```

For saved results, resuming, and troubleshooting, see the
[CLI usage guide](https://github.com/agentsdance/codejury/blob/master/docs/usage.md).
