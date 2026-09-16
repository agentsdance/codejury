import { findingPr } from "./review-group.js";
// The autonomous loop: reviewers argue with the main agent until they stop.
//
// Everything here exists because the original design left three jobs to a human
// sitting between rounds — deciding whether a finding reproduces, fixing what
// does, and pushing so the next round has new code to read. Without someone in
// that seat `--max-rounds 10` re-reviews the same SHA ten times and calls it a
// loop. This module fills the seat.
//
// The shape is a conversation, not a pipeline. A reviewer makes a claim, the
// main agent answers it — reproduced and fixed, or disputed and why — and the
// reviewer answers back. That exchange is the product; the commits are a side
// effect of agreeing.
import path from "node:path";
import { runAgent } from "./agents.js";
import { buildReply, threadFor, replyArgv } from "./reply.js";
import { findingsIn, gate, settledList } from "./findings.js";
import { appendEvent, writeArtifact } from "./store.js";

// How many times one finding may be argued before it is set down. A reviewer
// convinced of a false positive will re-assert it indefinitely, and each
// re-assertion costs a full round; the run has to terminate whether or not
// anyone was persuaded. Both positions stay in the log, so "we disagreed" is
// recorded rather than resolved by fiat.
export const MAX_TURNS = 3;

/** The judge in force at the end of a run, with a legacy-run fallback. */
export function currentJudge(events) {
  let judge = "claude";
  for (const e of events) {
    if (e.t === "target" && e.target?.judge) judge = e.target.judge;
  }
  return judge;
}

/**
 * One finding's state across the whole run, which is what decides whether the
 * loop may stop. `turns` counts round-trips on this specific claim, not rounds.
 */
export function turnsFor(events, id) {
  return events.filter((e) => e.t === "finding.turn" && e.id === id).length;
}

/**
 * Findings this round must answer: everything still open, plus anything the
 * reviewer re-raised after we answered it. Re-raising is the disagreement
 * signal — a reviewer that accepted our reasoning simply stops mentioning it.
 */
export function outstanding(findings, events) {
  const out = [];
  for (const f of findings.values()) {
    if (f.status === "open") { out.push(f); continue; }
    // Re-raised after resolution and not yet talked out.
    if (f.contested && turnsFor(events, f.id) < MAX_TURNS) out.push(f);
  }
  return out;
}

/**
 * Deadlock rule. After MAX_TURNS exchanges on one claim the main agent stops
 * arguing and defers it: both positions are already in the log, and the choice
 * is between a terminating run that records a disagreement and a loop that
 * cannot end. Deferred is deliberately not "accepted" — fixing something nobody
 * demonstrated is how a stubborn false positive gets code written for it.
 */
export function deadlocked(events, id) {
  return turnsFor(events, id) >= MAX_TURNS;
}

/**
 * The conversation as the console renders it: one thread per reviewer, each a
 * list of turns with a speaker. Derived from the log rather than stored, so a
 * run can be replayed and the view cannot drift from what happened.
 */
