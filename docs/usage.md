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
They are retained locally; remove old records manually when you no longer need them.
Related-PR task checkouts retain local commits for resume. Single-PR URL checkouts are removed when the CLI finishes, including local-only commits.
For durable single-PR local-only fixes, review your own source-branch checkout with
`jury --dir /path/to/checkout --trunk <base> --push=false` (no URL), or export commits
from the temporary checkout while the run is active.

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
Reviewer execution failures exit nonzero with `--web=false`. With the console enabled, it stays
available for inspection until Ctrl-C.

## GitHub and GitLab

GitHub uses `gh` for PR metadata and cloning plus Git for commits and pushes. Authenticate both
as needed (`gh auth login`, your SSH key or Git credential helper). Source-branch push permission
is needed when pushing is enabled.

GitLab and self-hosted compatible services use Git credentials and standard
`refs/merge-requests/<id>/head` refs, including sharded revision refs where available.
MR descriptions are unavailable and the resolver uses the remote default branch as the base.
Use URL mode only for MRs targeting that branch. If the source branch is ambiguous or on a fork,
check it out yourself and run `jury --dir /path/to/checkout --trunk <target-branch>`.

Related PRs may mix GitHub and GitLab-style URLs. Two PRs sharing a source branch are rejected.

## Common problems

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

The selected roles appear before the run starts and are saved with it. `jury reply`
and `jury review --resume <slug>` reuse those assignments even if installed CLIs
change. An unavailable saved agent causes an error rather than a fresh assignment.
Explicit `--judge`, `--reviewer`/`--jury`, a saved global judge, or repository agent
role/enabled settings take precedence over automatic selection for new runs.
Explicit CLI role overrides on resume use the normal selection rules. Outside the
automatic one-CLI fallback, the judge cannot review its own work. Zero or more than
two installed CLIs retain the existing configured/default selection behavior.
