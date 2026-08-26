// The triage gate.
//
// DESIGN.md: "A skill can be skipped. That check cannot." The judgement half —
// does this finding actually reproduce — stays with the calling agent. The
// mechanical half is enforced here: an accepted finding must carry a recorded
// reproduction, and a fix must have a test that was observed failing without it.
import { readEvents } from "./store.js";

export const VERDICTS = ["accepted", "deferred", "rejected", "superseded"];

/** Fold the log down to one record per finding id. */
export async function findingsIn(dir) {
  const byId = new Map();
  for (const e of await readEvents(dir)) {
    switch (e.t) {
      case "finding.raised":
        byId.set(e.id, {
          id: e.id, round: e.round, agent: e.agent, claim: e.claim,
          // The reviewer's own prose. Needed verbatim when replying to an agent
          // whose session cannot resume — it has to be shown what it said.
          loc: e.loc ?? "", body: e.body ?? "",
          status: "open", reproduced: null, test: null, reason: "",
          // Folded from finding.turn events, never assigned by a caller.
          contested: false, turns: 0,
        });
        break;
      case "finding.reproduced": {
        const f = byId.get(e.id);
        if (f) { f.reproduced = e.evidence ?? true; f.test = e.test ?? f.test; }
        break;
      }
      case "finding.resolved": {
        const f = byId.get(e.id);
        // e.test carried too: resolve --test is the proof the regression test
        // failed without the fix, and dropping it here silently stripped that
        // proof from the reply and from a later re-resolve.
        if (f) {
          f.status = e.verdict;
          f.reason = e.reason ?? "";
          f.test = e.test ?? f.test;
          // Answering a re-raise settles it again. Without this a finding
          // contested once stays contested forever and the turn limit is the
          // only thing that ever ends it.
          f.contested = false;
        }
        break;
      }
      // A reviewer re-arguing a finding we already answered. This has to be
      // folded from the log rather than set by whoever happens to hold the
      // Map: `outstanding` reads `contested` to decide what the next round must
      // answer, and a field nothing ever writes makes the turn limit — and the
      // whole disagreement path — dead code.
      case "finding.turn": {
        const f = byId.get(e.id);
        if (f) {
          f.turns = (f.turns ?? 0) + 1;
          // Only a reviewer pushing back re-opens the argument; our own turn in
          // the thread is not a rebuttal against ourselves.
          if (e.who && e.who !== "claude") f.contested = true;
        }
        break;
      }
    }
  }
  return byId;
}

/**
 * Why a resolve must be refused, or null when it may proceed.
 *
 * Only `accepted` is gated. Rejecting or deferring a finding is a judgement the
 * operator is entitled to make without having reproduced anything — the whole
 * point of the loop is that a third of suggestions do not survive contact, and
 * demanding a reproduction before you may say "no" would invert that.
 */
export function gate(finding, { verdict, test }) {
  if (!finding) return "no such finding";
  if (!VERDICTS.includes(verdict)) {
    return `verdict must be one of ${VERDICTS.join(", ")}`;
  }
  if (verdict !== "accepted") return null;
  if (!finding.reproduced) {
    return `no finding.reproduced event for ${finding.id} — reproduce it before accepting it`;
  }
  // A fix whose test passes with the fix reverted is decoration, so the
  // observation that it failed is what is recorded, not merely a test name.
  const proof = test ?? finding.test;
  if (!proof) {
    return `accepting ${finding.id} needs --test <what failed without the fix>`;
  }
  return null;
}

/**
 * The settled list, regenerated from the log rather than hand-maintained.
 *
 * This is what makes the loop terminate: without it every fresh reviewer
 * rediscovers the same deferred issues, round after round, forever. Deferred
 * and rejected entries carry their reasoning so a reviewer can argue with the
 * reasoning instead of re-proposing a fix that was already considered.
 */
export function settledList(findings) {
  const lines = [];
  let n = 0;
  for (const f of findings.values()) {
    if (f.status === "open") continue;
    const why = f.reason ? ` — ${f.reason}` : "";
    const label = { accepted: "fixed", deferred: "deferred", rejected: "NOT valid", superseded: "superseded" }[f.status];
    lines.push(`${++n}. [round ${f.round}, ${f.agent}] ${f.claim}${f.loc ? ` (${f.loc})` : ""} — ${label}${why}`);
  }
  return lines.join("\n");
}
