---
name: review
description: Run a Code Jury review of a pull request — independent AI reviewers report findings, one judge triages and fixes them, and the loop repeats until the reviewers agree there is nothing new.
argument-hint: "<pr-url> [pr-url ...] [jury flags]"
disable-model-invocation: true
---

# Code Jury review

Run the Code Jury CLI on: `$ARGUMENTS`

## 1. Require a PR URL

This command supports PR reviews only. Require at least one PR URL, supplied as a positional
argument or with `--pr`. If none is provided, reply briefly: "Please provide the PR URL to review,
for example:" followed by:

```text
/codejury:review https://github.com/owner/repo/pull/123
```

Wait for the URL before finding or launching the CLI. Do not infer a PR from the current branch
or start a local review. Flags alone, including `--dir` or `--resume`, do not supply a review target.

## 2. Find the CLI

Use `jury` when `command -v jury` finds it. Otherwise run it without installing, as
`npx -y @agentsdance/codejury`. It needs Node.js 20.10 or newer and npm; if neither works, explain
which prerequisite is missing and how to install it. Use the same CLI prefix for every command
below, including `agents`, `runs`, and reopening the console.

## 3. Build the command

Start from `jury review` (or `npx -y @agentsdance/codejury review`). Normalize the role flags as
described below, preserve the remaining arguments, and quote each value safely for the shell.
Do not evaluate argument text as shell code.

- One or more PR URLs select the PRs to review. Let Jury resolve their checkouts. With a PR URL,
  `--dir` selects the checkout/state root. Resuming a run still requires its original PR URL(s).
- In Claude Code, always use Claude for both roles. Remove every supplied `--judge`, `--reviewer`,
  `--jury`, and legacy `--agents` option and its value, including repeated, comma-separated,
  space-separated, and `=` forms. Then add exactly one `--judge claude` and one
  `--reviewer claude`. Apply this to new and resumed runs. These per-run flags override saved CLI
  and repository role settings. Briefly report that Claude is both judge and jury.
- Add `--web=true` unless the arguments already set `--web`. Open the browser console by default;
  an explicit `--web=false` or `--web false` disables it.
- Add `--push=false` unless the arguments already set `--push`. Jury pushes fixes by default; pushing
  from inside this session should be the user's explicit choice. Say that you added it.

Recognize both `--push=false` and `--push false`, as well as bare `--push` or `--web` (true).
For example, preserve `--push false` and `--web=false` without appending conflicting defaults.
Explain that `--push=false` still lets the judge edit files and Jury create local commits.

Keep model and other non-role settings. Do not rewrite saved configuration to select these roles.
The judge and reviewer must run in separate Claude sessions: the reviewer stays read-only, and
only the judge may edit files. Do not combine their sessions or run another reviewer as a fallback.

## 4. Run it

Print the command, then run it with the Bash tool in the background: a review runs several agent
CLIs for several rounds and can take many minutes. Before agents start, Jury prints the selected
judge and reviewers; report them. Read the initial output until the console URL appears, then
share that exact URL as a clickable Markdown link, including its port and run query parameter.
Do not guess the URL. Skip this step when the user disabled the console. If it stops early (a
missing or unauthenticated agent CLI, a missing `gh` login for a GitHub URL), show the error and
the fix it names; `jury agents` lists which agent CLIs are installed.

Older CLIs, including 0.8.1, reject a reviewer that is also the judge. If that specific error
appears, explain that the installed CLI is too old and retry once using
`npx -y --package=git+https://github.com/agentsdance/codejury.git jury` with the same normalized
arguments. The repository CLI supports separate sessions for both roles. Use that CLI prefix
for subsequent commands too. If the retry fails, show the error; do not substitute another agent
or keep retrying. Explicitly disabled Claude or missing authentication still requires fixing
that prerequisite.

Monitor the background output while the review runs. With the console enabled, do not rely on a
background-task completion notification: the server keeps the process alive after review ends.

## 5. Report

When Jury announces review completion or a stopped/incomplete review, summarize from the output:
the rounds run, each reviewer's findings with the judge's verdict (accepted, deferred or rejected),
the commits the judge made, and whether they were pushed. Distinguish convergence from a failed,
interrupted, or round-limited run. Report the result without waiting for the console to exit,
include its link again, and leave it running so the user can inspect the review. Do not stop the
console unless the user asks.

Every run is saved locally: `jury runs` lists them, and `jury --web-only` reopens the console to read
the full prompts, reports and verdicts. Retain any `--dir` used for the review in these commands and
select the reported run with `--run` when opening the console. Single-PR checkouts are temporary;
their unpushed fixes are removed during cleanup. Do not promise that those commits remain available.

Do not fix the findings yourself, and do not edit the files Jury is working on while it runs:
Jury launches separate Claude CLI sessions for judge and reviewer, and only the judge owns fixes.
