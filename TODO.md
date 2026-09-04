# Deferred

The triage step is built: `jury` spawns the main agent per finding, which
reproduces before accepting, fixes what is real, rejects what is not, and the
loop commits and pushes between rounds.

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
