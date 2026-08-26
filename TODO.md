# Deferred

## Timestamps on conversation turns
Each message bubble should carry the time it was spoken (and, where it applies,
how long the turn took). The events already hold `ts` — `conversation()` passes
it through and the browser fold drops it — so this is a rendering change, not a
data one.

Pinned to Asia/Singapore like the rest of the console (`TZ` in web/index.html):
a review record should read the same wherever it is opened.

Open question worth deciding when building it: an absolute clock time is what
you want when correlating with logs, a relative offset ("+4m") is what you want
when reading the conversation as a conversation. Probably absolute on hover,
relative inline.

## Not yet fixed, from codex round 2
- **[P2] The streaming test would pass without streaming** (test/stream.test.js).
  Every assertion runs after `await runAgent(...)`, so an implementation that
  buffered all stdout and called `onChunk` once at exit would satisfy it. Needs
  synchronisation proving `AAA` reaches the callback before `BBB` is emitted.

## The triage step
`macr agent` still prints `→ awaiting claude: macr finding reproduce <id>` and
moves on. It no longer lies about it — a round with open findings reports
"N finding(s) still open — not convergence" rather than success — but the
fix-between-rounds half of the loop is not built.
