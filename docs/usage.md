# Usage and troubleshooting

## Working directories

With a PR/MR URL, Jury resolves an isolated checkout. The default state root is `~/.jury`:
checkouts live in `~/.jury/checkouts/`, runs in `~/.jury/runs/`.
`--dir <path>` uses `<path>/checkouts/` and `<path>/runs/` instead.
Your calling repository is not switched to the PR branch.

Without a URL, Jury works directly in the current repository, or the repository selected by `--dir`.
Other commands use the current Git repository when available, otherwise `~/.jury`.
Explicit `--dir ""` selects `~/.jury`. Use the same state root when listing or opening saved runs.

```sh
jury runs --dir ""
jury --web-only --dir "" --run <slug>
jury finding list --dir "" --run <slug>
```

Run artifacts include event logs, generated prompts, reviewer output, and folded console data.
Agent stdout and stderr are decoded as UTF-8 across process-output chunks, preserving
Unicode text and filenames in live output, saved reports, and failure diagnostics.
Reviewer replies also preserve literal `{{...}}` text from findings and verdicts;
command-template expansion does not reinterpret the reply's contents.
Timeline durations use recorded event timestamps; rounding is applied only to display labels,
so short reviews retain their elapsed seconds in the saved console data.
They are retained locally; remove old records manually when you no longer need them.
Related-PR task checkouts retain local commits for resume. Single-PR URL checkouts are removed when the CLI finishes, including local-only commits.
For durable single-PR local-only fixes, review your own source-branch checkout with
`jury --dir /path/to/checkout --trunk <base> --push=false` (no URL), or export commits
from the temporary checkout while the run is active.

The console and standalone demo show TRAE's own mark beside its participant name
in timelines, rounds, conversations, and exchanges. The icon is embedded in the
page and follows the participant color in both light and dark themes, without
requiring an external image download.

Closing or reloading the console page releases that connection's live-stream
watcher and timers, including while its initial event log is loading. The review
continues independently of the browser connection.

Use `--port 0` with a review or `--web-only` to let the OS choose an available
console port. Jury prints and opens the URL with that assigned port. A requested
nonzero port still falls back to the next available port when it is busy, trying
up to 20 higher ports without exceeding 65535. If that range is occupied, Jury
reports the address-in-use error; choose another port or use `--port 0`.

## Resume and limits

```sh
jury review <same-pr-url> --resume <slug> --reviewer claude --push=false
jury review <same-pr-url-1> <same-pr-url-2> --resume <slug> --push=false
```

Repeat the same `--dir` root if you used one. Keep related-PR URLs in the same order.
Related-PR resume retains its previous push setting unless explicitly overridden;
`--push=true` publishes retained fixes with fast-forward pushes. If a remote branch changes
independently, start a new task rather than resuming obsolete heads.

`--rounds 3` caps review rounds; it is not a monetary budget. Each round may involve multiple
reviewers, judge calls, and replies. Costs and latency depend on provider subscriptions and usage.
A review that reaches its round limit remains incomplete in the saved state. Do not use exit code
alone as evidence of approval; inspect `target.state` and the reviewed commit in the run record.
For single-checkout reviews, Jury checks that HEAD still matches the commit used
for the review or reviewer replies before reporting completion. If another process
commits during that phase, the run remains incomplete with `HEAD changed during review`;
inspect the new commit and run the review again. This check does not lock the checkout.
When committing judge fixes, Jury includes new files even if Git's
`status.showUntrackedFiles` display setting hides them. Ignore rules still apply,
and Jury does not change the saved Git setting.
Reviewer execution failures exit nonzero with `--web=false`. With the console enabled, it stays
available for inspection until Ctrl-C.

## GitHub and GitLab

URL routing distinguishes route segments from owner, repository, and subgroup names.
Names such as `pull` and `merge_requests` are preserved, including when removing
view suffixes, query strings, and fragments from related-PR URLs. Saved review
labels use the same request number as checkout resolution. GitHub
`/owner/repo/pull/<id>` and GitLab `/<group>/<project>/-/merge_requests/<id>`
forms are supported; existing separatorless GitLab links continue to work.

