# Code Jury

**Multiple reviewers. One clean PR.**

A convergence loop that runs independent review agents against a pushed commit, applies the findings
that survive verification, and repeats until every agent reports nothing new.

Derived from a real run on `worker-pool` #128 (exponential CreateSandbox retry backoff).
Three rounds, two agents (`codex`, `droid`), converged. See [CASE-STUDY.md](CASE-STUDY.md) for the
findings and the numbers.

## Install

```bash
npm install -g @agentsdance/codejury     # then: jury <pr-url>
npx @agentsdance/codejury <pr-url>       # or without installing
```

The GitHub PR URL is authoritative. `jury` resolves its base, source branch and exact
head commit, reviews an isolated temporary checkout, and pushes accepted fixes
back to the source branch. It is safe to invoke from `master` or from outside
the target repository; the caller's working tree is not switched or modified.

GitLab and compatible self-hosted services are supported through
`/merge_requests/<id>` URLs. Jury clones with Git and fetches the standard
`refs/merge-requests/<id>/head` ref, so existing Git credentials are used.
When that ref is missing, Jury discovers `refs/merge-requests/<shard>/<id>/<revision>`
refs and fetches the highest numeric revision, verifying the advertised commit.
The shard is discovered independently of the MR number. If
the source branch is not uniquely visible on the target remote (commonly a
fork), check out the source branch
locally, omit the MR URL, and run
`jury --dir /path/to/checkout --trunk <target-branch>`.

Node 20 or newer. The reviewers are separate CLIs you install yourself — `jury` spawns whatever you
have and skips the rest:

```bash
jury agents          # which are installed, and which role each holds
```

`jury` reads `jury.config.json` from the repo you are reviewing, if present; copy
[`jury.config.example.json`](jury.config.example.json) to start. Without one, the built-in registry is
used. The former `cr.config.json` and `macr.config.json` names remain readable for compatibility.

The former `cr` command remains available as a compatibility alias.

## Working and state directory

With an MR/PR URL, Jury always resolves the URL into an isolated checkout. By default,
checkouts live under `~/.jury/checkouts/` and run records under `~/.jury/runs/`, regardless
of the current directory. `--dir <path>` instead uses `<path>/checkouts/` and `<path>/runs/`.
The integrated `--web` console reads records from the same root.

Without a URL, Jury reviews the current repository, or the repository selected by `--dir`.
Other commands keep the current directory when it is a Git worktree and otherwise use
`~/.jury`. An explicitly empty `--dir ""` selects `~/.jury`. `~` is expanded consistently.

Run records live in `<dir>/runs`. For example, `jury runs --dir ""` and `jury web --dir ""` read
`~/.jury/runs`. Use those commands to inspect URL-based reviews launched with the default root.

## The loop

```
round N
  ├─ worktree at the pushed HEAD
  ├─ launch every agent in parallel, in the background
  │
  ├─ per agent: triage each finding
  │    ├─ reproduce it against the code            ← before touching anything
  │    ├─ fix, and add a regression test
  │    └─ reintroduce the bug, confirm the test fails
  │
  ├─ gofmt + vet + full suite → amend → push --force-with-lease
  ├─ append newly-settled items to the prompt
  │
  └─ stop iff every agent emitted the stop token on the SAME commit
     else round N+1
```

Two properties make it terminate rather than churn:

- **A growing settled list.** Without it each fresh agent rediscovers the same deferred issues every
  round, forever.
- **A literal stop token.** Termination is a `grep`, not a judgement call.

## Watching it happen

A round is a reviewer talking for several minutes and then a wall of text. Reviews start the console by default
in the same process as the run, so the conversation streams as it is spoken rather than arriving at
the end:

```
jury https://github.com/owner/repo/pull/1   # review, with the console open on it
jury --port 3099 --rounds 3                 # the current branch, on another port
```

Use `--web=false` (or `--web false`) to disable the console and exit when review finishes.
`--web`, `--web=true`, and `--web true` enable it explicitly.

The browser opens with `?run=<current-run>` so it shows the review just started,
including when the server falls back to another port.

The console outlives the loop — it stays up until you ctrl-c, which is the point: the run finishing
is when there is finally something worth reading. `jury web` still serves the same console
standalone, against runs that already exist.

## Who writes, and who only reads

