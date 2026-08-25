#!/usr/bin/env node
// macr — run a pull request past several independent AI reviewers.
//
// The CLI owns the mechanics: worktrees, spawning agents, capturing what they
// said, recording it, serving the console. It deliberately does NOT triage —
// deciding whether a finding reproduces is the calling agent's job, and roughly
// a third of suggestions do not survive that step.
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadConfig, reviewers, mainAgent } from "../lib/config.js";
import { runAgent, probe } from "../lib/agents.js";
import { threadFor, buildReply, replyArgv } from "../lib/reply.js";
import { buildPrompt } from "../lib/prompt.js";
import { serve } from "../lib/server.js";
import { appendEvent, writeRun, readEvents, foldEvents, slugFor, runsDir, writeArtifact } from "../lib/store.js";
import { findingsIn, gate, settledList, VERDICTS } from "../lib/findings.js";

const run = promisify(execFile);
const VERSION = "0.1.0";

const USAGE = `macr — multi-agent code review

  macr review [flags]     run rounds until convergence or --max-rounds
  macr web [flags]        serve the console (default http://127.0.0.1:3080)
  macr finding <cmd>      list | reproduce | resolve | settled — appends events, enforces the gate
  macr reply [flags]      send each reviewer your verdicts on ITS findings, one conversation each
  macr runs               list every PR under review, with its slug for --run
  macr agents             check which configured agents are installed
  macr version

review flags
  --dir <path>       repo/worktree the reviewers read        (default .)
  --pr <url>         pull request URL, recorded on the run
  --title <text>     what the change does, shown in the console
  --summary <text>   a few lines of intent, passed to reviewers
  --trunk <branch>   diff base branch                        (default master)
  --round <n>        round number                            (default: next)
  --agents a,b       only these reviewers                    (default: all enabled)
  --max-rounds <n>   keep going until convergence, at most n (default 1)
  --dry-run          do not spawn anything; exercise the pipeline

web flags
  --port <n>         default 3080, walks forward if busy
  --open             open a browser

finding commands                                (--run <slug> picks the run)
  macr finding list
  macr finding reproduce <id> --evidence <text> [--test <text>]
  macr finding resolve <id> --verdict <${VERDICTS.join("|")}> [--reason <text>] [--test <text>]
  macr finding settled                          print the regenerated settled list
`;

const [, , cmd, ...rest] = process.argv;

try {
  switch (cmd) {
    case "review": await cmdReview(rest); break;
    case "web": await cmdWeb(rest); break;
    case "finding": case "findings": await cmdFinding(rest); break;
    case "reply": await cmdReply(rest); break;
    case "runs": await cmdRuns(); break;
    case "agents": await cmdAgents(); break;
    case "version": case "-v": case "--version": console.log(`macr ${VERSION}`); break;
    case "help": case "-h": case "--help": case undefined: process.stdout.write(USAGE); break;
    default:
      console.error(`macr: unknown command "${cmd}"\n`);
      process.stdout.write(USAGE);
      process.exit(2);
  }
} catch (err) {
  console.error(`macr: ${err.message}`);
  process.exit(1);
}