GitHub uses `gh` for PR metadata and cloning plus Git for commits and pushes. Authenticate both
as needed (`gh auth login`, your SSH key or Git credential helper). Source-branch push permission
is needed when pushing is enabled.

GitLab and self-hosted compatible services use Git credentials and standard
`refs/merge-requests/<id>/head` refs, including sharded revision refs where available.
MR descriptions are unavailable and the resolver uses the remote default branch as the base.
Use URL mode only for MRs targeting that branch. If the source branch is ambiguous or on a fork,
check it out yourself and run `jury --dir /path/to/checkout --trunk <target-branch>`.

For an offline local MR review with `--push=false`, Jury can use the caller's cached
`origin/HEAD` when default-branch discovery cannot reach the remote. The caller's
origin must match the MR repository and the cached default must resolve to a commit.
Without that cache, pass `--trunk <target-branch>` with its cached origin tracking ref.
Jury never infers the default from the branch currently checked out in the caller.

Related PRs may mix GitHub and GitLab-style URLs. Two PRs sharing a source branch are rejected.

## Common problems

`jury reply` exits nonzero if any selected reviewer fails to run or returns an
invalid result. It saves every reply before reporting the failure. After correcting
the agent issue, retry `jury reply` with the same `--dir` and `--run`, optionally
selecting the failed reviewer with `--reviewer`. A successful invocation that raises
remaining findings still exits zero; inspect its report for the review verdict.

| Symptom | Next step |
|---|---|
| Missing judge or reviewer | Install its CLI, select installed agents, or disable unused entries in `jury.config.json`. |
| Login, quota, timeout, or nonzero reviewer exit | Read the saved report, fix the provider issue, and resume. A failed reviewer never counts as approval. |
| Console stays open after completion | Expected. Press Ctrl-C; use `--web=false` for scripts. |
| Saved run cannot be found | Match the original `--dir`; URL reviews default to `~/.jury`. Run `jury runs --dir ""`. |
| Push rejected | Inspect branch protection and remote changes. Retained related-PR fixes can be resumed after recovery. |
| No reviewer selected | The judge is excluded. Enable or select at least one other reviewer. |

## Upgrading from 0.2.0

Use `jury review` (or a bare PR URL) for the loop and `jury --web-only` for saved-run viewing.
The old `review-once` and `web` commands were removed. Prefer `--reviewer` or `--jury`;
`--agents` is a hidden compatibility alias. `jury agents` still checks executables.
`jury`, `codejury`, and `cr` executable names remain available.

### Automatic judge and jury

On a fresh setup with exactly one installed supported agent CLI, `jury review` uses
that agent for both judge and jury, keeping its separate reviewer and judge command
permissions. With exactly two installed CLIs, either can be randomly selected as
judge; the other reviews. Opt-in built-ins are included in this detection.

When one CLI serves both roles, a reviewer's rebuttal still returns the finding
to the judge's triage queue, subject to the usual turn limit. A judge's own
explanation does not reopen the finding just because the names are identical.

The selected roles appear before the run starts and are saved with it. `jury reply`
and `jury review --resume <slug>` reuse those assignments even if installed CLIs
change. An unavailable saved agent causes an error rather than a fresh assignment.
Explicit `--judge`, `--reviewer`/`--jury`, a saved global judge, or repository agent
role/enabled settings take precedence over automatic selection for new runs.
Explicit CLI role overrides on resume use the normal selection rules. You can also
select the same agent directly, even when other CLIs are installed:

```sh
jury review <pr-url> --reviewer codex --judge codex --push=false
```

No additional flag is needed. Reviewer and judge use separate prompts and session
IDs; a fresh review never resumes the judge's history. Codex reviewer turns and
replies are read-only, while judge turns use workspace-write, including on resume.
The roles are saved for `reply` and `review --resume`. Same-agent sessions do not
provide model diversity or guarantee independent judgment. Default reviewer pools
still exclude the judge. Zero or more than two installed CLIs retain the existing
configured/default selection behavior when roles are not explicitly selected.

### Local review base branch