Exactly one agent has role `main`; it is the default **judge**. The built-in default is Codex.
The judge owns the working tree and commit, triages every finding, and is the only writer. Choose a
different enabled agent for one run with `--judge`; without that flag the configured main agent is used (Codex by default):

```bash
jury https://github.com/owner/repo/pull/1                 # Codex judges
jury --judge claude https://github.com/owner/repo/pull/1  # Claude judges
```

`--judge` accepts exactly one agent name. The selected judge is removed from that run's reviewer
pool, so it never reviews its own work.
`jury agents` shows the configured roles:

```
ok      claude   reviewer /usr/local/bin/claude
ok      codex    main     /usr/local/bin/codex
ok      agy      reviewer /usr/local/bin/agy
```

Reviewers only read and report. A registry with two `main` entries is refused outright — two agents
both believing they own the commit corrupts a run rather than merely failing it.

The judge then holds **one conversation per reviewer**, concurrently, each about that reviewer's
own findings and nothing else:

```
codex ──▶ claude   its 5 findings, fresh run with its own words quoted back
       └──▶ agy     its 5 findings, fresh run with its own words quoted back
```

Never a broadcast. Two reviewers that see each other's findings stop being independent, and their
agreement stops being evidence — which is the only reason to run more than one. On aigit #48 both
independently found the same Windows `os.Rename` bug; neither was told the other had. `jury reply`
redacts other agents' names and finding ids out of the verdict text, so independence does not depend
on the operator remembering.

## More than one PR

Each PR is its own run directory — `runs/<repo>-<id>/` — with its own event log, findings, and settled
list. Nothing is shared, so reviewing several at once needs no coordination:

```
jury runs                                  # every PR under review, with its slug
jury finding list --run agentsdance-aigit-48
```

With one run, `--run` is optional. With several it is required, and the commands that need it refuse
with the available slugs rather than guessing. The console serves them all and shows a chip per PR;
picking one does not disturb a review running on another.

The one thing genuinely shared is the machine: reviewers are subprocesses, so two PRs reviewing at
once run two of every agent. The slowest still sets each round's wall clock.

## Agents are configuration

The loop is agent-agnostic; `codex` and `droid` are just the two entries that happen to be enabled.
Adding a third is a config change, not a code change. See [config.example.yaml](config.example.yaml).

Adding `agy` for the aigit #48 run was exactly that — a `jury.config.json` entry, no code:

```json
{ "name": "agy", "promptDelivery": "argv", "cwd": "worktree",
  "argv": ["agy", "--dangerously-skip-permissions", "--add-dir", "{{worktree}}", "--print", "{{promptText}}"],
  "report": "whole", "expectSeconds": 300 }
```

Two of its quirks are worth knowing, because both cost a wasted run: its permission flag must precede
`--print` or every file read is auto-denied and it returns an empty report, and it picks its own
working directory, so the worktree needs `--add-dir` *and* a mention in the prompt.

Only three things actually vary between agents, and all three bit during the reference run:

| dimension | values | why it matters |
|---|---|---|
| `promptDelivery` | `argv` \| `file` \| `stdin` | codex takes the prompt as an argument, droid needs `-f <path>` |
| `cwd` | `worktree` \| `flag` | codex runs *in* the worktree, droid takes `--cwd` and ignores process cwd |
| `resume.supported` | `true` \| `false` | decides whether feedback is a real conversation or a fresh run with prior findings quoted back |

```yaml
agents:
  - name: codex
    promptDelivery: argv
    cwd: worktree
    argv: ["codex", "exec", "--skip-git-repo-check", "{{promptText}}"]
    resume: { supported: true, argv: ["codex", "exec", "resume", "--last", "{{promptText}}"] }
    expect: { latencySeconds: 1100, verbose: true }

  - name: droid
    promptDelivery: file
    cwd: flag
    argv: ["droid", "exec", "--cwd", "{{worktree}}", "--auto", "medium", "-f", "{{promptFile}}"]
    resume: { supported: false, reason: "exec text output carries no session id" }
    expect: { latencySeconds: 130, verbose: false }
```

Run every enabled agent concurrently and in the background — the slowest sets the round's wall clock,
so serialising a 20-minute agent behind a 2-minute one wastes most of it.

One parsing subtlety worth encoding per agent: a verbose agent's stdout is a **full transcript that
contains the prompt**, so grepping it for the stop token matches the instruction that asked for the
token. Parse the final report block, not the whole stream — hence `parse.reportFrom`.

