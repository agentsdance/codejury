# Review-round prompt template

Substitute `{{...}}` and pass the whole file as the agent prompt. Regenerate every round with an
updated SETTLED list.

---

Review the current HEAD of this worktree. It is a {{language}} change to {{component, one line}}.

Run `git diff $(git merge-base HEAD origin/{{trunk}}) HEAD` to see the change. Do NOT diff against
origin/{{trunk}}'s tip — the trunk has moved since the branch point and unrelated commits will appear
inverted. The change should touch exactly {{n}} files: {{paths}}.

WHAT IT DOES

{{5-10 bullets: the design, the invariants, anything a reader would otherwise have to infer.}}

ALREADY SETTLED — do NOT re-report these, they are known and decided:

{{Numbered list, appended to after every round. Three kinds of entry:
  - fixed:    "<claim> — fixed, <what changed>"
  - deferred: "<claim> — <why it is out of scope>. Note <trap in the obvious fix>."
  - rejected: "<claim> — NOT valid because <evidence>. Verified empirically."
Include reasoning on deferred and rejected items so an agent can argue with the reasoning rather than
re-propose a fix that was already considered.}}

WHAT I WANT

Only NEW correctness problems in the code as it stands. Concretely:

- races, deadlocks, leaks, incorrect accounting
- {{domain-specific failure modes}}
- test correctness: would each assertion actually fail if the behaviour it guards regressed? Be
  skeptical, read the assertions rather than the test names. Flag any test that passes for the wrong
  reason or is timing-flaky.
- anything in the diff that is wrong regardless of the above

Rank by severity, cite file:line, and be concrete about the failing scenario.

IMPORTANT: if you find no new correctness problems, say exactly "NO NEW FINDINGS" on its own line, then
briefly note anything cosmetic. Do not pad with restatements of the settled list. Do not edit any files.

---

## Notes

- The test-quality bullet is the highest-yield line in the template. Once the production code settled,
  every remaining finding came from it.
- The stop token must be exact and on its own line so convergence is greppable.
- `Do not edit any files` keeps the agents as reviewers. You want findings you can triage, not patches
  competing with each other.
- Keep the settled list ordered by round so you can see what each round added.
