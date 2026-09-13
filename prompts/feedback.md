# Feedback prompt template

Sent back to an agent after acting on its review. Purpose: close the loop on disagreements explicitly,
rather than silently ignoring findings you chose not to act on.

Delivery differs per agent:

- **codex** — `codex exec resume --last "$(cat feedback.md)"`, prior context retained.
- **droid** — no session id in `exec` text output; re-run fresh and quote its prior findings into the
  prompt so it knows what it said.

---

Thanks — I acted on your review. Here is what I did with each finding, including where I disagree. The
final state is at {{worktree path}} (detached at {{sha}}). Please verify my claims and tell me where you
still disagree.

**{{N}}. {{finding title}} — ACCEPTED, fixed.**

{{What changed, with the code if short. If the regression test needed a non-obvious shape, say why —
e.g. "a single run only catches this 50% of the time because the select is random, so the test repeats
20 runs".}}

**{{N}}. {{finding title}} — AGREE it is real, NOT fixing here.**

{{Why it is out of scope: untouched by this change, pre-existing, needs its own tests.}}

Question: do you agree it is (a) pre-existing and (b) not made materially more likely by this change?
If you think otherwise, say so and I will reconsider.

**{{N}}. {{finding title}} — REJECTED.**

{{The evidence. Prefer something reproducible: a command, an error message, a counter-example.}}

**{{N}}. {{finding title}} — PARTIAL pushback.**

{{Which half you accept and which you dispute, and what you changed as a result.}}

Question: do you accept that framing, or is a different definition actually better?

Please review the final state and answer: any remaining correctness problem, and do you accept my
positions on {{list}}? Do not edit files.

---

## Notes

- Ending each disputed item with a **direct question** is what makes this a conversation. In the
  reference run it converted two "you should fix this" items into explicit agreement to defer.
- State rejections with evidence, not authority. One rejection was settled by writing a three-line
  throwaway test and pasting the panic message.
- Expect to be wrong sometimes. The most valuable single finding of the reference run — a real
  cancellation bug — came back in a reply to feedback, not in the first review.
- Tell an agent when its finding was caused by *your* prompt (e.g. a wrong diff base). It is your bug.