export function conversation(events) {
  const threads = new Map();
  const thread = (agent) => {
    let t = threads.get(agent);
    if (!t) threads.set(agent, (t = { agent, turns: [] }));
    return t;
  };
  const claims = new Map();
  let judge = "claude"; // Runs created before --judge existed were Claude-led.

  for (const e of events) {
    switch (e.t) {
      case "target":
        judge = e.target?.judge ?? judge;
        break;
      case "finding.raised":
        // Deliberately NOT a turn of its own. The reviewer already said this in
        // its report, verbatim and in its own shape; a parsed copy underneath
        // is the same words twice. The claim is kept so a verdict further down
        // can name what it is answering.
        claims.set(e.id, { claim: e.claim, agent: e.agent });
        // The reviewer still gets a thread even if this is the only thing it
        // ever emitted: in production a report always precedes its findings,
        // but a console that hides a reviewer entirely when it does not is
        // worse than one that shows an empty column.
        thread(e.agent);
        break;
      case "finding.reproduced":
        thread(claims.get(e.id)?.agent ?? "?").turns.push({
          who: e.who ?? judge, kind: "reproduced", id: e.id,
          claim: claims.get(e.id)?.claim ?? "",
          text: typeof e.evidence === "string" ? e.evidence : "reproduced", ts: e.ts,
        });
        break;
      case "finding.resolved":
        thread(claims.get(e.id)?.agent ?? "?").turns.push({
          who: e.who ?? judge, kind: "verdict", id: e.id,
          claim: claims.get(e.id)?.claim ?? "",
          verdict: e.verdict, text: e.reason ?? "", test: e.test ?? "", ts: e.ts,
        });
        break;
      case "finding.turn":
        // A reviewer's rebuttal is an excerpt cut from the reply it arrived in,
        // and that reply is already rendered whole as its `answer` turn — so the
        // text is deliberately dropped, exactly as a raised finding's is. What
        // survives is the linkage: which claim is being re-argued, and by whom.
        // The event itself still matters even when it draws nothing, because
        // `findingsIn` folds it into `contested`/`turns`, and that is what drives
        // `outstanding` and the turn limit.
        //
        // Claude's own turn is the exception. It is not an excerpt of anything
        // shown elsewhere, so dropping its text would lose it entirely.
        {
          const who = e.who ?? "?";
          const turn = {
            who, judging: !e.agent && who === judge, kind: "rebuttal", id: e.id,
            claim: claims.get(e.id)?.claim ?? "", ts: e.ts,
          };
          if (turn.judging) turn.text = e.text ?? "";
          thread(claims.get(e.id)?.agent ?? e.agent ?? "?").turns.push(turn);
        }
        break;
      // A reviewer that does not stream. Collapsed into one turn per agent per
      // round and replaced by the report, exactly like a streaming turn — the
      // difference is only what it can say while waiting.
      case "agent.alive": {
        // `forAgent` names the reviewer whose finding is being judged, so the
        // main agent's heartbeat lands inside that reviewer's conversation
        // rather than opening a thread of its own.
        const t = thread(e.forAgent ?? e.agent);
        // Identity is role plus name, not name alone. When one CLI is both
        // judge and reviewer the two participants share a name, and matching on
        // the name alone made the reviewer's own report suppress the judge's
        // triage heartbeat — the single-agent run went blank for exactly the
        // stretch the heartbeat exists to cover. `forAgent` is what marks a beat
        // as the judge speaking on a reviewer's finding.
        const judging = e.forAgent != null;
        // Found by round, not by position. Two rounds running concurrently
        // interleave their heartbeats, so "is it the last turn?" failed on
        // every alternation and a nine-minute round grew 81 bubbles instead of
        // one.
        const w = t.turns.find(
          (x) => x.kind === "waiting" && x.round === e.round && x.who === e.agent
            && !!x.judging === judging,
        );
        if (w) { w.seconds = e.seconds; w.quietSeconds = e.quietSeconds ?? null; break; }
        // Real output already supersedes it; do not regress to a placeholder.
        // Per speaker, not per thread: the reviewer's report ends the reviewer's
        // turn, but the main agent triaging afterwards is a new speaker on the
        // same thread — keying this on the thread dropped every triage
        // heartbeat, which is the longest silence in the round and the reason
        // the heartbeat exists. A judging beat is never superseded by the
        // reviewer's output, even when they share a name.
        if (!judging && t.turns.some((x) => (x.kind === "streaming" || x.kind === "report") && x.round === e.round && x.who === e.agent)) break;
        t.turns.push({ who: e.agent, judging, kind: "waiting", round: e.round, seconds: e.seconds, quietSeconds: e.quietSeconds ?? null, ts: e.ts });
        break;
      }
      case "agent.chunk":
        // Live partial output — the reviewer mid-sentence. Collapsed into one
        // streaming turn per agent per round so the view does not grow a turn
        // per token.
        {
          const t = thread(e.agent);
          const last = t.turns[t.turns.length - 1];
          if (last?.kind === "streaming" && last.round === e.round) last.text += e.text;
          else {
            // Real output replaces the heartbeat rather than appearing beneath it.
            // Only the reviewer's own placeholder, never the judge's triage
            // beat, which is a different participant sharing the thread.
            const w = t.turns.findIndex((x) => x.kind === "waiting" && x.round === e.round && !x.judging);
            const turn = { who: e.agent, kind: "streaming", round: e.round, text: e.text, ts: e.ts };
            if (w >= 0) t.turns.splice(w, 1, turn); else t.turns.push(turn);
          }
        }
        break;
      case "agent.report":
        {
          const t = thread(e.agent);
          // The finished report replaces the streaming placeholder it was
          // being assembled into.
          const i = t.turns.findIndex(
            (x) => (x.kind === "streaming" || (x.kind === "waiting" && !x.judging)) && x.round === e.round,
          );
          const turn = {
            who: e.agent, kind: "report", round: e.round,
            verdict: e.verdict, text: e.report ?? "", seconds: e.seconds, ts: e.ts,
          };
          if (i >= 0) t.turns.splice(i, 1, turn); else t.turns.push(turn);
        }
        break;
      case "reply.sent":
        thread(e.agent).turns.push({
          who: e.who ?? judge, kind: "reply", text: e.text ?? "", resumed: e.resumed, ts: e.ts,
        });
        break;
      case "reply.answered":
        thread(e.agent).turns.push({
          who: e.agent, kind: "answer", text: e.report ?? "",
          verdict: e.verdict, seconds: e.seconds, ts: e.ts,
        });
        break;
      case "commit.pushed":
        for (const t of threads.values()) {
          t.turns.push({ who: e.who ?? judge, kind: "commit", sha: e.sha, pr: e.pr ?? null, pushed: e.pushed, text: e.subject ?? "", ts: e.ts });
        }
        break;
    }
  }
  return [...threads.values()];
}

