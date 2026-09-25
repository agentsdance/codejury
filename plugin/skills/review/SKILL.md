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
`npx -y @agentsdance/codejury`. It needs Node.js 20 or newer; if neither works, tell the user to run
`npm install -g @agentsdance/codejury` and stop.

## 2. Build the command

Start from `jury review`, then add the arguments above unchanged:

- One or more PR URLs review those PRs. With none, Jury reviews the current Git checkout's branch
  against its trunk; if the working directory is not a Git repository, ask the user for a PR URL.
- Add `--web=false` unless the arguments already set `--web`. The browser console otherwise keeps
  the command running after the review finishes.
- Add `--push=false` unless the arguments already set `--push`. Jury pushes fixes by default; pushing
  from inside this session should be the user's explicit choice. Say that you added it.

Do not choose reviewers, a judge or models for the user; Jury already applies the flags, the
repository's `jury.config.json` and the saved defaults (`jury agents`).

## 3. Run it

Print the command, then run it with the Bash tool in the background: a review runs several agent
CLIs for several rounds and can take many minutes. Before agents start, Jury prints the selected
judge and reviewers; report them. If it stops early (a missing or unauthenticated agent CLI, a
missing `gh` login for a GitHub URL), show the error and the fix it names; `jury agents` lists
which agent CLIs are installed.

## 4. Report

When it finishes, summarize from the output: the rounds run, each reviewer's findings with the
judge's verdict (accepted, deferred or rejected), the commits the judge made, and whether they were
pushed. Every run is saved locally: `jury runs` lists them, and `jury --web-only` reopens the console
to read the full prompts, reports and verdicts.

Do not fix the findings yourself, and do not edit the files Jury is working on while it runs:
the judge owns the fixes for this review.
