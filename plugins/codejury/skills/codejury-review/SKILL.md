---
name: codejury-review
description: Run or resume CodeJury's multi-agent review-and-fix loop when the user asks to use CodeJury, assemble a jury of coding agents, or continue a CodeJury review. For inspecting existing results without starting agents, use the saved-results workflow instead.
---

# Review with CodeJury

Use CodeJury's CLI to own the review loop. Do not manually replace it with
separate reviewers or claim a simulated run is a real review. Follow the user's
chosen target, agents, models, and limits; explicit user instructions take
precedence over the defaults below.

## Runner and prerequisites

Resolve `<plugin-root>` as two directories above this skill folder. Use
`node "<plugin-root>/scripts/jury.mjs"` followed by the command and its arguments.
The launcher downloads the exact published release candidate into
`~/.cache/codejury/plugin-cli/` on first use and invokes its absolute entrypoint,
so a different local/global `jury` cannot shadow it. If the user requests a different
version, use that version and inspect its help.

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
- Use `--push=false` unless pushing the resulting fixes is authorized. Use
  `--web=false` for a command that exits when the review finishes. If the user
  requests a live console, manage the resulting long-running process explicitly.
- Pass paths, URLs, summaries, and other user text as distinct arguments with
  proper quoting; never evaluate a user-supplied command string.

## Preserve fixes and state

**Single PR, local-only fixes:** create a persistent clone or worktree of the
PR's source branch, or use an existing matching clean checkout. Discover the
head and base from the PR metadata. Leave unrelated working changes intact.
Run without a PR URL:

```sh
node "<plugin-root>/scripts/jury.mjs" review \
  --dir /path/to/persistent-checkout --trunk base-branch --web=false --push=false
```

Replace the example path and base. Keep this checkout after completion and
report it to the user. A single-PR URL review removes its temporary checkout,
including unpushed commits; adding `--dir` to a URL only changes the state root
and does not prevent this cleanup.

**PR URL with authorized pushes:** the URL workflow is suitable. Pass
`--push=true` explicitly when requested. Never force-push to work around a
rejected push.

**Related PRs:** pass the URLs together in the original order, omit `--trunk`
so each PR uses its own base, and keep an explicit state root when useful.
Related-PR workspaces retain local commits. Preserve the URLs, state root, and
printed run slug for resume.

**Resume:** use the same target arguments and state root plus `--resume <slug>`.
Carry the user's push preference explicitly; related-PR resumes can inherit
the prior push setting. If remote heads have changed, inspect the conflict
before starting a new review instead of publishing obsolete local fixes.

## Execute and report

Run through the host's managed long-running process facility and retain the
process handle and output. Give progress updates while agents run. A reviewer
has a fixed ten-minute execution deadline; the whole multi-round review can
take longer. Do not launch duplicate reviews merely because output is quiet.

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
