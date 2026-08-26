# Deferred

Nothing outstanding. The triage step — the last item — is built: `macr` spawns
the main agent per finding, which reproduces before accepting, fixes what is
real, rejects what is not, and the loop commits and pushes between rounds.

Known limits worth revisiting:

- **Findings are triaged serially.** Judging them concurrently would have
  several agents editing one tree at once, and the second fix would land on top
  of the first without having seen it. Correct, but it makes a round with 20
  findings long.
- **A rejected finding is re-raised by the next reviewer** until it reaches the
  settled list, which only happens after the round it was rejected in. The
  turn limit bounds the argument; it does not prevent the first repeat.
