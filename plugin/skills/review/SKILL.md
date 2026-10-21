---
name: review
description: Run a Code Jury review of a pull request — independent AI reviewers report findings, one judge triages and fixes them, and the loop repeats until the reviewers agree there is nothing new.
argument-hint: "[pr-url ...] [jury flags]"
disable-model-invocation: true
---

# Code Jury review

Run the Code Jury CLI on: `$ARGUMENTS`

## 1. Find the CLI

Use `jury` when `command -v jury` finds it. Otherwise run it without installing, as
`npx -y @agentsdance/codejury`. It needs Node.js 20.10 or newer and npm; if neither works, explain
which prerequisite is missing and how to install it. Use the same CLI prefix for every command
below, including `agents`, `runs`, and reopening the console.

## 2. Build the command

Start from `jury review` (or `npx -y @agentsdance/codejury review`), then preserve the user's
arguments and quote each value safely for the shell. Do not evaluate argument text as shell code.

- One or more PR URLs review those PRs. With none, Jury reviews the current Git checkout's branch
  against its trunk, or uses the location/run selected by `--dir` or `--resume`. Let Jury resolve
  the target; if it reports that no repository or target can be found, ask for a checkout or PR URL.
- Add `--web=true` unless the arguments already set `--web`. Open the browser console by default;
  an explicit `--web=false` or `--web false` disables it.
- Add `--push=false` unless the arguments already set `--push`. Jury pushes fixes by default; pushing
  from inside this session should be the user's explicit choice. Say that you added it.

Recognize both `--push=false` and `--push false`, as well as bare `--push` or `--web` (true).
For example, preserve `--push false` and `--web=false` without appending conflicting defaults.
Explain that `--push=false` still lets the judge edit files and Jury create local commits.

Do not choose reviewers, a judge or models for the user; Jury already applies the flags, the
repository's `jury.config.json` and the saved defaults (`jury agents`).

## 3. Run it

Print the command, then run it with the Bash tool in the background: a review runs several agent
CLIs for several rounds and can take many minutes. Before agents start, Jury prints the selected
judge and reviewers; report them. Read the initial output until the console URL appears, then
share that exact URL as a clickable Markdown link, including its port and run query parameter.
Do not guess the URL. Skip this step when the user disabled the console. If it stops early (a
missing or unauthenticated agent CLI, a missing `gh` login for a GitHub URL), show the error and
the fix it names; `jury agents` lists which agent CLIs are installed.

Monitor the background output while the review runs. With the console enabled, do not rely on a
background-task completion notification: the server keeps the process alive after review ends.

## 4. Report

When Jury announces review completion or a stopped/incomplete review, summarize from the output:
the rounds run, each reviewer's findings with the judge's verdict (accepted, deferred or rejected),
the commits the judge made, and whether they were pushed. Distinguish convergence from a failed,
interrupted, or round-limited run. Report the result
without waiting for the console to exit, include its link again, and leave it running so the user
can inspect the review. Do not stop the console unless the user asks.

Every run is saved locally: `jury runs` lists them, and `jury --web-only` reopens the console to read
the full prompts, reports and verdicts. Retain any `--dir` used for the review in these commands and
select the reported run with `--run` when opening the console. Include the checkout path for local
commits so the user can inspect or publish them later.

Do not fix the findings yourself, and do not edit the files Jury is working on while it runs:
the judge owns the fixes for this review.
