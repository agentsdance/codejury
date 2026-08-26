// Triage: the judgement half of the loop.
//
// DESIGN.md left this to the operator on purpose — "deciding a finding
// reproduces is the calling agent's job, and roughly a third of suggestions do
// not survive that step". With nobody in that seat the loop reviewed the same
// commit ten times and called it convergence.
//
// The main agent fills the seat now. It is spawned exactly like a reviewer, but
// it is the only one allowed to touch the tree: it reproduces a claim before
// accepting it, writes the regression test, and answers the ones it rejects
// with the evidence that settled them.
import { runAgent } from "./agents.js";

/** What the main agent must answer for one finding. */
export const VERDICT_SCHEMA = `{
  "reproduced": "<what you observed, or null if it does not reproduce>",
  "verdict": "accepted | rejected | deferred",
  "reason": "<why, in one or two sentences>",
  "test": "<the regression test you added and watched fail without the fix, or null>"
}`;

/**
 * The prompt for one finding.
 *
 * Deliberately adversarial about acceptance: a reviewer's claim is a hypothesis,
 * and the whole value of the gate is that a third of them do not survive being
 * checked. Being asked to demonstrate it first is what makes "accepted" mean
 * something.
 */
export function triagePrompt({ finding, trunk, stopToken }) {
  return `A code reviewer raised this finding against the current worktree.

FINDING: ${finding.claim}
${finding.loc ? `WHERE: ${finding.loc}` : ""}

${finding.body || "(no further detail given)"}

Your job is to decide whether it is real, and to act on it.

1. Read the code at that location. Run \`git diff $(git merge-base HEAD origin/${trunk}) HEAD\`
   if you need to see what changed.
2. Try to REPRODUCE it — a failing test, an observed wrong value, a traced path.
   A claim you cannot demonstrate is not accepted, however plausible it sounds.
   Roughly a third of review findings do not survive this step; rejecting one
   with evidence is as valuable as fixing one.
3. If it reproduces: fix it, and add a regression test. Run the test with the
   fix reverted and confirm it FAILS — a test that passes either way is
   decoration. Then run the full suite.
4. If it does not: say what you checked and why the claim is wrong.
5. If it is real but out of scope for this change (pre-existing, and not made
   materially more likely by it), defer it and say so.

Do not fix anything the finding did not raise. Do not commit — the loop commits.

Answer with ONLY a JSON object on the last line of your output, no fence:

${VERDICT_SCHEMA}

"accepted" requires both a non-null "reproduced" and a non-null "test": the CLI
refuses an acceptance that never demonstrated one, and the round is wasted if
you claim one without them.`;
}

/**
 * Parse the verdict out of the main agent's output.
 *
 * Last JSON object wins: agents narrate before answering, and an example echoed
 * from the prompt earlier in the transcript must not beat the real answer at
 * the end.
 */
export function parseVerdict(text) {
  const s = String(text ?? "");
  let found = null;
  // Scan for balanced top-level objects rather than regex-matching braces,
  // which breaks on any nested object in the reasoning above it.
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(i, j + 1));
          if (o && typeof o === "object" && "verdict" in o) found = o;
        } catch { /* not the object we want */ }
        i = j;
        break;
      }
    }
  }
  if (!found) return null;
  const verdict = String(found.verdict ?? "").toLowerCase().trim();
  const clean = (v) => {
    const t = typeof v === "string" ? v.trim() : v;
    // Agents write "null" and "none" as strings when they mean nothing.
    return !t || /^(null|none|n\/a)$/i.test(String(t)) ? null : String(t);
  };
  return {
    verdict: ["accepted", "rejected", "deferred", "superseded"].includes(verdict) ? verdict : null,
    reproduced: clean(found.reproduced),
    reason: clean(found.reason) ?? "",
    test: clean(found.test),
  };
}

/**
 * Put one finding to the main agent and return its verdict.
 *
 * Never throws: a main agent that dies on one finding must not lose the round's
 * other verdicts, so a failure is a null verdict and the finding stays open for
 * the next round to raise again.
 */
export async function triageOne(main, finding, { worktree, trunk, stopToken, dryRun, onLog, onChunk }) {
  const prompt = triagePrompt({ finding, trunk, stopToken });
  if (dryRun) {
    return { verdict: "rejected", reproduced: null, reason: "dry run — not triaged", test: null, seconds: 0 };
  }
  const r = await runAgent(main, {
    worktree, prompt, stopToken, onLog, onChunk,
    // Triage is slower than review: it reads, reproduces, edits and runs tests.
    // Floor as well as multiple: a misconfigured 0 must not mean 'kill it now'.
    timeoutSeconds: Math.max(900, (main.expectSeconds || 900) * 3),
  });
  if (!r.ok) return { verdict: null, failed: true, report: r.report, seconds: r.seconds };
  const v = parseVerdict(r.report) ?? parseVerdict(r.raw);
  if (!v?.verdict) {
    return { verdict: null, unparsed: true, report: r.report, seconds: r.seconds };
  }
  return { ...v, report: r.report, seconds: r.seconds };
}
