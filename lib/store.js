// Where a run lives on disk.
//
// runs/<slug>/events.ndjson  append-only; two writers are safe (the CLI appends
//                            agent events, the main agent appends verdicts)
// runs/<slug>/run.json       the folded view the console reads
import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import path from "node:path";

export function slugFor(target) {
  const repo = (target.repo ?? "repo").replace(/[^\w.-]+/g, "-");
  const id = String(target.id ?? "0").replace(/[^\w.-]+/g, "");
  return `${repo}-${id}`;
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
          at: e.ts ?? "",
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
      case "target":
        run.target = { ...run.target, ...e.target };
        break;
    }
  }

  // A launch with no report — the agent was killed, or the run is still going.
  // Run the span to the last event we saw rather than dropping it, and flag it
  // so the console can draw it even when it has no width yet: when the launch
  // IS the last event, s === e, and a zero-width bar is invisible in every
  // sense — no fill, no label, and a tooltip on a box nobody can hover.
  for (const lane of lanes.values()) {
    for (const s of lane.segs) {
      if (s.e !== undefined) continue;
      s.e = Math.max(s.s, lastMin);
      s.open = true;
      s.t = `round ${s.r} · ${+(s.e - s.s).toFixed(1)} min · unfinished`;
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