## Prompt anatomy

[`prompts/review-round.md`](prompts/review-round.md) — four sections, in this order:

1. **What the change does** — the design in a few bullets, so the agent does not have to infer intent.
2. **ALREADY SETTLED — do NOT re-report** — a numbered list, appended to after every round. For items
   you are deliberately *deferring*, include the reasoning, so an agent can argue with the reasoning
   instead of re-proposing a fix you already rejected.
3. **What you want** — the specific classes of defect. Always include the test-quality question:
   *"would each assertion actually fail if the behaviour it guards regressed? Read the assertions,
   not the test names."* That question produced every finding in rounds 2 and 3.
4. **The stop token** — `say exactly "NO NEW FINDINGS" on its own line`.

Plus `DO NOT edit any files`. You want findings to triage, not competing patches to merge.

[`prompts/feedback.md`](prompts/feedback.md) — structured per finding as
**ACCEPTED / AGREE-BUT-DEFERRED / REJECTED**, each with reasoning, each ending in a direct question.
Closing the loop this way is what turned two "you should fix this" items into explicit agreement to
defer them.

## Triage discipline

This is the part that carries the value. In the reference run **roughly a third of suggestions did not
survive verification**, and the loop also surfaced three of the operator's own mistakes.

Rules that earned their place:

1. **Reproduce before fixing.** Every accepted finding was demonstrated against the real code first.
2. **Every fix gets a regression test, and the test gets verified by reintroducing the bug.** A test
   that passes both with and without the fix is decoration.
3. **A test that hangs on regression is worse than one that fails.** One deterministic test drained a
   buffered channel and then blocked forever; it burned the CI timeout and read as an infra fault.
   Close the channel so the regression terminates.
4. **Distinguish "no hits" from "broken query."** When verifying against logs or metrics, run a control
   that you know should return rows. A zero is not evidence until you have proven the pipe works.
5. **An agent's suggested fix can be wrong even when its finding is right.** One reviewer correctly
   identified a cancellation gap, then proposed a guard that consumed a queued job without releasing
   its accounting reservation — trading a bounded extra RPC for a permanent resource leak.

## Known traps

- **Diff base.** `git diff origin/master` shows commits master gained *since* your branch point as
  deletions in your diff. Always diff against `git merge-base HEAD origin/master`. This produced a
  confident, completely spurious finding on round zero.
- **Prompt-induced findings are your bug, not theirs.** Fix the prompt and say so.
- **`timeout` does not exist on macOS.** Wrapping a verification in it exits 127 and the command never
  runs — you get an empty result that looks like a pass.
- **Removing a call can orphan an import**, turning "the test caught it" into a compile error. Keep the
  import used when simulating a regression.
- **Mock frameworks may not re-apply inside a loop.** Build the mock once outside; re-`Build()`ing per
  iteration silently kept the real implementation in the reference run (mockey).
- **Agents recycle suggestions when they have nothing left.** A verbatim repeat of a prior cosmetic note
  is a decent signal of convergence.
- **Skipping fenced text to avoid quoted material will also skip real findings.** The prompt shows the
  `FINDING:`/`WHERE:` header inside a fence, so agents answer in the same shape — on aigit #48 that
  silently dropped all five of one reviewer's findings while its report sat there in full. A fence
  containing *only* the header pair is the reviewer speaking; one holding a diff or code is not.
- **Two review processes on one round corrupt the record.** Relaunching without killing the first run
  gave round 1 two codex reports and merged their findings. Kill the prior run, or start a new round.

## What a system built on this would need

The manual run was the loop above driven by hand. To automate:

- an agent registry: invocation, cwd handling, whether sessions resume, expected latency
- prompt assembly: template + accumulated settled list, versioned per round
- a findings model: `{id, agent, round, severity, file, line, claim, status}` where status is one of
  `accepted | deferred | rejected | superseded`, so the settled list generates itself
- the reproduce/fix/verify gate as an explicit state machine — the step most worth enforcing, since it
  is the step most easily skipped
- convergence detection across N agents on a single commit sha
- a per-round budget, because the long-tail agent dominates wall clock

Deliberately **not** automated in the reference run: applying a fix without first reproducing the
finding. That gate is where the value was.
