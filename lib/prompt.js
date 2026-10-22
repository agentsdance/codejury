import { diffCommand } from "./trunk.js";
import { groupContext } from "./review-group.js";
import { languageInstruction } from "./language.js";
// Building the round prompt.
//
// The settled list is what makes the loop terminate: without it every fresh
// reviewer rediscovers the same deferred issues, round after round.
import { readFile } from "node:fs/promises";

export async function buildPrompt({ target, trunk, settled = [], summary = "", stopToken, settledFile }) {
  let settledBlock = settled.map((s, i) => (/^\d+\./.test(s) ? s : `${i + 1}. ${s}`)).join("\n");
  if (settledFile) {
    try {
      // The regenerated list is already formatted. Its continuation lines
      // carry the judge's evidence, not separate findings to filter out.
      settledBlock = (await readFile(settledFile, "utf8")).trim();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  return `${target.targets ? groupContext(target.targets) : `Review the current HEAD of this worktree.

Run \`${diffCommand(trunk)}\` to see the change. Do NOT diff against
origin/${trunk}'s tip — the trunk has moved since the branch point and unrelated commits will appear
inverted as deletions in this branch.`}

TARGET

${target.repo ?? "(repo)"} ${target.id ?? ""} — ${target.title ?? "(no title)"}
${target.targets ? "Branches and descriptions are listed per PR above." : `branch ${target.branch ?? "(unknown)"} → ${trunk}`}

WHAT IT DOES

${summary || "(no summary supplied — read the diff)"}

ALREADY SETTLED — do NOT re-report these, they are known and decided:

${settledBlock || "(nothing settled yet — this is the first round)"}

WHAT I WANT

Only NEW correctness problems in the code as it stands:

- races, deadlocks, leaks, incorrect accounting
- any way the change can produce a wrong result
- test correctness: would each assertion actually fail if the behaviour it guards regressed? Be
  skeptical, read the assertions rather than the test names. Flag any test that passes for the wrong
  reason or is timing-flaky.
- anything in the diff that is wrong regardless of the above

Rank by severity, cite file:line, and be concrete about the failing scenario.

Open each finding with these two lines, so they can be tracked across rounds:

\`\`\`
FINDING: <the claim, one line>
WHERE: <${target.targets ? "PR1/" : ""}file:line>
\`\`\`

Then explain it in prose underneath. A finding without that header is still read, but it will not be
tracked, so use it for every one.

IMPORTANT: if you find no new correctness problems, say exactly "${stopToken}" on its own line, then
briefly note anything cosmetic. Do not restate the settled list. Do not edit any files.
` + languageInstruction(target.language);
}