async function cmdReview(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      dir: { type: "string", default: "." },
      pr: { type: "string" },
      title: { type: "string" },
      summary: { type: "string", default: "" },
      trunk: { type: "string", default: "master" },
      round: { type: "string" },
      agents: { type: "string" },
      "max-rounds": { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const maxRounds = Number(values["max-rounds"]);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error("--max-rounds must be a positive integer");
  }

  const cfg = await loadConfig();
  let pool = reviewers(cfg);
  if (values.agents) {
    const want = new Set(values.agents.split(",").map((s) => s.trim()));
    pool = pool.filter((a) => want.has(a.name));
    if (!pool.length) throw new Error(`no configured reviewer matches "${values.agents}"`);
  }

  const worktree = path.resolve(values.dir);
  const git = await describe(worktree, values.trunk);
  const target = {
    repo: values.pr ? repoFromUrl(values.pr) : git.repo,
    id: values.pr ? idFromUrl(values.pr) : git.branch,
    url: values.pr ?? "",
    title: values.title ?? git.subject,
    branch: git.branch,
    trunk: values.trunk,
    state: "review",
    // Always set, never left to inherit. Target events are merged key by key,
    // so omitting this would carry the previous round's note onto the new
    // state — a live round labelled "converged".
    stateNote: "",
  };

  const dir = path.join(runsDir(), slugFor(target));
  const prior = await readEvents(dir);
  const firstRound = values.round
    ? Number(values.round)
    : Math.max(0, ...prior.filter((e) => e.t === "round.start").map((e) => e.n)) + 1;

  console.log(`target   ${target.repo} ${target.id}`);
  console.log(`worktree ${worktree} @ ${git.sha}`);
  console.log(`agents   ${pool.map((a) => a.name).join(", ")}${values["dry-run"] ? "  (dry run)" : ""}`);
  if (maxRounds > 1) console.log(`rounds   ${firstRound}..${firstRound + maxRounds - 1} (until convergence)`);
  console.log("");

  for (let i = 0; i < maxRounds; i++) {
    const round = firstRound + i;
    // Re-read HEAD each round: between rounds the operator fixes what
    // reproduced and pushes, so a later round must review the new commit, not
    // the one the loop started on.
    const head = await describe(worktree, values.trunk);
    const converged = await runRound({
      dir, round, pool, cfg, target, worktree, values, sha: head.sha,
    });
    if (converged) break;
    if (i + 1 < maxRounds) {
      console.log(`\nfix what reproduces and push, then round ${round + 1} reviews the new HEAD.\n`);
    }
  }
}

