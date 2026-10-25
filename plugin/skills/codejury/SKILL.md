---
name: codejury
description: Review a pull request with CodeJury using separate Claude judge and reviewer sessions. Use when asked to run the CodeJury review loop, re-review a PR after fixes, or manually triage CodeJury findings.
---

# CodeJury

This plugin supports PR reviews only. Require a PR URL before starting reviewers; if it is missing,
ask for it. Do not infer a local-branch or local-directory review from the current checkout.

In Claude Code, you are the **judge** for the manual workflow. You write code, answer findings,
and own the commit. Use only separate Claude sessions as reviewers, regardless of saved CLI role
settings. Reviewers only read and report — never let one edit files or reuse your judge session.

The CLI owns the mechanics; you own the judgement. See [DESIGN.md](https://github.com/agentsdance/codejury/blob/master/DESIGN.md) for the split.

For the automated loop, use `/codejury:review`; it always selects Claude as both judge and jury
in separate sessions, and only the judge owns fixes. The guidance
below is for explicitly requested manual review and triage. Do not edit a checkout while an
automated Jury run is using it. Resolve `<plugin-root>` as two directories above this
skill folder and run `node "<plugin-root>/scripts/jury.mjs" version` first. The runner
checks npm's global CodeJury installation and installs globally if missing; it stops
on errors instead of using npx or a private copy. Use this runner in place of `jury`
in the examples below. Keep the same `--dir` and `--run` for saved findings.

## The loop

```
round N
  ├─ worktree at the commit being reviewed
  ├─ launch every reviewer in parallel, in the background
  ├─ triage each finding: reproduce → fix → prove the test fails without the fix
  ├─ reply to every finding, including rejections
  ├─ verify, commit, push if authorized
  ├─ append what was settled to the prompt
  └─ stop iff every reviewer succeeded and emitted the stop token on the SAME commit
```

## Running reviewers

Resolve the requested PR's head to `REVIEW_SHA`, then cut a detached worktree at that exact
commit. After local fixes, review their new commit even when pushing is disabled:

```bash
git worktree add "$WT" "$REVIEW_SHA" --detach
```

Launch Claude reviewers in the background. Use the
current [Claude definition](https://github.com/agentsdance/codejury/blob/master/lib/agents/claude.json) and
[configuration guide](https://github.com/agentsdance/codejury/blob/master/docs/configuration.md),
with overrides in `jury.config.json`
([example](https://github.com/agentsdance/codejury/blob/master/jury.config.example.json)):

- **prompt delivery** — pass the review prompt with `claude -p`.
- **permissions** — use the Claude definition's read-only reviewer arguments, including plan mode
  and withheld edit tools; the judge alone can edit.
- **cwd** — use the PR worktree as the process working directory.
- **resume** — retain each reviewer's exact session id and pass it to that agent's configured
  resume command. Never select the most recent session: it may belong to another task. If there is
  no usable session id, start fresh with only that reviewer's prior findings quoted back.

## The prompt

Four sections, in order. Template in [prompts/review-round.md](https://github.com/agentsdance/codejury/blob/master/prompts/review-round.md).

1. **What the change does** — a few bullets, so the reviewer does not infer intent.
2. **ALREADY SETTLED — do NOT re-report** — grows every round. Without it, each fresh reviewer
   rediscovers the same deferred issues forever and the loop never terminates. For deferred items give
   the *reasoning*, so a reviewer can argue with it rather than re-propose a fix already rejected.
3. **What you want** — always include: *"would each assertion actually fail if the behaviour it guards
   regressed? Read the assertions, not the test names."* That question produced most late findings.
4. **The stop token** — `say exactly "NO NEW FINDINGS" on its own line`.

Plus `DO NOT edit any files`. You want findings to triage, not competing patches.

**Pin the diff base**: `git diff 'refs/remotes/origin/<trunk>...HEAD' --`. Never the trunk tip —
commits the trunk gained after the branch point appear as deletions in your diff and produce confident,
entirely false findings.

## Triage — the part that matters

A third of suggestions will not survive this. Do not skip it.

Record each step, so the settled list generates itself and the gate can hold:

```bash
jury finding list
jury finding reproduce <id> --evidence "what demonstrated it"
jury finding resolve <id> --verdict accepted --reason "..." --test "what failed without the fix"
jury finding resolve <id> --verdict rejected --reason "NOT valid because ... Verified empirically."
jury finding settled          # regenerates settled.md, which the next round's prompt carries
```

`resolve --verdict accepted` is **refused** unless a reproduction was recorded and `--test` names
what failed without the fix. Deferring and rejecting are not gated: you are entitled to say no
without reproducing anything, which is the whole point of the loop.

1. **Reproduce before fixing.** Demonstrate the finding against the real code first.
2. **Every fix gets a regression test, and the test gets verified by reintroducing the bug.** A test
   that passes both with and without the fix is decoration.
3. **A finding can be right while its fix is wrong.** One reviewer correctly found a cancellation gap,
   then proposed a guard that consumed a queued job without releasing its accounting reservation —
   trading a bounded extra call for a permanent leak.
4. **A test that hangs on regression is worse than one that fails.** It burns the CI timeout and reads
   as infrastructure. Make the regression terminate.
5. **Distinguish "no hits" from "broken query."** When verifying against logs or metrics, run a control
   you know returns rows. A zero is not evidence until the pipe is proven.

## Replying

Reply to every finding — silence is not a resolution. Per finding:
**ACCEPTED** / **AGREE-BUT-DEFERRED** / **REJECTED**, each with reasoning, each ending in a direct
question. Template in [prompts/feedback.md](https://github.com/agentsdance/codejury/blob/master/prompts/feedback.md).

```bash
jury reply --dir "$WT" --reviewer claude   # reply to the Claude reviewer session
```

You hold a **separate** conversation with each reviewer, about its own findings only. Never relay one
reviewer's findings to another: two reviewers that read each other stop being independent, and their
agreement stops being evidence. `jury reply` redacts the other agents' names out of your verdict text
for you, so writing "agy raised this too" in a `--reason` is safe — but do not rely on it as licence
to quote another thread.

Delivery follows `resume.supported` and the recorded session id. Codex, Claude, Droid and
Antigravity support resuming their own conversations. Without a usable session id, start a fresh
conversation and quote only that reviewer's findings back to it.

Rejections need evidence, not authority. One was settled by writing a three-line throwaway test and
pasting the panic.

When a finding was caused by *your* prompt, say so plainly. It is your bug.

Escalate to the human when a finding exceeds ~3 turns and both positions are internally consistent —
that is a design decision, not a fact, and the loop should stop arguing.

## Traps

- **`timeout` does not exist on macOS.** Wrapping a verification in it exits 127 and the command never
  runs — empty output that reads as a pass.
- **Removing a call can orphan an import**, turning "the test caught it" into a compile error.
- **Mock frameworks may not re-apply inside a loop.** Build the mock once outside it.
- **A verbose agent's stdout contains the prompt**, so grepping the whole stream for the stop token
  matches the instruction that asked for it. Parse the final report block.
- **A failed reviewer is not a sign-off**, even if its partial output includes the stop token.
- **Reviewers recycle suggestions when they have nothing left.** A verbatim repeat of a prior cosmetic
  note is a decent convergence signal.

## Viewing

`jury --web-only` serves the console. It displays a run; it does not create one.
