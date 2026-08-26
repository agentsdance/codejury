# Deferred

The triage step is built: `macr` spawns the main agent per finding, which
reproduces before accepting, fixes what is real, rejects what is not, and the
loop commits and pushes between rounds.

## Console

- **The conversation should be as long as the conversation is.** Every message
  in full, no `show all N kB` fold. `bubble()` clamps at `CLAMP = 700` and hides
  the rest behind a button, so reading a review means clicking through it. The
  thread is the product; let it be tall and scroll.
- **The conversation panel wants more height.** It is the thing being read, and
  it currently sits in a short box under the timeline while the page has room
  to spare.

- **The CLI output wants a pass for legibility.** Every line is the same weight
  and colour, so a round boundary, a reviewer's report and a triage verdict all
  read alike in a terminal that scrolls for pages. Specifics visible in one run
  of PR #4:
  - `codex: codex (in worktree)` says the name twice and the useful part once.
  - The round result is stated three times — `round 1 — 216.3s`, then
    `codex  216.3s  findings  2 finding(s)`, then `NOT converged…`.
  - `2 finding(s)` should be `2 findings`; the `(s)` is a placeholder that
    escaped.
  - The reviewer's raw report is dumped at full width with no indent or rule
    marking where it starts and ends, so it runs into the triage that follows.
  - Colour where it carries meaning and nowhere else: the round header, agent
    names keyed to the console's own hues, and verdicts (accepted / rejected /
    deferred) in the same three colours the web view already uses. Respect
    `NO_COLOR` and a non-TTY stdout.

## Correctness

- **Rebuttals are still displayed twice.** The same duplication that findings
  had: `replyRound()` records the reviewer's full response as `reply.answered`
  and then each recognised reassertion as `finding.turn`, and both folds render
  the raw `answer` *and* the parsed `rebuttal`. Raised by codex against PR #4
  (`lib/loop.js:102`, `web/index.html:1440`); the fix there removed the
  `finding` duplicate but not this one, and the updated assertion only rejects
  `kind === "finding"`, so `rebuttal` duplicates pass unnoticed.

## Known limits worth revisiting

- **Findings are triaged serially.** Judging them concurrently would have
  several agents editing one tree at once, and the second fix would land on top
  of the first without having seen it. Correct, but it makes a round with 20
  findings long — measured at over 2.5 minutes on the first finding alone in
  run `20260826-1454`.
- **A rejected finding is re-raised by the next reviewer** until it reaches the
  settled list, which only happens after the round it was rejected in. The
  turn limit bounds the argument; it does not prevent the first repeat.
- **A reviewer that cannot run caps every run at `--rounds`.** A failed reviewer
  is deliberately not counted as agreement, so convergence is unreachable while
  it is enrolled — an agy quota error makes all 10 rounds run and none converge.
  Correct, but the run should say so at the start rather than at round 10.
