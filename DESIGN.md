# Design: how the CLI and the skill split the work

Target architecture. The CLI now implements it; see the last section for what is still deliberately
left to the operator.

## The asymmetry this is built around

Reviewers and the main agent reach the system in completely different ways, and that difference
decides the whole design.

**Reviewers need no cooperation.** `codex` and `droid` are subprocesses. Whatever spawns them already
owns their stdout, exit code, wall time, and which round they belong to. They do not need to know the
console exists. Their output *is* the data.

**The main agent has to report.** It is not a subprocess of anything — it is the thing driving. Its
most valuable output is not a file diff but a judgement: *this finding reproduces, that one does not,
this fix is right but that one leaks a reservation*. Nothing captures that unless it is deliberately
emitted.

A binary cannot make those judgements. Instructions cannot capture a subprocess. Hence two pieces.

## Split

| | `macr` (CLI) | the skill |
|---|---|---|
| owns | mechanics | judgement |
| worktree, merge-base pinning | ✓ | |
| spawning agents, per-agent argv / prompt delivery / cwd | ✓ | |
| capturing stdout, parsing the report block | ✓ | |
| appending events, serving the console | ✓ | |
| convergence detection (grep the stop token) | ✓ | |
| deciding a finding reproduces | | ✓ |
| writing the regression test and proving it fails without the fix | | ✓ |
| replying to every finding, including rejections | | ✓ |
| maintaining the settled list | | ✓ |
| escalating past the turn limit | | ✓ |

**Hard rule: the CLI must work without the skill.** If `macr review` only functions inside a Claude
Code session reading SKILL.md, it is not a tool — it is a prompt with a binary attached, and it cannot
run in CI or for anyone on a different agent.

## Event log

One append-only NDJSON file per PR: `runs/<id>/events.ndjson`. Two writers are safe — the CLI appends
agent events while the main agent appends verdicts.

```
{"t":"round.start","n":2,"sha":"6901882"}
{"t":"agent.launch","agent":"codex","round":2}
{"t":"agent.report","agent":"codex","round":2,"verdict":"found","raw":"…"}
{"t":"finding.raised","id":"X1","agent":"codex","claim":"jitter is deletable","file":"main_test.go:2237"}
{"t":"finding.reproduced","id":"X1","evidence":"return delay → all backoff tests PASS"}
{"t":"finding.resolved","id":"X1","verdict":"accepted","reason":"now asserts jitter varies"}
{"t":"commit.pushed","sha":"ae473ab"}
{"t":"round.end","n":2}
```

The console folds the log into the current view. Three things fall out for free: the timeline is
measured rather than estimated, a run can be replayed, and the view is derived state rather than a
hand-written report.

## Enforce what is checkable

The triage gate is where the value was — roughly a third of suggestions died there. Today it holds
only because the operator chose to be disciplined. Some of it can be made structural:

```
macr finding resolve X1 --verdict accepted
  → refused: no finding.reproduced event for X1
```

A skill can be skipped. That check cannot. Enforce the mechanical half (an accepted finding must have
a recorded reproduction; a fix must have a test that was observed failing without it) and leave the
judgement half to the skill.

## CLI surface

```
macr review <pr-url>     run rounds until convergence or --max-rounds
macr web [--runs dir]    serve the console
macr finding <cmd>       list | reproduce | resolve | settled — appends events, enforces the gate
macr reply               one conversation per reviewer, about its own findings only
macr agents              probe configured agents: present, authenticated, version
```

`macr agents` prints the role, so who owns the commit is visible rather than implied:

```
ok      claude   main     (in-process)
ok      codex    reviewer /usr/local/bin/codex
ok      agy      reviewer /usr/local/bin/agy
```

The main agent carries an empty `argv` because it is the session driving the loop, not a subprocess
it spawns — `probe` reports it in-process rather than missing, and `reviewers()` keeps it out of
every round. Loading a registry with two `main` entries is refused: two agents both believing they
own the commit corrupts a run rather than merely failing it.

## One conversation per reviewer

`macr reply` opens a **separate** thread with each reviewer, concurrently, containing only that
reviewer's own findings and the main agent's verdicts on them. Reviewers never see each other's
findings — two that read each other stop being independent, and their agreement stops being evidence,
which is the only reason to run more than one.

Independence is enforced in code, not left to whoever writes the verdict: another reviewer's name and
finding ids are redacted out of the reply text before it is sent. On aigit #48 both reviewers found
the same Windows rename bug independently; each was told only that it was agreed, never that it was
corroborated.

Delivery follows `resume.supported`, and the difference is not cosmetic:

| | codex | agy |
|---|---|---|
| session | resumes (`exec resume --last`) | fresh process each run |
| the reply is | a turn in a thread that already holds its review | addressed to an agent with no memory of it |
| so | verdicts alone | verdicts **plus its own findings quoted back** |

All four exist. `macr agents` probes presence only — it does not yet check authentication or
version.

---

## What is built, and what is not

Built: `macr review` (rounds until convergence or `--max-rounds`), the append-only event log,
`macr finding` with the enforcement gate, the self-generating settled list, and the console.

Still the operator's job, on purpose:

- **`macr agents`** probes presence only, not authentication or version.

## The autonomous loop

`macr review` leaves three jobs to whoever is sitting between rounds — deciding whether a finding
reproduces, fixing what does, and pushing so the next round has new code to read. When nobody sits
there, `--max-rounds 10` reviews the same commit ten times and calls it a loop.

`macr agent` fills that seat. The main agent triages each finding, fixes what reproduces, commits,
replies to every reviewer about its own findings, and goes again — up to `--rounds` (default 10).

Three things make it terminate rather than argue forever:

| | |
|---|---|
| the settled list | regenerated from the log **before** every round, so a deferred finding is not re-raised by the next reviewer to read the diff |
| the turn limit | `MAX_TURNS` (3) exchanges per *claim*, counted per finding so one contested item cannot spend the whole run's budget |
| the round cap | `--rounds`, default 10 |

The deadlock rule is deliberately **defer, not accept**. After three turns both positions are already
in the log; fixing something nobody demonstrated is how a stubborn false positive gets code written
for it, and the gate that refuses an unproven acceptance would have to be bypassed to do it.

**Pushing is opt-in and refuses trunk.** `--push` appends to the PR branch, fast-forward only, never
forced. Without it the loop commits to the worktree and stops there. An agent loop that can push to
master is one bad triage away from a bad afternoon.

## Watching it happen

The conversation is the product, so it is rendered as one: **claude on the left, the reviewer on the
right**, one column per reviewer. codex and agy are separate threads and are never merged — two
reviewers that read each other stop being independent, which is the only reason to run more than one.

It streams. The append-only log is the transport: `/api/stream` replays the file on connect so a page
opened mid-round catches up, then pushes each appended line as it lands. Reviewer stdout reaches the
log as batched `agent.chunk` events, so a twenty-minute agent is visible for all twenty minutes
rather than being a black box that eventually produces a report.
