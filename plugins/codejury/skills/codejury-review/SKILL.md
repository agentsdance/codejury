---
name: codejury-review
description: Review pull requests supplied by URL with CodeJury's multi-agent review-and-fix loop, or resume a saved PR review. Require a PR link before starting a new review. Use the saved-results workflow to inspect prior findings without starting agents.
---

# Review with CodeJury

Use CodeJury's CLI to own the review loop. Do not manually replace it with
separate reviewers or claim a simulated run is a real review. Follow the user's
chosen target, agents, models, and limits; explicit user instructions take
precedence over the defaults below.

## Supported target

The supported entry point is a pull-request URL. Require one or more PR links
from the user or established conversation context before starting a new review.
If the request only names local files, a directory, or uncommitted changes, ask
for the corresponding PR link. Do not substitute the current checkout, invent
a PR, or advertise arbitrary local-file review. For a resume, recover the
original PR link from the saved run or conversation.

## Runner and prerequisites

Resolve `<plugin-root>` as two directories above this skill folder. Use
`node "<plugin-root>/scripts/jury.mjs"` followed by the command and its arguments.
The launcher first uses an installed CodeJury CLI available as `jury` or `codejury`
on PATH. If none is found, it downloads the fallback release into
`~/.cache/codejury/plugin-cli/`. Run `version` to report the selected CLI version.
If the user requests a different version, use that version and inspect its help.

Check Node.js 20.10+, npm, Git, and the requested agent CLIs. For GitHub PRs,
check GitHub CLI authentication. Run `jury agents` to discover executables;
this does not verify provider login or quota. Fix missing prerequisites before
launching agents. Read `jury help review` for flags rather than inventing them.

## Resolve the operation

- A review invokes a judge that can edit files and create commits. If the user
  requires a strictly read-only review, do not run this loop under a misleading
  `--push=false` promise; explain the mismatch and clarify the workflow.
- Respect specified judges, juries, models, round limits, and repository config.
  Do not silently save global defaults or add reviewers the user did not request.
- Use `--push=true` by default. If the user asks to keep fixes local or disables
  pushes, pass `--push=false` and use the local-only workflow below. For an
  interactive desktop review, keep the default live console enabled, share its
  printed URL as a clickable link as soon as it starts, and retain the managed
  process. Use `--web=false` for a headless workflow that should exit when the
  review finishes, or when the user requests no dashboard.
- Pass paths, URLs, summaries, and other user text as distinct arguments with
  proper quoting; never evaluate a user-supplied command string.

## Preserve fixes and state

**PR URL (default):** pass the PR URL with `--push=true` to review, fix, commit,
and push to the PR's source branch. Never force-push to work around a rejected push.

```sh
node "<plugin-root>/scripts/jury.mjs" review <pr-url> --push=true
```

**Single PR, local-only fixes when requested:** create a persistent clone or
worktree of the PR's source branch, or use an existing matching clean checkout. Discover the
head and base from the supplied PR's metadata and verify that the checkout
matches that PR. This checkout only retains fixes for the URL-selected PR;
it is not a separate local-file review mode. Leave unrelated working changes
intact. Internally invoke the CLI against this verified checkout:

```sh
node "<plugin-root>/scripts/jury.mjs" review \
  --dir /path/to/persistent-checkout --trunk base-branch --push=false
```

Replace the example path and base. Keep this checkout after completion and
report it with the original PR URL to the user. Include that URL in the run's
title or summary so the saved review remains traceable. A single-PR URL review removes its temporary checkout,
including unpushed commits; adding `--dir` to a URL only changes the state root
and does not prevent this cleanup.

**Related PRs:** pass the URLs together in the original order, omit `--trunk`
so each PR uses its own base, and keep an explicit state root when useful.
Related-PR workspaces retain local commits. Preserve the URLs, state root, and
printed run slug for resume.

**Resume:** use the same target arguments and state root plus `--resume <slug>`.
Pass the user's push preference explicitly. Preserve a previous local-only
request unless the user changes it; use the saved push setting when resuming
without a new preference, and default to `--push=false` if no setting is recorded.
Older single-PR runs may omit the setting, so only enable pushing when the user
explicitly requests it for that resume.
If remote heads have changed, inspect the conflict before starting a new review
instead of publishing obsolete local fixes.

## Execute and report

Run through the host's managed long-running process facility and retain the
process handle and output. Give progress updates while agents run. The whole
multi-round review can take several minutes. Do not launch duplicate reviews
merely because output is quiet.
With the live console enabled, the process stays up after review completion;
inspect the completion message and saved run status instead of waiting for the
server process to exit. Keep the dashboard available while the user needs it.

On a login, quota, timeout, or reviewer failure, inspect the saved diagnostics
and report the failure. Resume after its cause is addressed. Do not repeatedly
retry a failing provider or count partial output as an approval.

After completion, inspect the saved run and findings, not just exit code:

```sh
node "<plugin-root>/scripts/jury.mjs" runs --dir /path/to/state-root
node "<plugin-root>/scripts/jury.mjs" finding list --dir /path/to/state-root --run run-slug
```

Read the matching `runs/<slug>/run.json` and relevant reports. State the reviewed
commit, judge/juries, convergence or incomplete/timeout status, actionable
findings, fixes and test evidence, whether commits were pushed, and retained
checkout/run paths. A zero exit code or agent agreement alone does not prove
the code is defect-free. Label fixture and dry-run output as simulated.

Project reference: [state, retention, and resume](https://github.com/agentsdance/codejury/blob/master/docs/usage.md).
