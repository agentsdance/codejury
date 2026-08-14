# Design: how the CLI and the skill split the work

Target architecture. **The POC does not follow this yet** — see the last section.

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
macr finding <cmd>       raise | reproduce | resolve — appends events, enforces the gate
macr agents              probe configured agents: present, authenticated, version
```

`macr web` exists. The rest does not.

---

## POC deviation

The proof of concept does **not** build the orchestrator. The main agent drives the loop by hand, as
it did for !1158, and writes the run file the console already reads. That keeps the POC to the
question actually worth answering — *is a second PR's review useful?* — rather than spending the time
on process supervision.

What that means concretely: no `macr review`, no event log, no enforcement gate. Those land only once
the loop has proven worth automating on more than one PR.