Pass a bare branch name such as `--trunk master`, not `origin/master` or a full
Git ref. Its `refs/remotes/origin/<branch>` tracking ref must be available and
share history with HEAD; fetch the base branch before reviewing if needed.
Jury validates this before launching agents. Review prompts use Git’s triple-dot
diff to compare HEAD to the merge base, and fail if that base becomes unavailable.

## Response language

Choose the language of agent-written findings, summaries, judge reasons, replies
and code-fix explanations with a language tag such as `en` or `zh-CN`:

```bash
jury review https://github.com/owner/repo/pull/123 --language zh-CN
jury review https://github.com/owner/repo/pull/123 --resume <slug> --language en
jury reply --dir <worktree> --run <slug> --language zh-CN
```

The preference is saved with the run and passed to every reviewer and judge.
Subsequent rounds, replies and resumed runs reuse it when the flag is omitted.
Pass the flag again to switch languages, including when answering comments written
in another language. `reply --dry-run --language en` previews that language without
saving the change. A new run with no language option keeps the existing behavior.

Tags are validated and canonicalized (`zh-cn` becomes `zh-CN`). The preference
controls generated prose; programming syntax, identifiers, existing code conventions,
JSON keys, verdict values and exact protocol/stop markers remain unchanged.
Code comments, string literals and test names follow the repository's conventions
and task requirements rather than the response-language preference.

## Token usage

The CLI and saved-run console show input, output and total tokens for every review,
judge/fix invocation and reply, with subtotals per round, per model and for the run.
A judge/fix turn is counted even when it rejects a finding without editing code.
The expanded invocation table includes failures and retries. Resuming adds new
invocations to the saved run rather than replacing earlier usage.
Codex and Qwen report cumulative session usage; each resumed invocation counts only
the increase over that session's last saved totals, including across CLI restarts.
Qwen model counters are compared with the saved totals for each model.
If a resumed thread has no saved baseline, that invocation's usage is unavailable;
its reported totals establish a baseline for subsequent invocations.
An interrupted turn without usage invalidates its session's baseline, so its
unmeasured work is not charged to a later invocation.
Commands that resume the last session follow the same rules. If an interrupted
call never identifies the session it used, saved baselines for that agent remain
uncertain until refreshed. Empty Qwen error results cannot restore an invalidated
baseline, including across repeated failures.
When resuming an older run, known reviews, judge turns and replies without usage
snapshots remain unavailable and keep combined totals partial. Saved judge session
records establish known old fix invocations. Bare verdicts and heartbeats cannot
establish additional calls: manual resolutions use the judge name too, and
heartbeats lack invocation IDs and may arrive late. Historical invocation counts
are therefore limited to what those old logs can establish.

Counts come from agent output, never estimates. Codex JSON, Droid/Qwen result JSON
and OpenCode JSON expose supported usage fields. Other output formats, including
the current plain-text Claude integration, show `unavailable`. A configured model
is labeled `configured`; an identity reported by the provider is labeled `reported`.
If neither is available, the model is unknown. These are agent CLI identities; a
provider or billing account is not inferred from the model name.

Input includes cached input once. Cache reads and writes are also shown separately:
Codex and Qwen already include them in input, while Droid and OpenCode report them
separately. OpenCode reasoning is included in output. Qwen's reported total is
preserved; thinking counted beyond input and candidate output is included in output.
When Qwen reports model counters, they supply the model breakdown and replace its
aggregate usage rather than being added to it.
Cache counts that are absent remain unavailable. Partial totals add only available
counts; missing invocations, missing input/output fields and unfinished or failed
invocations mark them partial.
Provider output can omit work from failed API requests or internal retries, so these
counts are not a billing record. Plain text that mentions tokens is not usage data.

Usage snapshots are saved to `events.ndjson` as output arrives and folded into
`run.json`. The saved-run reader also recovers newer usage snapshots after an
interruption. If a provider emits usage only at the end, termination before that
event leaves it unavailable. A forced kill can preserve only bytes already received.

Protocol references: [Codex events](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts),
[Droid result JSON](https://docs.factory.com/droid-exec/overview#json),
[OpenCode token normalization](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts).