/**
 * Ask the main agent to triage one finding, and record what it decided.
 *
 * The main agent is not a subprocess of this loop in the interactive case — it
 * is the session driving it — so `ask` is injected. Headless runs pass a
 * spawner; a Claude Code session passes a function that answers in-process.
 * Either way the answer must survive the same gate a human's would: this
 * records the reproduction attempt *before* the verdict, so an "accepted" with
 * nothing behind it is refused by findings.gate rather than believed.
 */
export async function triage(finding, { ask, dir, worktree, round, judge }) {
  const verdict = await ask({ kind: "triage", finding, worktree, round });
  // Order matters. gate() reads the folded log, so the reproduction has to be
  // on disk before the resolve is checked against it.
  if (verdict.reproduced) {
    await appendEvent(dir, {
      t: "finding.reproduced", id: finding.id,
      evidence: verdict.reproduced, test: verdict.test ?? null,
      ...(judge ? { who: judge } : {}),
    });
  }
  return verdict;
}

/**
 * Record a verdict, refusing anything the gate rejects.
 *
 * A refusal is not an error — it is the gate doing its job, and the loop
 * downgrades rather than dying: an acceptance with no reproduction becomes an
 * open finding again, which the next round will re-raise. Crashing here would
 * throw away a whole round of reviewer time over one badly-formed answer.
 */
export async function record(dir, findings, id, { verdict, reason, test, who }) {
  const f = findings.get(id);
  const why = gate(f, { verdict, test });
  if (why) return { ok: false, why };
  await appendEvent(dir, { t: "finding.resolved", id, verdict, reason: reason ?? "", test: test ?? null, ...(who ? { who } : {}) });
  return { ok: true };
}

/**
 * Findings still awaiting a verdict, folded from the log.
 *
 * A clean round is not convergence on its own. Triage can leave a finding open
 * — the main agent failed, or the gate refused an unbacked acceptance — and a
 * reply can raise a brand new one after the last triage of the round has
 * already run. Neither reaches settled.md, because settled.md only lists what
 * has a verdict, so the next round's reviewers are never shown it and can
 * quite honestly all emit the stop token. Answering "did everybody sign off?"
 * without also asking "is anything still open?" declares the run finished with
 * work nobody ever looked at.
 */
export async function openFindings(dir) {
  const findings = await findingsIn(dir);
  return [...findings.values()].filter((f) => f.status === "open");
}

/**
 * The settled list, rewritten from the log before every round.
 *
 * This is the difference between ten rounds and one round run ten times.
 * `buildPrompt` reads settled.md; nothing regenerated it between rounds, so
 * every round carried the same (usually empty) list and reviewers re-raised
 * what had already been deferred — exactly the non-termination the list exists
 * to prevent.
 */
export async function refreshSettled(dir) {
  const findings = await findingsIn(dir);
  const text = settledList(findings);
  await writeArtifact(dir, "settled.md", text ? text + "\n" : "");
  return text;
}

/**
 * One reply turn per reviewer, concurrently, about its own findings only.
 *
 * Returns whether each reviewer signed off. A reviewer that answers with the
 * stop token has stopped arguing; one that comes back with more findings has
 * not, and its rebuttal is recorded against the findings it concerns so the
 * turn counter can eventually end the argument.
 */
