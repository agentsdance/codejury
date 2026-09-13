# Case study: worker-pool #128

The run this method was extracted from. Change under review: replace a flat 30s retry wait after a
failed `CreateSandbox` with exponential backoff (1s → 60s cap, jitter), in a prewarm-pool worker.

Two agents: `codex`, `droid`. Plus an in-platform reviewer (`aime`) that had already produced four
rounds of findings before the loop started.

## Convergence

| round | commit | codex | droid |
|---|---|---|---|
| 1 | `bf94454` | no production issues; 1 low (test tautology) | `NO NEW FINDINGS` |
| 2 | `6901882` | no production issues; 2 low (test precision) | `NO NEW FINDINGS` |
| 3 | `ae473ab` | **`NO NEW FINDINGS`** | **`NO NEW FINDINGS`** |

Zero production correctness findings across all three rounds — the production code had already been
hardened by four earlier review rounds. Everything the loop found was **tests asserting less than the
PR claimed**.

## What the loop actually caught

All three are the same species: a test that passes whether or not the behaviour exists.

1. **Jitter was deletable with every test still green.** Every assertion accepted the nominal delay as
   its upper bound, so `return delay` (no jitter at all) satisfied them; the 500-sample test only
   enforced the ceiling. Reproduced exactly, then fixed by asserting jitter *shortens and varies*
   across 200 draws.

2. **The cancellation test was probabilistic.** A regressed worker's `select` could still pick
   `ctx.Done()` first in all 20 runs — a ~1-in-10⁶ false pass. Made deterministic by stubbing the wait
   to report "did not finish" while leaving the context *live*, removing the race entirely.

3. **The tests validated their own constants.** Expected bounds were derived from
   `createBackoffJitter` and `maxCreateBackoff`, so changing the cap to 48s or jitter to 50% left every
   test green while breaking the documented contract. Fixed by pinning the literal values in a separate
   test.

Earlier rounds (pre-loop, same method) caught the substantive ones, including a real cancellation bug —
after the backoff wait returned on cancellation the worker fell back into a `select` with both cases
ready, so ~50% of the time a cancelled worker took another job and called the RPC on a dead context.

## What did not survive verification

Roughly a third of all suggestions:

| suggestion | verdict |
|---|---|
| "the diff also deletes `IdlePoolMissReason`" | artifact of diffing against trunk tip after trunk moved — **prompt bug** |
| "guard the select with `if ctx.Err() != nil { return }`" | finding right, **fix wrong** — consumes a queued job without releasing its in-flight reservation, causing a permanent pool under-fill |
| "`PatchConvey` around a pure function is unnecessary" | wrong — `convey.So` panics outside a Convey scope; proven with a throwaway test |
| "the failure counter is neither an all-error nor a consecutive-generic streak" | mischaracterisation — it is precisely *generic failures since this worker last succeeded*; the actionable half (make it explicit) was taken |
| "extract the test helper to package level" | speculative generality for a single caller; repeated verbatim next round |

## Operator errors the discipline caught

Worth recording because they were all near-misses that would have produced false confidence:

- A simulated regression deleted the only use of an import, so the observed FAIL was a **compile error**,
  not a failing assertion. Re-run keeping the import used — and the tests then *passed*, confirming the
  finding.
- Two verification runs **never executed**: they were wrapped in `timeout`, which does not exist on
  macOS (exit 127). Empty output read as success.
- A new deterministic test **hung** under regression instead of failing — the worker drained the
  buffered channel then blocked on an open, empty one. Closing the channel made it fail in 0.00s.
- A mock rebuilt inside a loop **silently stopped applying** after the first iteration, so later
  iterations exercised the real implementation.

## Cost

- codex ~15–20 min/round, droid ~2 min/round; run in parallel, so ~20 min/round wall clock.
- 3 rounds plus one feedback exchange ≈ 1.5 h of agent time.
- Yield: 3 real test defects, 5 rejected suggestions, 4 operator errors surfaced.

The rejections are not waste — verifying them is what makes the accepted findings trustworthy.