/** One round: prompt, launch every reviewer, record what they said. */
async function runRound({ dir, round, pool, cfg, target, worktree, values, sha }) {
  const git = { sha };
  console.log(`round    ${round}`);

  // Built before the round opens so the exact text handed to the reviewers is
  // part of the record. A verdict is only readable next to the question asked.
  const prompt = await buildPrompt({
    target, trunk: values.trunk, summary: values.summary,
    stopToken: cfg.stopToken, settledFile: path.join(dir, "settled.md"),
  });
  const promptFile = await writeArtifact(dir, `round-${round}.prompt.md`, prompt);

  await appendEvent(dir, {
    t: "target",
    target: { ...target, stateNote: `round ${round} running — ${pool.length} reviewer(s)` },
  });
  await appendEvent(dir, { t: "round.start", n: round, sha: git.sha, prompt, promptFile });
  // Publish immediately: a review that takes 18 minutes should be visible for
  // all 18, not appear only once it is over.
  const publish = async () => writeRun(dir, foldEvents(await readEvents(dir), { target }));
  await publish();

  // Concurrently: the slowest reviewer sets the round's wall clock, and running
  // an 18-minute agent behind a 2-minute one wastes most of it.
  const started = Date.now();
  const results = await Promise.all(
    pool.map(async (a) => {
      await appendEvent(dir, { t: "agent.launch", agent: a.name, round });
      const r = await runAgent(a, {
        worktree, prompt, stopToken: cfg.stopToken,
        dryRun: values["dry-run"], onLog: (m) => console.log(`  ${m}`),
      });
      // The unedited stream, before extractReport picks the final turn out of a
      // verbose transcript. Kept so the extraction itself can be checked.
      const rawFile = await writeArtifact(dir, `round-${round}.${a.name}.stdout.txt`, r.raw ?? "");
      await appendEvent(dir, {
        t: "agent.report", agent: a.name, round,
        verdict: r.verdict, seconds: r.seconds, summary: firstLine(r.report), report: r.report,
        rawFile, rawBytes: (r.raw ?? "").length,
      });
      if (r.contradicted) {
        console.log(`  ${a.name}: said the stop token but also listed findings — treating as findings`);
      }
      // Each claim becomes its own tracked item. They open unresolved on
      // purpose: the CLI records what was said, the calling agent decides
      // whether it reproduces.
      for (const [n, f] of (r.findings ?? []).entries()) {
        await appendEvent(dir, {
          t: "finding.raised", id: `r${round}-${a.name}-${n + 1}`, round,
          agent: a.name, claim: f.claim, loc: f.loc, body: f.body,
        });
      }
      await publish(); // each reviewer lands as it finishes
      return r;
    })
  );

  const clean = results.filter((r) => r.ok).every((r) => r.verdict === "clean");
  const errored = results.filter((r) => !r.ok);
  const raised = results.reduce((n, r) => n + (r.findings?.length ?? 0), 0);

  // The state the run was launched with says "review", which stops being true
  // the moment the round ends. Restate it, or the console keeps asserting a
  // review is running after it converged.
  const state = errored.length ? "human" : clean ? "converged" : "review";
  const stateNote = errored.length
    ? `${errored.length} reviewer(s) failed to run`
    : clean
      ? `converged on ${git.sha}`
      : `round ${round} — ${raised || "unparsed"} finding(s) to triage`;
  await appendEvent(dir, { t: "target", target: { ...target, state, stateNote } });
  await appendEvent(dir, { t: "round.end", n: round });
  await publish();

  console.log(`\nround ${round} — ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  for (const r of results) {
    const mark = r.verdict === "clean" ? "clean" : r.verdict === "error" ? "ERROR" : "findings";
    const n = r.findings?.length ? `  ${r.findings.length} finding(s)` : "";
    console.log(`${r.agent.padEnd(8)} ${String(r.seconds).padStart(6)}s  ${mark}${n}`);
  }

  console.log("");
  if (errored.length) console.log(`${errored.length} reviewer(s) failed to run — see the reports below.`);
  console.log(clean && !errored.length
    ? `CONVERGED — every reviewer emitted the stop token on ${git.sha}.`
    : `NOT converged. Triage the findings, fix what reproduces, push, then run round ${round + 1}.`);
  console.log(`\nrecorded: ${path.relative(process.cwd(), dir)}`);

  // Every reviewer's report, including the clean ones: a sign-off still says
  // what was checked, and reading only the complaints hides that.
  for (const r of results) {
    const head = r.verdict === "clean" ? `${r.agent}  (clean)` : r.agent;
    console.log(`\n${"─".repeat(64)}\n${head}\n${"─".repeat(64)}\n${r.report}`);
  }

  // A failed reviewer is not convergence. Stopping the loop here would report
  // agreement that one of the reviewers never actually expressed.
  return clean && !errored.length;
}

async function cmdWeb(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: { port: { type: "string", default: "3080" }, open: { type: "boolean", default: false } },
  });
  const { url, port } = await serve({ port: Number(values.port) });
  console.log(`console: ${url}`);
  console.log(`runs:    ${path.relative(process.cwd(), runsDir()) || "runs"}/`);
  if (values.open) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(cmd, [url], () => {});
  }
  process.on("SIGINT", () => { console.log("\nstopped"); process.exit(0); });
  return new Promise(() => {}); // serve until interrupted
}

/**
 * The triage gate as a command. The CLI does not decide whether a finding
 * reproduces — that is the calling agent's judgement — but it does refuse to
 * record an acceptance that never demonstrated one.
 */
async function cmdFinding(argv) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      run: { type: "string" },
      evidence: { type: "string" },
      test: { type: "string" },
      verdict: { type: "string" },
      reason: { type: "string" },
    },
  });

  const dir = await resolveRun(values.run);
  const findings = await findingsIn(dir);
  const id = positionals[0];

  switch (sub) {
    case "list": {
      if (!findings.size) { console.log("no findings recorded yet"); return; }
      for (const f of findings.values()) {
        const repro = f.reproduced ? "reproduced" : "unverified";
        console.log(`${f.id.padEnd(18)} ${f.status.padEnd(10)} ${repro.padEnd(11)} ${f.agent.padEnd(7)} ${f.claim}`);
        if (f.loc) console.log(`${" ".repeat(18)} ${f.loc}`);
      }
      return;
    }

    case "reproduce": {
      if (!id) throw new Error("usage: macr finding reproduce <id> --evidence <text>");
      if (!findings.has(id)) throw new Error(`no such finding: ${id}`);
      if (!values.evidence) throw new Error("--evidence is required: what demonstrated the finding");
      await appendEvent(dir, {
        t: "finding.reproduced", id, evidence: values.evidence, test: values.test,
      });
      await republish(dir);
      console.log(`${id}: reproduction recorded`);
      return;
    }

    case "resolve": {
      if (!id) throw new Error(`usage: macr finding resolve <id> --verdict <${VERDICTS.join("|")}>`);
      const why = gate(findings.get(id), { verdict: values.verdict, test: values.test });
      // Refused, not merely warned: this is the half of the discipline that
      // survives the operator deciding to skip it.
      if (why) throw new Error(`refused: ${why}`);
      await appendEvent(dir, {
        t: "finding.resolved", id, verdict: values.verdict, reason: values.reason ?? "", test: values.test,
      });
      await republish(dir);
      console.log(`${id}: ${values.verdict}`);
      return;
    }

    case "settled": {
      const list = settledList(findings);
      // Written where buildPrompt already looks for it, so the next round
      // carries it without anyone maintaining a list by hand.
      await writeArtifact(dir, "settled.md", list ? list + "\n" : "");
      console.log(list || "(nothing settled yet)");
      return;
    }

    default:
      throw new Error(`unknown finding command "${sub ?? ""}" — try list, reproduce, resolve, settled`);
  }
}

/**
 * Reply to each reviewer about its own findings — separate conversations, run
 * concurrently. A reviewer never sees another reviewer's findings or verdicts:
 * two reviewers that read each other stop being independent, and the agreement
 * between them stops being evidence.
 */
async function cmdReply(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      run: { type: "string" },
      dir: { type: "string", default: "." },
      agents: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const cfg = await loadConfig();
  const dir = await resolveRun(values.run);
  const findings = await findingsIn(dir);
  const worktree = path.resolve(values.dir);
  const { sha } = await describe(worktree, "master");

  let pool = reviewers(cfg);
  if (values.agents) {
    const want = new Set(values.agents.split(",").map((s) => s.trim()));
    pool = pool.filter((a) => want.has(a.name));
  }
  // Only reviewers that actually said something, and only once you have
  // answered them: a reply that says "still open" for every item is noise.
  pool = pool.filter((a) => {
    const t = threadFor(a.name, findings);
    return t.length && t.some((f) => f.status !== "open");
  });
  if (!pool.length) throw new Error("nothing to reply about — resolve some findings first");

  const main = mainAgent(cfg);
  console.log(`main     ${main?.name ?? "(unset)"}`);
  console.log(`replying ${pool.map((a) => a.name).join(", ")}  (separate conversations)`);
  console.log("");

  await Promise.all(pool.map(async (a) => {
    const thread = threadFor(a.name, findings);
    const resumable = Boolean(a.resume?.supported && a.resume?.argv?.length);
    const text = buildReply({
      agent: a.name, thread, sha, worktree,
      // Without a session there is nothing carrying its review, so its own
      // findings have to travel with the reply.
      quotePrior: !resumable, stopToken: cfg.stopToken,
      // Every other agent in the registry, so a verdict that names one gets
      // redacted before it reaches this reviewer.
      others: cfg.agents.map((x) => x.name).filter((n) => n !== a.name),
    });
    if (!text) { console.log(`  ${a.name}: nothing answered yet — skipped`); return; }
    const file = await writeArtifact(dir, `reply.${a.name}.md`, text);
    const answered = thread.filter((f) => f.status !== "open").length;
    console.log(`  ${a.name}: ${answered} verdict(s), ${resumable ? "resumed session" : "fresh run, findings quoted"} → ${file}`);

    if (values["dry-run"]) return;

    await appendEvent(dir, { t: "reply.sent", agent: a.name, sha, resumed: resumable, promptFile: file });
    const spec = { ...a, argv: replyArgv(a, { promptText: text, worktree }).argv };
    const r = await runAgent(spec, {
      worktree, prompt: text, stopToken: cfg.stopToken, onLog: (m) => console.log(`  ${m}`),
    });
    await writeArtifact(dir, `reply.${a.name}.stdout.txt`, r.raw ?? "");
    await appendEvent(dir, {
      t: "reply.answered", agent: a.name, verdict: r.verdict, seconds: r.seconds, report: r.report,
    });
    console.log(`\n${"─".repeat(64)}\n${a.name} answered (${r.seconds}s)\n${"─".repeat(64)}\n${r.report}`);
  }));

  await republish(dir);
}

/** Which run a finding command applies to; unambiguous by default. */
async function resolveRun(slug) {
  const base = runsDir();
  if (slug) return path.join(base, slug);
  const { readdir } = await import("node:fs/promises");
  let dirs = [];
  try {
    dirs = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* handled below */ }
  if (!dirs.length) throw new Error("no runs yet — run `macr review` first");
  if (dirs.length > 1) throw new Error(`several runs; pick one with --run <${dirs.join("|")}>`);
  return path.join(base, dirs[0]);
}

async function republish(dir) {
  const events = await readEvents(dir);
  const seed = events.filter((e) => e.t === "target").at(-1)?.target ?? {};
  await writeRun(dir, foldEvents(events, { target: seed }));
}

/**
 * Every PR under review. With more than one run, `--run <slug>` stops being
 * optional, so there has to be a way to see the slugs that does not require
 * triggering the ambiguity error to find them out.
 */
async function cmdRuns() {
  const { listRuns } = await import("../lib/store.js");
  const { runs, skipped } = await listRuns(runsDir());
  if (!runs.length) { console.log("no runs yet — run `macr review` first"); return; }

  for (const r of runs) {
    const open = (r.exchanges ?? []).filter((f) => f.res === "open").length;
    const total = (r.exchanges ?? []).length;
    const rounds = (r.rounds ?? []).length;
    console.log(
      `${r.slug.padEnd(24)} ${String(r.target?.id ?? "").padEnd(5)} ` +
      `${String(r.target?.state ?? "").padEnd(10)} ${rounds} round(s)  ` +
      `${total} finding(s)${open ? `, ${open} open` : ""}`,
    );
    if (r.target?.title) console.log(`${" ".repeat(24)} ${r.target.title}`);
  }
  // A run that cannot be read is reported, never silently omitted: an absent
  // row otherwise reads as "that PR was never reviewed".
  for (const s of skipped) console.log(`SKIPPED ${s.dir}: ${s.reason}`);
}

async function cmdAgents() {
  const cfg = await loadConfig();
  const found = await Promise.all(cfg.agents.map(probe));
  const roleOf = new Map(cfg.agents.map((a) => [a.name, a.role ?? "reviewer"]));
  for (const p of found) {
    const role = roleOf.get(p.name);
    console.log(
      `${p.ok ? "ok     " : "MISSING"} ${p.name.padEnd(8)} ${role.padEnd(8)} ${p.path ?? p.bin}`,
    );
  }
  const missing = found.filter((p) => !p.ok);
  if (missing.length) {
    console.log(`\n${missing.length} agent(s) not installed. Install them, or disable in macr.config.json.`);
    process.exitCode = 1;
  }
}

async function describe(dir, trunk) {
  const g = async (...args) => (await run("git", ["-C", dir, ...args])).stdout.trim();
  const [sha, branch, subject] = await Promise.all([
    g("rev-parse", "--short", "HEAD"),
    g("rev-parse", "--abbrev-ref", "HEAD").catch(() => "HEAD"),
    g("log", "-1", "--format=%s").catch(() => ""),
  ]);
  let repo = path.basename(dir);
  try {
    const remote = await g("remote", "get-url", "origin");
    repo = remote.replace(/\.git$/, "").split(/[:/]/).slice(-2).join("/");
  } catch { /* no remote is fine */ }
  return { sha, branch, subject, repo, trunk };
}

// Declarations, not const arrows: the dispatch switch above runs at module
// top level, so anything it reaches must be hoisted.
function repoFromUrl(u) {
  return u.match(/\/([^/]+\/[^/]+)\/(?:merge_requests|pull)\//)?.[1] ?? "";
}

function idFromUrl(u) {
  const m = u.match(/\/merge_requests\/(\d+)|\/pull\/(\d+)/);
  return m ? (m[1] ? `!${m[1]}` : `#${m[2]}`) : "";
}

function firstLine(s) {
  return (s ?? "").split("\n").find((l) => l.trim()) ?? "";
}