export async function replyRound({ dir, pool, cfg, worktree, sha, round, findings, sessions, dryRun, judge, onLog, onChunk, context, targets }) {
  const names = pool.map((a) => a.name);
  const out = await Promise.all(pool.map(async (a) => {
    const thread = threadFor(a.name, findings);
    const sessionId = sessions?.get(a.name) ?? undefined;
    const canResume = replyArgv(a, { sessionId }).resumed;
    const text = buildReply({
      context,
      agent: a.name, thread, sha, worktree,
      quotePrior: !canResume,
      stopToken: cfg.stopToken,
      others: names.filter((n) => n !== a.name),
    });
    // Nothing answered is NOT a sign-off. Reporting `clean` here let a run with
    // every finding still open satisfy `answers.every(a => a.clean)` and
    // announce convergence — the reviewer was never asked anything, so it
    // cannot have agreed to anything.
    if (!text) return { agent: a.name, skipped: true, clean: false };

    // The session recorded when this reviewer produced its review, so the reply
    // lands in that conversation rather than whichever ran most recently.
    const { argv, resumed } = replyArgv(a, { promptText: text, worktree, sha, sessionId });
    await appendEvent(dir, { t: "reply.sent", agent: a.name, resumed, sessionId, text, ...(judge ? { who: judge } : {}) });

    const r = await runAgent({ ...a, argv }, {
      worktree, prompt: text, stopToken: cfg.stopToken, dryRun,
      // Which reviewer this line belongs to: replies run concurrently, so an
      // unattributed line could have come from any of them.
      onLog: (m) => onLog?.(m, a.name),
      onChunk: (t) => onChunk?.(a.name, t),
    });
    await appendEvent(dir, {
      t: "reply.answered", agent: a.name, verdict: r.verdict,
      seconds: r.seconds, report: r.report,
    });

    // A reviewer that re-argues a finding we already answered is the
    // disagreement signal. Recorded per finding, because the turn limit is per
    // claim: one contested item must not spend the whole run's budget.
    for (const f of thread) {
      if (f.status === "open") continue;
      if (mentions(r.report, f)) {
        await appendEvent(dir, {
          t: "finding.turn", id: f.id, agent: a.name, who: a.name,
          text: excerpt(r.report, f),
        });
      }
    }

    // A reviewer checking our fix often finds something else while it is in
    // there. Those were parsed and thrown away: only turns against KNOWN
    // findings were recorded, so a genuinely new bug discovered during a reply
    // was untrackable, and a later quiet round could call the run converged
    // without it ever reaching triage.
    const fresh = (r.findings ?? []).filter((nf) => !thread.some((f) => same(f, nf)));
    for (const [n, nf] of fresh.entries()) {
      await appendEvent(dir, {
        t: "finding.raised", id: `${round}-${a.name}-reply-${n + 1}`, round,
        agent: a.name, claim: nf.claim, loc: nf.loc, body: nf.body, pr: findingPr(nf.loc, targets),
      });
    }

    return {
      agent: a.name,
      // A reviewer that could not run has not agreed to anything. A quota wall,
      // an auth failure or a timeout all arrive as verdict "error", and
      // treating that as a sign-off would report agreement one of the reviewers
      // never expressed — the exact thing running more than one is for.
      failed: !r.ok || r.verdict === "error",
      // New findings mean it is not signed off, whatever the stop token said.
      clean: r.ok && r.verdict === "clean" && !fresh.length,
      raised: fresh.length,
      report: r.report,
      seconds: r.seconds,
    };
  }));
  return out;
}

/**
 * Did this reply re-argue that finding? Deliberately loose — a false positive
 * costs one extra turn, a false negative silently ends an argument the reviewer
 * was still having.
 */
/** Two claims are the same finding when they name the same place and read alike. */
function same(f, nf) {
  if (f.loc && nf.loc && f.loc === nf.loc) return true;
  const norm = (s) => (s ?? "").toLowerCase().replace(/\W+/g, " ").trim();
  return norm(f.claim) === norm(nf.claim);
}

function mentions(report, f) {
  if (!report) return false;
  const hay = report.toLowerCase();
  if (f.loc && hay.includes(f.loc.toLowerCase().split(":")[0])) return true;
  const words = f.claim.toLowerCase().split(/\W+/).filter((w) => w.length > 5);
  if (!words.length) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits >= Math.max(2, Math.ceil(words.length / 3));
}

function excerpt(report, f) {
  const lines = (report ?? "").split("\n");
  const key = f.claim.toLowerCase().split(/\W+/).filter((w) => w.length > 5)[0] ?? "";
  const i = lines.findIndex((l) => key && l.toLowerCase().includes(key));
  return (i >= 0 ? lines.slice(Math.max(0, i - 1), i + 6) : lines.slice(0, 6)).join("\n").trim();
}

/**
 * The session each reviewer last reported from, folded out of the log.
 *
 * Recorded at review time and read at reply time: a reply must resume the
 * conversation that produced the findings it answers, not whichever session
 * happens to be most recent in the worktree.
 */
export function sessionsIn(events) {
  const byAgent = new Map();
  for (const e of events) {
    if (e.t === "agent.report") {
      if (e.sessionId) byAgent.set(e.agent, e.sessionId);
      else byAgent.delete(e.agent);
    }
  }
  return byAgent;
}
