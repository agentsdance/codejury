// Where a run lives on disk.
//
// runs/<slug>/events.ndjson  append-only; two writers are safe (the CLI appends
//                            agent events, the main agent appends verdicts)
// runs/<slug>/run.json       the folded view the console reads
import { mkdir, readFile, writeFile, appendFile, readdir, open } from "node:fs/promises";
import path from "node:path";

/**
 * Where a run lives.
 *
 * `attempt` separates one invocation from another. Without it every
 * `macr agent <same-pr>` appended to the same directory, so three separate
 * reviews merged into rounds 1-5 of a single run — and a killed run's open
 * rounds interleaved with the next one's. Rounds within ONE invocation still
 * belong together; two invocations do not.
 */
export function slugFor(target) {
  const repo = (target.repo ?? "repo").replace(/[^\w.-]+/g, "-");
  const id = String(target.id ?? "0").replace(/[^\w.-]+/g, "");
  const base = `${repo}-${id}`;
  const attempt = target.attempt ? String(target.attempt).replace(/[^\w.-]+/g, "") : "";
  return attempt ? `${base}-${attempt}` : base;
}

/**
 * A short, sortable stamp identifying one invocation: YYYYMMDD-HHMM.
 * Sortable so the directory listing reads chronologically, and minute
 * granularity because two runs of the same PR in the same minute are the same
 * mistake as running it twice by accident.
 */
