// Replying to a reviewer — one conversation per reviewer, never a broadcast.
//
// The main agent talks to codex about codex's findings and to agy about agy's.
// Neither sees the other's, which is the entire point of running more than one:
// two reviewers that read each other's reports stop being independent, and the
// agreement between them stops being evidence of anything.
//
// Delivery differs per agent and the difference is not cosmetic:
//   resume.supported  codex keeps the session, so the reply is a real turn in a
//                     conversation that already contains its own review
//   otherwise         a fresh process that has never seen the thread, so its own
//                     prior findings must be quoted back or the reply is
//                     addressed to an agent with no idea what it said

/** What one reviewer said, and what the main agent decided about each item. */
export function threadFor(agent, findings) {
  return [...findings.values()].filter((f) => f.agent === agent);
}

const VERDICT_LABEL = {
  accepted: "ACCEPTED, fixed",
  deferred: "AGREE it is real, NOT fixing here",
  rejected: "REJECTED",
  superseded: "SUPERSEDED",
  open: "still open",
};

/**
 * The reply sent to one reviewer.
 *
 * `quotePrior` re-states the reviewer's own findings. Only needed when the
 * session cannot resume — with resume, the agent is already looking at them,
 * and repeating them back reads as though it had been misunderstood.
 */
export function buildReply({ agent, thread, sha, worktree, quotePrior, stopToken, others = [] }) {
  // Only findings actually answered. An item still marked open has no verdict
  // to discuss, and padding the reply with "still open" invites the reviewer to
  // re-argue something nobody responded to yet.
  const answered = thread.filter((f) => f.status !== "open");
  if (!answered.length) return null;

  // Isolation is enforced here rather than trusted to whoever wrote the
  // reason text. A verdict that says "agy raised this too" tells codex its
  // finding was corroborated, which is exactly the cross-contamination that
  // makes two reviewers agreeing stop counting as evidence.
  // Ids first: replacing the bare name would leave "r1-another reviewer-4".
  // A preceding article is absorbed too, so "the codex thread" does not become
  // the ungrammatical "the another reviewer thread".
  const scrub = (s) => others.reduce(
    (acc, name) => acc
      .replace(new RegExp(`\\br\\d+-${name}-\\d+\\b`, "gi"), "another reviewer's finding")
      .replace(new RegExp(`\\b(?:the|a)\\s+${name}\\b`, "gi"), "another reviewer's")
      .replace(new RegExp(`\\b${name}\\b`, "gi"), "another reviewer"),
    s ?? "",
  );

  const items = answered.map((f, i) => {
    const n = i + 1;
    const label = VERDICT_LABEL[f.status] ?? f.status;
    const parts = [`**${n}. ${f.claim}${f.loc ? ` (${f.loc})` : ""} — ${label}.**`];

    // With no session to carry it, the reviewer needs its own words back before
    // the verdict on them means anything.
    if (quotePrior && f.body) {
      parts.push(`\nYou wrote:\n\n> ${f.body.split("\n").join("\n> ")}`);
    }

    if (f.reason) parts.push(`\n${scrub(f.reason)}`);
    if (f.reproduced && typeof f.reproduced === "string") {
      parts.push(`\nReproduced first: ${scrub(f.reproduced)}`);
    }
    if (f.test) parts.push(`\nRegression test: ${scrub(f.test)} — verified failing with the fix reverted.`);

    // A direct question per item is what makes this a conversation rather than
    // a changelog. In the reference run it turned two "you should fix this"
    // items into explicit agreement to defer.
    parts.push(`\n${question(f)}`);
    return parts.join("\n");
  });

  return `Thanks — I acted on your review of ${sha}. Here is what I did with each of your findings,
including where I disagree. The final state is at ${worktree} (detached at ${sha}).

These are your findings only. Other reviewers looked at this change independently; I am not
relaying their comments to you, and I am not asking you to agree with anyone but me.

${items.join("\n\n")}

Please check the current state and answer the questions above. If you still disagree with any of my
positions, say so and why — I would rather be corrected now than ship it.

If you have no remaining correctness problems, say exactly "${stopToken}" on its own line.
Do not edit any files.
`;
}

function question(f) {
  switch (f.status) {
    case "accepted":
      return "Question: does the fix actually close the case you had in mind, or did I fix a narrower version of it?";
    case "deferred":
      return "Question: do you agree it is (a) pre-existing and (b) not made materially more likely by this change?";
    case "rejected":
      return "Question: does that evidence settle it, or have I misread what you meant?";
    default:
      return "Question: is that an accurate reading of your finding?";
  }
}

/** argv for a reply, honouring whether this agent can resume its session. */
export function replyArgv(agent, { promptText, promptFile, worktree }) {
  const resumable = agent.resume?.supported && agent.resume?.argv?.length;
  const argv = resumable ? agent.resume.argv : agent.argv;
  return {
    argv: argv.map((a) =>
      a.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ promptText, promptFile, worktree }[k] ?? "")),
    ),
    resumed: Boolean(resumable),
  };
}