export function attemptStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}`;
}

export function runsDir(cwd = process.cwd()) {
  return path.join(cwd, "runs");
}

export async function appendEvent(dir, event) {
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  await appendFile(path.join(dir, "events.ndjson"), line + "\n", "utf8");
}

export async function readEvents(dir) {
  try {
    const raw = await readFile(path.join(dir, "events.ndjson"), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // a torn line must not blank the run
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Verbatim text kept beside the event log — the prompt a reviewer was given and
 * the raw stream it produced. These are the evidence that the review happened
 * and are often far too large for the event log, so they live in their own files.
 */
export async function writeArtifact(dir, name, text) {
  await mkdir(dir, { recursive: true });
  const safe = name.replace(/[^\w.-]+/g, "_");
  await writeFile(path.join(dir, safe), text ?? "", "utf8");
  return safe;
}

/**
 * An artifact opened for incremental writing, so a reviewer's stream reaches
 * disk while it is still talking rather than only when it exits. Writes are
 * chained through one promise: fs handles do not queue concurrent writes, and
 * chunks arriving faster than the disk can take them would otherwise interleave.
 */
export async function openArtifact(dir, name) {
  await mkdir(dir, { recursive: true });
  const safe = path.basename(name);
  const fh = await open(path.join(dir, safe), "w");
  let chain = Promise.resolve();
  let closed = false;
  return {
    name: safe,
    write(text) {
      if (closed) return chain;
      // Swallowed on purpose: a failed tail-write must not kill a review that
      // is otherwise fine, and r.raw still holds the authoritative copy.
      chain = chain.then(() => fh.write(text)).catch(() => {});
      return chain;
    },
    async close() {
      if (closed) return;
      closed = true;
      await chain;
      await fh.close().catch(() => {});
    },
  };
}

export async function readArtifact(dir, name) {
  // Never let a caller-supplied name walk out of the run directory.
  const safe = path.basename(name);
  return readFile(path.join(dir, safe), "utf8");
}

export async function writeRun(dir, run) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", "utf8");
}

export async function readRun(dir) {
  const raw = await readFile(path.join(dir, "run.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Every run under runs/. A malformed one is skipped and reported, never fatal —
 * one bad file must not blank the whole console.
 */
export async function listRuns(base) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { runs: [], skipped: [] };
    throw err;
  }
  const runs = [];
  const skipped = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      // The directory name is how the console asks for this run's artifacts.
      runs.push({ slug: e.name, ...(await readRun(path.join(base, e.name))) });
    } catch (err) {
      skipped.push({ dir: e.name, reason: err.code === "ENOENT" ? "no run.json" : err.message });
    }
  }
  const rank = { human: 0, review: 1, queued: 2, converged: 3, merged: 4 };
  runs.sort((a, b) => {
    const ra = rank[a.target?.state] ?? 9;
    const rb = rank[b.target?.state] ?? 9;
    return ra - rb || String(a.target?.id).localeCompare(String(b.target?.id));
  });
  return { runs, skipped };
}

/** Fold the event log into the shape the console renders. */
export function foldEvents(events, seed = {}) {
  const run = {
    target: seed.target ?? {},
    rounds: [],
    exchanges: [],
    replies: [],
    lanes: [],
    marks: [],
    ship: [],
    tlfoot: "",
    foot: "",
    ...seed,
  };
  const findings = new Map();
  const lanes = new Map(); // agent -> lane, kept in launch order
  let t0 = null;
  let lastMin = 0;

  const laneFor = (agent) => {
    let lane = lanes.get(agent);
    if (!lane) lanes.set(agent, (lane = { who: agent, label: agent, segs: [] }));
    return lane;
  };

  for (const e of events) {
    const at = e.ts ? Date.parse(e.ts) : null;
    if (at && t0 === null) t0 = at;
    const min = at && t0 !== null ? +((at - t0) / 60000).toFixed(1) : 0;
    if (min > lastMin) lastMin = min;

    switch (e.t) {
      case "round.start":
        run.rounds.push({
          n: e.n, sha: e.sha ?? "", verdicts: [], startMin: min,
          // The exact text the reviewers were given, so a verdict can be read
          // against the question that produced it.
          prompt: e.prompt ?? "", promptFile: e.promptFile ?? "",
        });
        run.marks.push({ at: min, l: `round ${e.n}` });
        break;
      case "agent.launch":
        laneFor(e.agent).segs.push({ r: e.round, s: min });
        break;
      case "agent.report": {
        const r = run.rounds.find((x) => x.n === e.round);
        r?.verdicts.push({
          a: e.agent, s: e.verdict, t: e.summary ?? e.verdict, seconds: e.seconds,
          // Full text, not just the first line: a clean verdict still carries
          // what the reviewer checked and what it could not check.
          report: e.report ?? "", rawFile: e.rawFile ?? "", rawBytes: e.rawBytes ?? 0,
          at: e.ts ?? "", atMin: min,
        });
        // Closes the span its own launch opened, so two rounds stay two spans.
        const seg = lanes.get(e.agent)?.segs.find((s) => s.r === e.round && s.e === undefined);
        if (seg) seg.e = min;
        break;
      }
      case "finding.raised":
        findings.set(e.id, {
          id: e.id, round: e.round, with: e.agent, claim: e.claim,
          loc: e.loc ?? "", res: "open", turns: [],
        });
        break;
      case "finding.reproduced": {
        const f = findings.get(e.id);
        if (f) f.reproduced = e.evidence ?? true;
        break;
      }
      case "finding.resolved": {
        const f = findings.get(e.id);
        if (f) { f.res = e.verdict; f.outcome = e.reason ?? ""; }
        break;
      }
      // A reply is a turn in one reviewer's conversation, not a round of its
      // own: it concerns only that reviewer's findings, so it hangs off them
      // rather than appearing as a fourth round nobody ran.
      case "reply.sent":
        for (const f of findings.values()) {
          if (f.with === e.agent && f.res !== "open") {
            f.turns.push({ who: "claude", kind: "reply", resumed: e.resumed, at: min });
          }
        }
        break;
      case "reply.answered": {
        const lane = laneFor(e.agent);
        lane.segs.push({ r: "reply", s: min, e: min, t: `reply · ${e.seconds}s` });
        for (const f of findings.values()) {
          if (f.with === e.agent && f.res !== "open") {
            f.turns.push({ who: e.agent, kind: "answer", seconds: e.seconds, at: min });
          }
        }
        run.replies = [
          ...(run.replies ?? []),
          { agent: e.agent, verdict: e.verdict, seconds: e.seconds, report: e.report ?? "" },
        ];
        break;
      }
      case "target":
        run.target = { ...run.target, ...e.target };
        break;
    }
  }

  // A launch with no report — the agent was killed, or the round is still
  // running. Only the LAST round can still be running: once a later round has
  // started, an unfinished launch from an earlier one is abandoned, not live.
  // Running those to the newest event drew a span across every round that
  // followed — a killed reviewer showed as "963.7 min · unfinished" stretched
  // over the whole timeline, burying the rounds that actually happened.
  const lastRound = Math.max(0, ...run.rounds.map((r) => r.n));
  // Where each round ended, so an abandoned span stops at its own round rather
  // than at the present moment.
  const endOf = new Map();
  for (const r of run.rounds) {
    const done = r.verdicts.map((v) => v.atMin).filter((m) => typeof m === "number");
    if (done.length) endOf.set(r.n, Math.max(...done));
  }
  for (const lane of lanes.values()) {
    for (const s of lane.segs) {
      if (s.e !== undefined) continue;
      const live = s.r === lastRound || s.r === "reply";
      if (live) {
        s.e = Math.max(s.s, lastMin);
        s.open = true;
        s.t = `round ${s.r} · ${+(s.e - s.s).toFixed(1)} min · still running`;
      } else {
        // Abandoned: end it where its own round ended, or at its start if
        // nothing in that round ever reported.
        s.e = Math.max(s.s, endOf.get(s.r) ?? s.s);
        s.abandoned = true;
        s.t = `round ${s.r} · never finished`;
      }
    }
  }

  run.lanes = [...lanes.values()];
  run.exchanges = [...findings.values()];
  // Spans count too: one ending past the last mark would overflow the timeline.
  run.totalMin = Math.max(
    1,
    ...run.marks.map((m) => m.at),
    ...run.lanes.flatMap((l) => l.segs.map((s) => s.e)),
  );
  return run;
}
