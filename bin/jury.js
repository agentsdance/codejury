#!/usr/bin/env node
// jury — review a pull request with multiple independent AI reviewers.
//
// The CLI owns the mechanics: worktrees, spawning agents, capturing what they
// said, recording it, serving the console. It deliberately does NOT triage —
// deciding whether a finding reproduces is the calling agent's job, and roughly
// a third of suggestions do not survive that step.
import { commandHelp } from "../lib/help.js";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { prepareGroup, groupContext, groupHead, reviewUrls, groupId, groupReady, pushRetained, findingPr, assertGroupCheckout } from "../lib/review-group.js";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { automaticRoles, automaticReviewers } from "../lib/roles.js";
import { loadConfig, reviewers, judgeAgent, knownAgents, readGlobalConfig, saveGlobalJudge, saveGlobalReviewers, defaultReviewers, savedReviewersNote, globalConfigPath } from "../lib/config.js";
import { runAgent, probe } from "../lib/agents.js";
import { threadFor, buildReply, replyArgv } from "../lib/reply.js";
import { buildPrompt } from "../lib/prompt.js";
import { serve } from "../lib/server.js";
import { appendEvent, writeRun, readEvents, foldEvents, slugFor, attemptStamp, runsDir, writeArtifact, openArtifact } from "../lib/store.js";
import { findingsIn, gate, settledList, VERDICTS } from "../lib/findings.js";
import { MAX_TURNS, turnsFor, outstanding, deadlocked, refreshSettled, replyRound, record, sessionsIn, judgeSessionIn, openFindings, currentJudge } from "../lib/loop.js";
import { triageOne } from "../lib/triage.js";
import { assertPrCheckout, repositoryFromPrUrl, resolvePrCheckout } from "../lib/repository.js";
import { resolveJuryDirectory } from "../lib/directories.js";
import * as st from "../lib/style.js";
import { parseReviewArgs, reviewerOptions, requestedReviewers } from "../lib/cli-options.js";
import { pick } from "../lib/picker.js";
import { startReviewConsole } from "../lib/review-console.js";

const run = promisify(execFile);
// Read from the manifest rather than restated here, where it drifted: the CLI
// reported 0.1.0 while package.json said something else.
const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

// Set when `review --web` boots the console in-process. Read once, after the
// loop returns, to decide whether the process may exit.
let liveConsole = null;
let resolvedCheckoutCleanup = null;

/**
 * What a person types, and nothing else.
 *
 * The full reference lists eight commands and thirty flags, most of which exist
 * for the skill driving triage rather than for anyone at a prompt. Showing all
 * of it by default buried the one command that matters in a wall of options —
 * `jury help --all` still prints everything.
 */
const USAGE = `jury — review a pull request with multiple AI reviewers until they agree

  jury review <pr-url>       review a pull request
  jury <pr-url>              shorthand for jury review
  jury review <pr-1> <pr-2>
  jury <pr-url> --rounds 3   review a pull request for up to 3 rounds
  jury <pr-url> --web=false  review without the browser console

Common flags

  --dir <path>               working/state root                                   (default: Git cwd or ~/.jury)
  --rounds <n>               stop after n rounds                                  (default: 10)
  --reviewer <name>          only these reviewers, repeatable or comma-separated  (default: configured or saved reviewers)
  --jury <name>              same as --reviewer
  --judge codex              one agent that triages and fixes                     (default: configured, auto for 1–2 installed CLIs, then codex)
  --push <true|false>        commit and push fixes                                (default: true)
  --web <true|false>         open the browser console                             (default: true)

Other commands

  jury agents                which reviewers are installed
  jury agents judge <agent>  set the global default judge
  jury agents jury <agents>  set the default reviewers
  jury runs                  every PR under review
  jury version

  jury help --all            every command and flag
`;

const USAGE_FULL = `jury — review a pull request with multiple AI reviewers until they agree

  jury review <pr-url>       review a PR until every reviewer approves, one conversation per reviewer
  jury finding <cmd>         list | reproduce | resolve | settled — appends events, enforces the gate
  jury reply [flags]         send each reviewer your verdicts on ITS findings, one conversation each
  jury runs                  list every PR under review, with its slug for --run
  jury agents                check which configured agents are installed
  jury agents judge <agent>  set the global default judge
  jury agents jury <agents>  set the default reviewers (picker in a terminal)
  jury version

Related PRs: jury review <pr-url-1> <pr-url-2>
Every reviewer assesses all supplied PRs together, with separate checkouts.
Each PR uses its own base branch; omit --trunk for related PRs.

review                           (triages, fixes, commits, and pushes automatically)
  jury https://github.com/owner/repo/pull/1
  jury <pr-url> --rounds 3   review a pull request for up to 3 rounds

  --dir <path>               working/state root                                    (default: Git cwd or ~/.jury)
  --pr <url>                 same as the positional argument
  --trunk <branch>           diff base branch                                      (default: the remote's own HEAD)
  --title <text>             what the change does                                  (default: read from the PR)
  --summary <text>           intent, passed to reviewers                           (default: the PR description)
  --rounds <n>               maximum rounds                                        (default: 10)
  --reviewer <name>          only these reviewers, repeatable or comma-separated   (default: configured or saved reviewers)
  --jury <name>              same as --reviewer
  --judge <agent>            one agent that triages and fixes                      (default: configured, auto for 1–2 installed CLIs, then codex)
  --resume <slug>            continue an existing run instead of starting a new one
  --web <true|false>         open the console; stays up after review               (default: true)
  --web-only                 view saved reviews without running agents
  --run <slug>               select a saved run with --web-only
  --port <n>                 console port                                          (default: 3080)
  --push <true|false>        commit and push fixes                                 (default: true)


console only
  jury --web-only [--dir <path>] [--run <slug>] [--port <n>]
Open saved reviews without starting agents. The server stays up until ctrl-c.

finding commands                     (--dir picks state root; --run picks run)
  jury finding list
  jury finding reproduce <id> --evidence <text> [--test <text>]
  jury finding resolve <id> --verdict <${VERDICTS.join("|")}> [--reason <text>] [--test <text>]
  jury finding settled       print the regenerated settled list

With a PR URL, the default working/state root is ~/.jury.

Use --push=false (or --push false) to disable pushing; --push enables it.

reply flags
  --reviewer <name>          only these reviewers, repeatable or comma-separated
  --jury <name>              same as --reviewer

state commands
  jury runs [--dir <path>]
  jury reply [--dir <path>] [--run <slug>]
`;

let [, , cmd, ...rest] = process.argv;

// Reviewing is the only thing this tool does; `jury review <url>` on a program
// named for multi-agent code review is a tautology. A bare URL — or a bare
// flag, with the target implied by the working directory — means review.
// Nothing else here takes a URL, so there is nothing to disambiguate.
if (cmd && (/^https?:\/\//.test(cmd) || cmd.startsWith("-")) && cmd !== "-h" && cmd !== "--help"
    && cmd !== "-v" && cmd !== "--version") {
  rest = [cmd, ...rest];
  cmd = "review";
}

if (rest[0] === "--help" || rest[0] === "-h") {
  rest = [cmd];
  cmd = "help";
}

try {
  switch (cmd) {
    // `agent` collided with both --agents and `jury agents`, three different
    // things reading the same. Reviewing is what this tool does, so `review` is
    // the loop; the old single-round behaviour is --rounds 1, which it already
    // supported. `agent` stays as a hidden alias.
    case "review": case "agent":
      await cmdAgent(rest);
      await cleanupResolvedCheckout();
      // The loop is done; the console it started is not. Exiting here would
      // close the page at the exact moment there is a finished run to read.
      if (liveConsole) {
        console.log(`\nconsole still up at ${liveConsole} — ctrl-c to stop`);
        await new Promise(() => {});
      }
      break;
    case "finding": case "findings": await cmdFinding(rest); break;
    case "reply": await cmdReply(rest); break;
    case "runs": await cmdRuns(rest); break;
    case "agents": await cmdAgents(rest); break;
    case "version": case "-v": case "--version": console.log(`jury ${VERSION}`); break;
    case "help": case "-h": case "--help": case undefined:
      if (!rest.length) process.stdout.write(USAGE);
      else if (rest.length === 1 && ["--all", "-a", "all"].includes(rest[0])) process.stdout.write(USAGE_FULL);
      else {
        const help = rest.length === 1 ? commandHelp(rest[0], USAGE_FULL) : null;
        if (!help) {
          console.error(`jury: unknown help topic "${rest.join(" ")}"`);
          process.stdout.write(USAGE);
          process.exit(2);
        }
        process.stdout.write(help);
      }
      break;
    default:
      console.error(`jury: unknown command "${cmd}"\n`);
      process.stdout.write(USAGE);
      process.exit(2);
  }
} catch (err) {
  await cleanupResolvedCheckout();
  console.error(`jury: ${err.message}`);
  process.exit(1);
}

/** Resolve an explicit reviewer list or explain each ineligible name. */
function selectReviewers(cfg, requested, judge = null) {
  if (!requested) return defaultReviewers(cfg, judge);
  const eligible = reviewers(cfg).filter((a) => a.name !== judge);

  const names = requested;
  if (!names.length) throw new Error("--reviewer needs at least one reviewer name");

  // Naming a reviewer explicitly reaches every known agent, including built-ins
  // that ship opt-in. Requiring a config edit before `--reviewer qwen` could
  // work would make "supported" and "enabled by default" the same thing, and
  // enabling every supported CLI by default would demand all of them be
  // installed before any review could start.
  const byName = new Map(knownAgents(cfg).map((a) => [a.name, a]));
  const allowed = new Set(eligible.map((a) => a.name));
  const optIn = knownAgents(cfg)
    .filter((a) => a.enabled === false && (a.role ?? "reviewer") === "reviewer" && a.name !== judge);
  for (const agent of optIn) allowed.add(agent.name);

  const problems = names.filter((name) => !allowed.has(name)).map((name) => {
    const agent = byName.get(name);
    if (name === judge) return `"${name}" is the selected judge and cannot review its own work`;
    if (agent) return `"${name}" has role "${agent.role ?? "reviewer"}", not "reviewer"`;
    return `"${name}" is not configured or is disabled`;
  });
  if (problems.length) {
    const available = [...eligible.map((a) => a.name), ...optIn.map((a) => a.name)].join(", ") || "none";
    throw new Error(
      `requested reviewer ${problems.join("; ")}. Add or enable it with role "reviewer" in ${path.basename(cfg.configFile)}. Available reviewers: ${available}`,
    );
  }
  // Selected agents come from the known set so an opt-in built-in named here
  // actually runs, rather than silently reducing the pool to nothing.
  return names.map((name) => byName.get(name)).filter(Boolean);
}

async function commandDirectory(value) {
  return resolveJuryDirectory(value, {
    isUsable: async (dir) => {
      try {
        await run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** One round: prompt, launch every reviewer, record what they said. */
async function runRound({ dir, round, pool, cfg, target, worktree, values, sha, announceCompletion = true }) {
  const git = { sha };
  console.log(st.info(st.bold(`round ${round}`)));

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

      // Stream to the artifact as the reviewer talks, rather than only once it
      // exits. Without this a twenty-minute agent is a black box for all twenty
      // minutes and "still thinking" is indistinguishable from "wedged".
      const rawName = `round-${round}.${a.name}.stdout.txt`;
      const sink = await openArtifact(dir, rawName);
      // Not every agent streams. codex writes nothing until it exits — an
      // 8.9-second run produced one 7-byte chunk at 8.5s — because it
      // block-buffers when it is piped rather than attached to a terminal. For
      // those, an empty column for nine minutes is indistinguishable from a
      // wedged process, so a heartbeat says what is knowable: it is alive, and
      // how long it has been going. A streaming agent never needs one.
      const heartStart = Date.now();
      let lastSpoke = 0;
      const heart = setInterval(() => {
        // Silence is what needs reporting, not never-having-spoken. Suppressing
        // the beat permanently once an agent streamed left a gap with no signal
        // at all: grok streamed for three minutes, went quiet for four while
        // waiting on the model, and the console could not tell that from
        // wedged. Resume after 15s of nothing.
        if (lastSpoke && Date.now() - lastSpoke < 15000) return;
        appendEvent(dir, {
          t: "agent.alive", agent: a.name, round,
          seconds: Math.round((Date.now() - heartStart) / 1000),
          // So the console can say "quiet for 2m" rather than implying it never
          // said anything.
          quietSeconds: lastSpoke ? Math.round((Date.now() - lastSpoke) / 1000) : null,
        }).catch(() => {});
      }, 5000);

      // Chunks reach the console through the event log as well as the
      // artifact. Batched: an agent emits stdout a few bytes at a time, and one
      // event per write would bloat the log by orders of magnitude for no gain
      // a reader could perceive.
      let buf = "";
      let flushing = null;
      // Appends are chained rather than fired independently. Clearing `flushing`
      // before awaiting let a second flush start while the first append was
      // still in flight, so a later chunk — or the final report — could reach
      // the log ahead of earlier output, leaving the conversation with a
      // permanent "streaming" turn full of stale text.
      let writes = Promise.resolve();
      const flush = () => {
        flushing = null;
        if (!buf) return writes;
        const text = buf;
        buf = "";
        writes = writes.then(() =>
          appendEvent(dir, { t: "agent.chunk", agent: a.name, round, text }),
        );
        return writes;
      };
      let r;
      try {
        r = await runAgent(a, {
          worktree, prompt, stopToken: cfg.stopToken,
          dryRun: values["dry-run"],
          onLog: (m) => console.log(`  ${st.agent(a.name)} ${st.muted(m)}`),
          onChunk: (text) => {
            lastSpoke = Date.now();
            sink.write(text);
            buf += text;
            if (!flushing) flushing = setTimeout(flush, 700);
          },
        });
      } finally {
        // In finally, not merely after the await: runAgent can throw, and a
        // leaked interval keeps appending heartbeats for a round that is over.
        // Rounds then interleave in the log, and the console grows a bubble per
        // beat rather than one per round — 81 of them for a nine-minute round.
        clearInterval(heart);
      }
      if (flushing) clearTimeout(flushing);
      // Await the chain, not just this flush: an append queued earlier must
      // land before agent.report is written after it.
      await flush();
      await writes;
      // Rewritten whole at the end: the streamed copy can be short if the agent
      // was killed mid-write, and r.raw is the authoritative buffer.
      await sink.close();
      const rawFile = await writeArtifact(dir, rawName, r.raw ?? "");
      await appendEvent(dir, {
        t: "agent.report", agent: a.name, round,
        verdict: r.verdict, seconds: r.seconds, summary: firstLine(r.report), report: r.report,
        // The session this review happened in, so the reply resumes THIS
        // conversation rather than whichever ran most recently.
        sessionId: r.sessionId ?? null,
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
          agent: a.name, claim: f.claim, loc: f.loc, body: f.body, pr: findingPr(f.loc, target.targets),
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
  const state = errored.length ? "human" : clean && announceCompletion ? "converged" : "review";
  const stateNote = errored.length
    ? `${errored.length} reviewer(s) failed to run`
    : clean
      ? announceCompletion ? "Review complete" : `round ${round} clean — checking outstanding findings`
      : `round ${round} — ${raised || "unparsed"} finding(s) to triage`;
  const reviewedCommit = clean && !errored.length && announceCompletion ? git.sha : "";
  await appendEvent(dir, {
    t: "target",
    target: { ...target, state, stateNote, ...(reviewedCommit ? { reviewedCommit } : {}) },
  });
  await appendEvent(dir, { t: "round.end", n: round });
  await publish();

  // Once, not three times. The elapsed time, the per-reviewer table and the
  // verdict each used to restate the round's result in their own words.
  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${st.rule(`round ${round} · ${took}s`)}\n`);
  for (const r of results) {
    const paint = r.verdict === "clean" ? st.ok : r.verdict === "error" ? st.bad : st.warn;
    const mark = r.verdict === "clean" ? "clean" : r.verdict === "error" ? "failed" : "findings";
    const n = r.findings?.length ? st.muted(`  ${st.count(r.findings.length, "finding")}`) : "";
    console.log(`  ${st.agent(r.agent.padEnd(8))} ${st.muted(String(r.seconds).padStart(5) + "s")}  ${paint(mark)}${n}`);
  }

  console.log("");
  if (errored.length) {
    console.log(st.bad(`${st.count(errored.length, "reviewer")} failed to run — see the reports below.`));
  }
  console.log(clean && !errored.length
    ? announceCompletion
      ? `${st.ok("REVIEW COMPLETE — every reviewer approved.")}\n${st.muted(`Reviewed commit ${git.sha}.`)}`
      : `${st.ok("ROUND CLEAN — every reviewer approved this commit.")}\n${st.muted(`Reviewed commit ${git.sha}.`)}`
    : st.warn(`REVIEW INCOMPLETE — triage findings, fix what reproduces, push, then run round ${round + 1}.`));
  console.log(st.muted(`recorded: ${path.relative(process.cwd(), dir)}`));

  // Every reviewer's report, including the clean ones: a sign-off still says
  // what was checked, and reading only the complaints hides that. Indented and
  // ruled at both ends, because otherwise a report runs straight into whatever
  // the loop prints next and the two read as one voice.
  for (const r of results) {
    const head = `${r.agent}${r.verdict === "clean" ? " · clean" : ""}`;
    console.log(`\n${st.rule(head)}`);
    console.log(st.indent(r.report ?? ""));
    console.log(st.rule(""));
  }

  // A failed reviewer is not convergence. Stopping the loop here would report
  // agreement that one of the reviewers never actually expressed.
  return { clean: clean && !errored.length, failed: errored.map(r => r.agent) };
}

/**
 * The autonomous loop.
 *
 * `review --max-rounds n` was never a loop: it re-read HEAD each round assuming
 * an operator had fixed and pushed in between, and when nobody did, it reviewed
 * the same commit n times. This command fills that seat — triage, fix, commit,
 * reply, repeat — so the run converges or exhausts its rounds on its own.
 *
 * Three things make it terminate rather than argue forever:
 *   the settled list   regenerated every round, so a deferred finding is not
 *                      re-raised by the next reviewer that reads the diff
 *   the turn limit     MAX_TURNS exchanges per claim, then it is set down as
 *                      deferred with both positions in the log
 *   the round cap      --rounds, default 10
 */
async function cmdAgent(argv) {
  if (argv.includes("--web-only")) return cmdConsole(argv);
  const judgeFlags = argv.filter((a) => a === "--judge" || a.startsWith("--judge="));
  if (judgeFlags.length > 1) throw new Error("--judge accepts exactly one agent");
  const { values, positionals } = parseReviewArgs(argv, {
    dir: { type: "string" },
    pr: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    trunk: { type: "string" },
    rounds: { type: "string", default: "10" },
    ...reviewerOptions,
    judge: { type: "string" },
    push: { type: "boolean", default: true },
    resume: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    port: { type: "string", default: "3080" },
  });
  if (values.judge?.includes(",")) throw new Error("--judge accepts exactly one agent, not a list");

  // The PR link is the argument. `--pr` still works, but a flag for the one
  // thing every invocation names is ceremony: `jury agent <url>` is what
  // someone reaches for, and refusing it teaches nothing.
  const urls = reviewUrls(positionals, values.pr);
  values.pr = urls[0];

  const maxRounds = Number(values.rounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error("--rounds must be a positive integer");
  }

  const requestedWorktree = await commandDirectory(values.pr ? (values.dir ?? "") : values.dir);
  // Two different questions, and conflating them cost the local path entirely.
  // `root` is where the isolated checkout and run records are written; `dir` is
  // the repository to resolve the request FROM. A caller sitting in the very
  // repository under review already has its commits, and asking them for the
  // one ref the host may have pruned — rather than reading what is on disk —
  // is what issue #30 was.
  const resolveFrom = values.dir ? path.resolve(values.dir) : process.cwd();
  const priorTargets = values.resume
    ? [...await readEvents(path.join(runsDir(requestedWorktree), path.basename(values.resume)))].reverse()
      .find(e => e.t === "target")?.target : null;
  if (priorTargets?.targets && urls.length < 2) throw new Error("resuming a related-PR task requires all original PR URLs");
  if (urls.length > 1 && values.resume && !priorTargets?.targets) throw new Error("no related-PR task found to resume");
  if (priorTargets?.targets && !argv.some(a => a === "--push" || a.startsWith("--push="))) {
    values.push = priorTargets.pushEnabled ?? false;
  }
  const group = urls.length > 1 ? await prepareGroup(urls, {
    root: requestedWorktree, dir: resolveFrom, allowPush: values.push, trunk: values.trunk, previous: priorTargets,
  }) : null;
  if (group) resolvedCheckoutCleanup = group.cleanup;
  const resolved = !group && values.pr
    ? await resolvePrCheckout(values.pr, {
      allowPush: values.push, root: requestedWorktree, dir: resolveFrom,
    })
    : null;
  const worktree = group?.worktree ?? resolved?.worktree ?? requestedWorktree;
  if (!group) resolvedCheckoutCleanup = resolved?.cleanup ?? null;

  // A local ignored config belongs to the requested checkout. An automatic
  // clone intentionally starts from the repository's committed/default config.
  const cfg = await loadConfig(group ? group.targets[0].worktree : resolved ? worktree : requestedWorktree);
  const git = await describe(group ? group.targets[0].worktree : worktree);

  // Both asked for rather than assumed: the trunk from the remote's own HEAD,
  // the title and intent from the PR itself. Every one of these was a flag you
  // had to get right, and getting the trunk wrong is silent — the diff is taken
  // against a branch that does not exist.
  const trunkGiven = Boolean(values.trunk);
  const trunk = values.trunk ?? group?.targets[0].trunk ?? resolved?.trunk ?? (await defaultTrunk(worktree));
  values.trunk = trunk;
  const pr = group ? { title: group.targets.map(t => t.title || t.url).join(" + "), summary: "" } : resolved ?? await prDetails(values.pr, worktree);

  // The next round has to review NEW code or it is not a loop, so pushing is
  // the default. It still refuses trunk outright: a loop that can push to
  // master is one bad triage away from a bad afternoon.
  const pushTarget = values.push
    ? resolved?.pushTarget ?? { remote: "origin", branch: git.branch }
    : null;
  if (values.push && !group) {
    if (!git.branch || git.branch === "HEAD") {
      throw new Error("--push needs a checked-out branch; this worktree is detached");
    }
    if (!resolved && git.branch === values.trunk) {
      throw new Error(`refusing --push onto ${values.trunk}: that is the trunk, not a PR branch`);
    }
  }

  const target = {
    repo: values.pr ? repoFromUrl(values.pr) : git.repo,
    id: values.pr ? idFromUrl(values.pr) : git.branch,
    url: values.pr ?? "",
    // An explicit flag still wins; the PR is only consulted when you did not say.
    title: values.title ?? pr.title ?? git.subject,
    branch: resolved?.branch ?? git.branch,
    trunk,
    state: "review",
    stateNote: "",
  };
  if (group) Object.assign(target, {
    targets: group.targets, workspace: group.worktree, pushEnabled: values.push, repo: "related-prs",
    reviewedCommit: null, reviewedCommits: null,
    id: groupId(urls), url: "", branch: "", summary: values.summary ?? "",
  });
  values.summary = values.summary ?? pr.summary ?? "";

  // Each invocation is its own run unless you explicitly resume one. Appending
  // to whatever ran before meant three separate reviews of the same PR merged
  // into rounds 1-5 of a single run, and a killed run's open rounds interleaved
  // with the next one's.
  target.attempt = values.resume ? "" : group ? `${attemptStamp()}-${path.basename(group.worktree)}` : attemptStamp();
  const stateBase = runsDir(requestedWorktree);
  const dir = values.resume
    ? path.join(stateBase, path.basename(values.resume))
    : path.join(stateBase, slugFor(target));
  const prior = await readEvents(dir);
  if (values.resume && !prior.length) {
    throw new Error(
      `no run at ${dir} — pass --dir <root-that-contains-runs>, then check \`jury runs --dir <root>\``,
    );
  }
  const priorTarget = [...prior].reverse().find(e => e.t === "target")?.target;
  const priorJudge = priorTarget?.judge;
  const roles = await automaticRoles(cfg, {
    judge: values.judge, reviewers: requestedReviewers(values),
    previous: values.resume ? priorTarget : null,
  });
  const requestedJudge = values.judge ?? (values.resume ? priorJudge : null);
  const judge = judgeAgent(cfg, roles?.judge ?? requestedJudge);
  if (!judge) {
    const available = cfg.agents.map((a) => a.name).join(", ") || "none";
    if (requestedJudge) {
      throw new Error(`judge "${requestedJudge}" is not an enabled configured agent — available: ${available}`);
    }
    throw new Error('no enabled default judge — check jury agents judge and repository roles, or pass --judge <agent>');
  }
  if (!values["dry-run"]) {
    const installed = await probe(judge);
    if (!installed.ok) throw new Error(`judge "${judge.name}" is not installed (${installed.bin}); install it or select --judge <agent>`);
  }
  target.judge = judge.name;
  if (roles) target.automaticRoles = roles;

  // Only the automatic one-CLI assignment permits self-review. Explicit
  // selection keeps configured main agents out of the reviewer pool.
  const pool = roles ? automaticReviewers(cfg, roles)
    : selectReviewers(cfg, requestedReviewers(values), judge.name);
  if (!pool.length) throw new Error("no reviewers configured after excluding the judge");
  if (!values["dry-run"]) {
    const checks = await Promise.all(pool.map(probe));
    const missing = checks.filter(a => !a.ok);
    if (missing.length) {
      const reason = `reviewers not installed: ${missing.map(a => `${a.name} (${a.bin})`).join(", ")}`;
      await publishRun(dir, { ...target, state: "human", stateNote: reason });
      const fromSaved = !roles && !requestedReviewers(values) && cfg.savedReviewers;
      throw new Error(fromSaved
        ? `${reason}, from the ${savedReviewersNote}. Install them, save installed reviewers, or select reviewers with --reviewer <name>. No agents were started.`
        : `${reason}. Install them, disable them in jury.config.json, or select installed reviewers with --reviewer <name>. No agents were started.`);
    }
  }
  const first = Math.max(0, ...prior.filter((e) => e.t === "round.start").map((e) => e.n)) + 1;
  // Keep one judge conversation for every finding and every round. The event
  // makes a resumed process pick up the same provider session after a crash.
  let judgeSessionId = judgeSessionIn(prior, judge.name);

  if (roles && !values.resume) {
    const names = knownAgents(cfg).filter(a => a.name === roles.judge || roles.reviewers.includes(a.name)).map(a => a.name);
    console.log(`Found ${names.length} code agent${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`);
    console.log(names.length === 1
      ? `${judge.name} will work as both judge and jury.`
      : `${judge.name} will work as judge, and ${pool[0].name} will work as jury.`);
  }
  console.log(st.field("target", `${target.repo} ${st.bold(target.id)}`));
  console.log(st.field("worktree", st.muted(group ? worktree : `${worktree} @ ${git.sha} (${resolved?.branch ?? git.branch})`)));
  if (group) for (const t of group.targets) console.log(st.field(t.key, `${t.url} @ ${t.sha} (${t.branch} → ${t.trunk})`));
  console.log(st.field("trunk", `${trunk}${trunkGiven ? st.muted("  (detected)") : ""}`));
  if (target.title) console.log(st.field("title", target.title.slice(0, 72)));
  console.log(st.field("judge", st.agent(judge.name)));
  console.log(st.field("juries", pool.map((a) => st.agent(a.name)).join(", ")
    + (values["dry-run"] ? st.warn("  (dry run)") : "")));
  console.log(st.field("rounds", st.muted(`${first}..${first + maxRounds - 1}, ${MAX_TURNS} turns per finding`)));
  console.log(st.field("fixes", st.muted(values.push
    ? `committed and pushed to ${group ? group.targets.map(t => t.branch).join(", ") : pushTarget.branch}` : "committed to the worktree only")));
  console.log(st.field("run", st.muted(path.basename(dir) + (values.resume ? "  (resumed)" : ""))));
  // The console, in this same process. The loop and the server share the run
  // directory and nothing else: the server re-reads it per request and tails
  // the event log, so it sees each round land without the loop telling it.
  if (values.web) {
    liveConsole = await startReviewConsole({
      dir, target, cwd: requestedWorktree, port: Number(values.port),
      onLog: (m) => console.log(st.field("console", st.muted(m))),
    });
    console.log(st.field("console", `${liveConsole}${st.muted("  →  the conversation streams live")}`));
    openBrowser(liveConsole);
    console.log("");
  }

  if (group && values.resume && values.push && !values["dry-run"]) {
    try {
      await pushRetained(group.targets, member => appendEvent(dir, {
        t: "commit.pushed", pr: member.key, sha: member.sha, pushed: true,
        subject: "published retained review fixes", who: judge.name,
      }));
    } catch (error) {
      await publishRun(dir, { ...target, state: "human", stateNote: "could not publish retained fixes" });
      throw error;
    }
  }
  let pushFailed = false;
  for (let i = 0; i < maxRounds; i++) {
    const round = first + i;

    // Before the round, not after: buildPrompt reads settled.md, so a list
    // written afterwards would first take effect one round too late.
    await refreshSettled(dir);

    const head = group ? await groupHead(group.targets) : await describe(worktree, values.trunk);
    const result = await runRound({
      dir, round, pool, cfg, target, worktree, values, sha: head.sha,
      // A clean round is not necessarily a complete review: an earlier finding
      // can still be open. This loop announces completion only after checking.
      announceCompletion: false,
    });
    if (result.failed.length) {
      const reason = `reviewers failed: ${result.failed.join(", ")}`;
      await publishRun(dir, { ...target, state: "human", stateNote: reason });
      console.error(`Review stopped: ${reason}. Check the saved reports and agent authentication/quota, then resume with --resume ${path.basename(dir)} and the same target and --dir arguments.`);
      process.exitCode = 1;
      return;
    }
    if (result.clean) {
      // Clean is not enough on its own. A finding left open by the previous
      // round — triage failed, the gate refused the verdict, or a reply raised
      // it after the last triage had already run — is invisible to this round's
      // reviewers, because settled.md lists only what has a verdict. They can
      // all sign off in good faith while it sits unanswered. Fall through and
      // triage it; the round-end check below is the one that may declare
      // convergence.
      const open = await openFindings(dir);
      const pending = group ? await groupReady(group.targets, values.push) : null;
      if (pending || pushFailed) {
        const reason = pending ?? "a push failed";
        console.log(st.warn(`\nReview incomplete: ${reason}.`));
        await publishRun(dir, { ...target, state: "human", stateNote: reason });
        return;
      }
      if (!open.length) {
        console.log(st.ok(`\nREVIEW COMPLETE after ${st.count(round - first + 1, "round")}.`));
        console.log(st.muted(`Reviewed commit ${head.sha}.`));
        await publishRun(dir, {
          ...target, state: "converged", stateNote: "Review complete", reviewedCommit: head.sha, ...(group ? { reviewedCommits: head.commits } : {}),
        });
        return;
      }
      console.log(st.warn(`\nevery reviewer is clean, but ${st.count(open.length, "finding")} from earlier ${open.length === 1 ? "is" : "are"} still open.`));
    }

    let findings = await findingsIn(dir);
    const events = await readEvents(dir);
    const todo = outstanding(findings, events);

    // Nothing to answer and nobody signed off: the reviewers produced prose
    // this parser could not track. Another identical round will not fix that.
    if (!todo.length) {
      console.log(st.warn("\nno trackable findings to triage — stopping rather than repeating the round."));
      await publishRun(dir, {
        ...target, state: "human", stateNote: "findings raised but none parsed as trackable",
      });
      return;
    }

    console.log(`\n${st.rule(`triage · ${st.count(todo.length, "finding")} → ${judge.name}`)}`);
    let fixed = 0;
    for (const f of todo) {
      if (group && !findingPr(f.loc, group.targets)) {
        console.log(st.warn(`Finding ${f.id} needs a PR-qualified location (PR1/path:line); left open.`));
        continue;
      }
      // The turn limit ends an argument the loop cannot win. Both positions are
      // already recorded; deferring is not agreeing, and it is not fixing
      // something nobody demonstrated either.
      if (deadlocked(events, f.id)) {
        const r = await record(dir, findings, f.id, {
          verdict: "deferred",
          reason: `argued ${MAX_TURNS} turns without agreement; both positions are in the log`,
          who: judge.name,
        });
        console.log(`  ${st.muted(f.id)}  ${st.verdict("deferred")} ${st.muted(`(turn limit)${r.ok ? "" : ` — ${r.why}`}`)}`);
        continue;
      }

      console.log(`  ${st.muted(f.id)}  ${st.agent(f.agent)}  ${f.claim.slice(0, 62)}${f.claim.length > 62 ? "…" : ""}`);

      // One finding at a time, deliberately. Judging them concurrently would
      // have several agents editing the same tree at once, and the second fix
      // would land on top of the first without having seen it.
      // Tagged with the reviewer whose finding this is: threads are per
      // reviewer, and a heartbeat filed under "claude" opened a claude thread
      // of its own, splitting one conversation in two.
      const heart = beat(dir, judge.name, round, f.agent);
      let v;
      try {
        v = await triageOne(judge, f, {
          worktree, trunk, context: group ? groupContext(group.targets) : "", stopToken: cfg.stopToken, dryRun: values["dry-run"],
          sessionId: judgeSessionId,
          onLog: (m) => console.log(`          ${st.muted(m)}`),
        });
      } finally {
        clearInterval(heart);
      }

      if (v.sessionId && v.sessionId !== judgeSessionId) {
        judgeSessionId = v.sessionId;
        await appendEvent(dir, { t: "judge.session", agent: judge.name, sessionId: judgeSessionId, round });
      }

      if (!v.verdict) {
        // Left open on purpose: an unjudged finding must be raised again rather
        // than silently disappearing into a round that reports convergence.
        console.log(`          ${st.bad(v.failed ? "main agent failed" : "no verdict parsed")}${st.muted(" — left open")}`);
        continue;
      }

      // The reproduction is recorded before the verdict, because gate() reads
      // the folded log: an acceptance is checked against what is already on
      // disk, not against what this function happens to know.
      if (v.reproduced) {
        await appendEvent(dir, {
          t: "finding.reproduced", id: f.id, evidence: v.reproduced, test: v.test ?? null,
          who: judge.name,
        });
      }
      // Refold BEFORE recording, not after. gate() checks the finding it is
      // handed, and the map was folded before the reproduction above was
      // appended — so every accepted finding was refused for having no
      // reproduction, moments after one was written for it. The comment above
      // described the right order; the code did not implement it.
      findings = await findingsIn(dir);
      const res = await record(dir, findings, f.id, {
        verdict: v.verdict, reason: v.reason, test: v.test, who: judge.name,
      });
      if (!res.ok) {
        // The gate refusing is the gate working. Downgrade rather than crash:
        // an acceptance with nothing behind it becomes an open finding again.
        console.log(`          ${st.bad("refused")}${st.muted(`: ${res.why} — left open`)}`);
        continue;
      }
      console.log(`          ${st.verdict(v.verdict)}${v.reason ? st.muted(` — ${v.reason.slice(0, 60)}`) : ""}`);
      if (v.verdict === "accepted") fixed++;
    }

    if (fixed && !values["dry-run"]) {
      for (const member of group?.targets ?? [{ worktree, pushTarget }]) {
        if (group) await assertGroupCheckout(member);
        const c = await commitFixes(member.worktree, round, values.push ? member.pushTarget : null);
        if (c?.sha) {
          await appendEvent(dir, {
            t: "commit.pushed", pr: member.key, sha: c.sha, pushed: c.pushed, subject: `round ${round} fixes`,
            who: judge.name,
          });
          console.log(`commit   ${c.sha}${
            c.pushed === null ? "" : c.pushed ? ` → pushed to ${member.pushTarget.branch}` : "  (NOT pushed)"}`);
          // A run whose fixes never reached the branch cannot converge: the
          // reviewers would be signing off on code the PR does not contain.
          if (c.pushed === false) pushFailed = true;
          if (group && c.pushed === true) member.publishedSha = (await run("git", ["rev-parse", "HEAD"], { cwd: member.worktree })).stdout.trim();
        }
      }
    }

    // Every finding answered gets a reply, including the rejections — that is
    // the conversation, and it is what a reviewer needs in order to either
    // concede or push back.
    const after = await findingsIn(dir);
    const finalHead = group ? await groupHead(group.targets) : await describe(worktree, values.trunk);
    const answers = await replyRound({
      dir, pool, cfg, worktree, sha: finalHead.sha, context: group ? groupContext(group.targets) : "", targets: group?.targets, round, findings: after, judge: judge.name,
      sessions: sessionsIn(await readEvents(dir)),
      dryRun: values["dry-run"],
      // Prefixed like the launch line: without a name this printed a bare
      // "node (in worktree)" with nothing saying whose reply it was.
      onLog: (m, who) => console.log(`  ${who ? st.agent(who) + " " : ""}${st.muted(m)}`),
    });
    for (const a of answers) {
      const what = a.failed
        ? "COULD NOT RUN — not counted as agreement"
        : a.skipped
          ? "nothing to answer"
          : a.raised
            ? `raised ${a.raised} new finding(s)`
            : a.clean ? "signed off" : "still disagrees";
      console.log(`${st.dim("reply")}    ${st.agent(a.agent.padEnd(8))} ${a.failed ? st.bad(what) : a.clean ? st.ok(what) : st.warn(what)}`);
    }

    // Convergence is three things, and the first one was missing: every
    // reviewer signed off, no reviewer failed to run, AND nothing is still
    // open. Without the last, a round that raised findings nobody triaged
    // reported success — every thread had nothing to answer, "nothing to
    // answer" counted as clean, and the run exited having addressed none of it.
    const settled = await findingsIn(dir);
    const stillOpen = [...settled.values()].filter((f) => f.status === "open");
    const broke = answers.filter((a) => a.failed);
    const pending = group ? await groupReady(group.targets, values.push) : null;
    if (pending) console.log(st.warn(`Review incomplete: ${pending}.`));
    if (answers.every((a) => a.clean) && !stillOpen.length && !broke.length && !pushFailed && !pending && !(group && fixed)) {
      console.log(st.ok(st.bold(`\nREVIEW COMPLETE — every reviewer approved after round ${round}.`)));
      console.log(st.muted(`Reviewed commit ${finalHead.sha}.`));
      await publishRun(dir, {
        ...target, state: "converged", stateNote: "Review complete", reviewedCommit: finalHead.sha, ...(group ? { reviewedCommits: finalHead.commits } : {}),
      });
      return;
    }
    if (stillOpen.length) {
      console.log(st.warn(`\n${st.count(stillOpen.length, "finding")} still open — review incomplete.`));
    }
    if (broke.length) {
      const reason = `reviewer replies failed: ${broke.map(a => a.agent).join(", ")}`;
      await publishRun(dir, { ...target, state: "human", stateNote: reason });
      console.error(`Review stopped: ${reason}. Check authentication/quota and saved reports, then resume with --resume ${path.basename(dir)} and the same target and --dir arguments.`);
      process.exitCode = 1;
      return;
    }
    if (pushFailed) {
      console.log(st.bad("a push failed — the reviewers are reading code the PR does not have."));
    }
  }

  console.log(st.warn(`\nstopped at the ${maxRounds}-round limit without full agreement.`));
  await publishRun(dir, { ...target, state: "human", stateNote: `hit the ${maxRounds}-round limit` });
}

/**
 * A heartbeat for the main agent while it triages.
 *
 * Triage is the longest single step in a round — read, reproduce, fix, run the
 * suite — and without this the console shows nothing between the last report
 * and the reply, which is when the interesting work happens.
 */
function beat(dir, agent, round, forAgent = null) {
  const started = Date.now();
  return setInterval(() => {
    appendEvent(dir, {
      t: "agent.alive", agent, round, forAgent,
      seconds: Math.round((Date.now() - started) / 1000),
    }).catch(() => {});
  }, 5000);
}

/**
 * Append a target state AND fold it into run.json.
 *
 * The console reads run.json, not the event log, so a terminal state that was
 * only appended left the page asserting a review was still running after the
 * loop had already converged or given up.
 */
async function publishRun(dir, target) {
  await appendEvent(dir, { t: "target", target });
  await writeRun(dir, foldEvents(await readEvents(dir), { target }));
}

/**
 * Commit whatever the main agent changed, and push only when asked.
 *
 * Fast-forward only and never forced: this loop appends to someone's branch, it
 * does not rewrite what is already there. A rejected push is reported, not
 * retried harder.
 */
async function commitFixes(worktree, round, pushTarget) {
  const status = await run("git", ["status", "--porcelain"], { cwd: worktree });
  if (!status.stdout.trim()) return null;
  await run("git", ["add", "-A"], { cwd: worktree });
  await run("git", ["commit", "-m", `fix: round ${round} review findings`], { cwd: worktree });
  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: worktree });
  const sha = stdout.trim();
  let pushed = false;
  if (pushTarget) {
    try {
      await run("git", ["push", pushTarget.remote, `HEAD:refs/heads/${pushTarget.branch}`], { cwd: worktree });
      pushed = true;
    } catch (err) {
      // Swallowing this reported a local commit as pushed, so later rounds
      // reviewed code the PR never received — and could sign off on it.
      console.error(`push FAILED (${err.message.split("\n")[0]}) — the commit is local only`);
    }
  }
  return { sha, pushed: pushTarget ? pushed : null };
}

async function cleanupResolvedCheckout() {
  const cleanup = resolvedCheckoutCleanup;
  resolvedCheckoutCleanup = null;
  if (cleanup) await cleanup();
}

async function cmdConsole(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: {
      dir: { type: "string" },
      port: { type: "string", default: "3080" },
      "web-only": { type: "boolean" },
      run: { type: "string" },
    },
  });
  const root = await commandDirectory(values.dir);
  if (values.run && !(await readEvents(path.join(runsDir(root), path.basename(values.run)))).length) {
    throw new Error(`no recorded run "${values.run}"`);
  }
  const { url } = await serve({ port: Number(values.port), cwd: root });
  const selected = new URL(url);
  if (values.run) selected.searchParams.set("run", path.basename(values.run));
  console.log(`console: ${selected}`);
  console.log(`runs:    ${runsDir(root)}/`);
  openBrowser(String(selected));
  process.on("SIGINT", () => { console.log("\nstopped"); process.exit(0); });
  return new Promise(() => {}); // serve until interrupted
}

// Best effort, and deliberately unawaited: no browser (a CI box, a bare ssh
// session) is not a reason to fail a review that is otherwise about to run.
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {});
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
      dir: { type: "string" },
      evidence: { type: "string" },
      test: { type: "string" },
      verdict: { type: "string" },
      reason: { type: "string" },
    },
  });

  const root = await commandDirectory(values.dir);
  const dir = await resolveRun(values.run, root);
  const events = await readEvents(dir);
  const judge = currentJudge(events);
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
      if (!id) throw new Error("usage: jury finding reproduce <id> --evidence <text>");
      if (!findings.has(id)) throw new Error(`no such finding: ${id}`);
      if (!values.evidence) throw new Error("--evidence is required: what demonstrated the finding");
      await appendEvent(dir, {
        t: "finding.reproduced", id, evidence: values.evidence, test: values.test, who: judge,
      });
      await republish(dir);
      console.log(`${id}: reproduction recorded`);
      return;
    }

    case "resolve": {
      if (!id) throw new Error(`usage: jury finding resolve <id> --verdict <${VERDICTS.join("|")}>`);
      const why = gate(findings.get(id), { verdict: values.verdict, test: values.test });
      // Refused, not merely warned: this is the half of the discipline that
      // survives the operator deciding to skip it.
      if (why) throw new Error(`refused: ${why}`);
      await appendEvent(dir, {
        t: "finding.resolved", id, verdict: values.verdict, reason: values.reason ?? "", test: values.test, who: judge,
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
      dir: { type: "string" },
      ...reviewerOptions,
      "dry-run": { type: "boolean", default: false },
    },
  });

  const worktree = await commandDirectory(values.dir);
  const cfg = await loadConfig(worktree);
  const dir = await resolveRun(values.run, worktree);
  const events = await readEvents(dir);
  const judge = currentJudge(events);
  const findings = await findingsIn(dir);
  const { sha } = await describe(worktree, "master");

  const roles = [...events].reverse().find(e => e.t === "target")?.target?.automaticRoles;
  let pool = roles ? automaticReviewers(cfg, roles, requestedReviewers(values))
    : selectReviewers(cfg, requestedReviewers(values), judge);
  // Only reviewers that actually said something, and only once you have
  // answered them: a reply that says "still open" for every item is noise.
  pool = pool.filter((a) => {
    const t = threadFor(a.name, findings);
    return t.length && t.some((f) => f.status !== "open");
  });
  if (!pool.length) throw new Error("nothing to reply about — resolve some findings first");

  console.log(`judge    ${judge}`);
  console.log(`replying ${pool.map((a) => a.name).join(", ")}  (separate conversations)`);
  console.log("");

  await Promise.all(pool.map(async (a) => {
    const thread = threadFor(a.name, findings);
    const sessionId = sessionsIn(events).get(a.name);
    const resumable = replyArgv(a, { sessionId }).resumed;
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

    await appendEvent(dir, { t: "reply.sent", agent: a.name, sha, resumed: resumable, sessionId, promptFile: file, who: judge });
    const spec = { ...a, argv: replyArgv(a, { promptText: text, worktree, sessionId }).argv };
    const replyRaw = `reply.${a.name}.stdout.txt`;
    const sink = await openArtifact(dir, replyRaw);
    const r = await runAgent(spec, {
      worktree, prompt: text, stopToken: cfg.stopToken, onLog: (m) => console.log(`  ${m}`),
      onChunk: (chunk) => sink.write(chunk),
    });
    await sink.close();
    await writeArtifact(dir, replyRaw, r.raw ?? "");
    await appendEvent(dir, {
      t: "reply.answered", agent: a.name, verdict: r.verdict, seconds: r.seconds, report: r.report,
    });
    console.log(`\n${"─".repeat(64)}\n${a.name} answered (${r.seconds}s)\n${"─".repeat(64)}\n${r.report}`);
  }));

  await republish(dir);
}

/** Which run a finding command applies to; unambiguous by default. */
async function resolveRun(slug, root = process.cwd()) {
  const base = runsDir(root);
  if (slug) return path.join(base, slug);
  const { readdir } = await import("node:fs/promises");
  let dirs = [];
  try {
    dirs = (await readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* handled below */ }
  if (!dirs.length) throw new Error("no runs yet — run `jury review` first");
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
async function cmdRuns(argv) {
  const { values } = parseArgs({
    args: argv, allowPositionals: false,
    options: { dir: { type: "string" } },
  });
  const root = await commandDirectory(values.dir);
  const { listRuns } = await import("../lib/store.js");
  const { runs, skipped } = await listRuns(runsDir(root));
  if (!runs.length) {
    // Report the unreadable ones even when nothing succeeded: "no runs yet"
    // over a directory full of broken runs is a lie that reads as "nothing was
    // ever reviewed".
    for (const s of skipped) console.log(`SKIPPED ${s.dir}: ${s.reason}`);
    console.log(skipped.length ? "no readable runs" : "no runs yet — run `jury review` first");
    return;
  }

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

async function cmdAgents(args = []) {
  if (["jury", "reviewer", "reviewers"].includes(args[0])) return cmdDefaultReviewers(args.slice(1));
  if (args.length) {
    if (args[0] !== "judge" || args.length > 2) throw new Error("Usage: jury agents judge [<agent>|--reset] | jury agents jury [<agent>,...|--reset]");
    const name = args[1];
    if (name === "--help" || name === "-h") {
      process.stdout.write(commandHelp("agents", USAGE_FULL));
      return;
    }
    if (name === "--reset") {
      await saveGlobalJudge(null);
      console.log("Global judge reset; repository settings or the built-in Codex default apply.");
    } else if (name) {
      const cfg = await loadConfig();
      // The whole known set, so an opt-in built-in can be saved as the default
      // judge without first being enabled in whichever repository happens to be
      // the working directory right now.
      if (!knownAgents(cfg).some(a => a.name === name)) {
        throw new Error(`Unknown or disabled judge "${name}". Choose: ${knownAgents(cfg).map(a => a.name).join(", ")}`);
      }
      await saveGlobalJudge(name);
      console.log(`Global judge: ${name} (${globalConfigPath()})`);
      console.log("Repository main roles and --judge override this default.");
    } else {
      const settings = await readGlobalConfig();
      console.log(`Global judge: ${settings.judge ?? "not set (built-in default: codex)"}`);
    }
    return;
  }
  const cfg = await loadConfig();
  const saved = new Set(cfg.savedReviewers ?? []);
  // Every known agent is listed, not just the default pool: an opt-in built-in
  // that is never shown is an agent nobody discovers. They are marked so the
  // listing still says which ones actually run without being asked for.
  const all = knownAgents(cfg);
  const found = await Promise.all(all.map(probe));
  const roleOf = new Map(all.map((a) => [a.name, a.role ?? "reviewer"]));
  const byName = new Map(all.map((a) => [a.name, a]));
  for (const p of found) {
    const role = roleOf.get(p.name);
    console.log(
      `${p.ok ? "ok     " : "MISSING"} ${p.name.padEnd(9)} ${role.padEnd(8)} ${p.path ?? p.bin}`
      + (byName.get(p.name)?.enabled === false ? "  (opt-in)" : "")
      + (saved.has(p.name) ? "  (default reviewer)" : ""),
    );
  }
  if (cfg.savedReviewers) {
    console.log(`\nDefault reviewers: ${cfg.savedReviewers.join(", ")} (saved in ${globalConfigPath()}; change with jury agents jury)`);
  } else if (cfg.globalReviewers) {
    console.log(`\nSaved default reviewers (${cfg.globalReviewers.join(", ")}) are overridden by reviewer roles in ${path.basename(cfg.configFile)}.`);
  }

  // An agent with no read-only mode still reviews, but only the prompt is
  // keeping it from editing the worktree. That is a real difference in what a
  // run guarantees, so it is said out loud rather than left in the flags.
  const unsandboxed = found
    .filter((p) => p.ok && roleOf.get(p.name) !== "main" && byName.get(p.name)?.sandbox === "none");
  if (unsandboxed.length) {
    console.log("\nReviewers with no read-only mode — the review prompt is the only thing withholding writes:");
    for (const p of unsandboxed) {
      console.log(`  ! ${p.name.padEnd(9)} ${byName.get(p.name).sandboxNote}`);
    }
  }

  if (found.some((p) => byName.get(p.name)?.enabled === false)) {
    console.log(`\nOpt-in agents are not used unless named with --reviewer/--jury, or enabled in ${path.basename(cfg.configFile)}.`);
  }
  // Only the default pool decides the exit status. An opt-in agent nobody asked
  // for is not a broken install, and failing on it would make `jury agents`
  // red on every machine that has not installed every supported CLI.
  // With saved default reviewers, those are the pool; the judge still counts.
  const inPool = (p) => cfg.savedReviewers
    ? saved.has(p.name) || roleOf.get(p.name) === "main"
    : byName.get(p.name)?.enabled !== false;
  const missing = found.filter((p) => !p.ok && inPool(p));
  if (missing.length) {
    console.log(`\n${missing.length} agent(s) not installed. Install them, or disable in jury.config.json.`);
    for (const p of missing) {
      const how = byName.get(p.name)?.install;
      if (how) console.log(`  ${p.name.padEnd(9)} ${how}`);
    }
    process.exitCode = 1;
  }
}

/**
 * `jury agents jury`: the saved default reviewers, used when a run names none.
 *
 * Mirrors `jury agents judge`. With no arguments on a TTY it opens a checkbox
 * picker; anywhere else it prints the current setting, so a script piping
 * `jury agents jury` never blocks waiting for keys.
 */
async function cmdDefaultReviewers(args) {
  const usage = "Usage: jury agents jury [<agent>[,<agent>...]|--reset]";
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(commandHelp("agents", USAGE_FULL));
    return;
  }
  if (args.includes("--reset")) {
    if (args.length > 1) throw new Error(usage);
    await saveGlobalReviewers(null);
    console.log("Default reviewers reset; repository roles or the built-in reviewer pool apply.");
    return;
  }
  if (args.some(a => a.startsWith("-"))) throw new Error(usage);
  const cfg = await loadConfig();
  const known = knownAgents(cfg);
  const names = [...new Set(args.flatMap(a => a.split(",")).map(n => n.trim()).filter(Boolean))];
  if (args.length && !names.length) throw new Error(usage);

  if (!names.length && !(process.stdin.isTTY && process.stdout.isTTY)) {
    const settings = await readGlobalConfig();
    console.log(`Default reviewers: ${settings.reviewers?.join(", ") ?? "not set (built-in reviewer pool)"}`);
    if (settings.reviewers && !cfg.savedReviewers) {
      console.log(`Overridden here by reviewer roles in ${path.basename(cfg.configFile)}.`);
    }
    return;
  }

  let chosen = names;
  if (!chosen.length) {
    const judge = judgeAgent(cfg)?.name;
    const found = await Promise.all(known.map(probe));
    const items = known.map((a, i) => ({
      name: a.name,
      status: found[i].ok ? "ok" : "MISSING",
      notes: [
        ...(a.enabled === false ? ["opt-in"] : []),
        ...(a.name === judge ? ["judge — excluded"] : []),
      ],
    }));
    const current = cfg.globalReviewers ?? defaultReviewers(cfg, judge).map(a => a.name);
    chosen = await pick(items, current, { title: "Default reviewers" });
    if (!chosen) {
      console.log("Cancelled; default reviewers unchanged.");
      return;
    }
  }

  // The whole known set, so an opt-in built-in can be a default reviewer
  // without first being enabled in whichever repository is the cwd right now.
  const unknown = chosen.filter(n => !known.some(a => a.name === n));
  if (unknown.length) {
    throw new Error(`Unknown or disabled reviewer ${unknown.map(n => `"${n}"`).join(", ")}. Choose: ${known.map(a => a.name).join(", ")}`);
  }
  await saveGlobalReviewers(chosen);
  console.log(`Default reviewers: ${chosen.join(", ")} (${globalConfigPath()})`);
  const judge = judgeAgent(cfg)?.name;
  if (chosen.includes(judge)) console.log(`${judge} is the current judge and is left out of runs it judges.`);
  console.log("Repository reviewer roles and --reviewer/--jury override this default.");
}

/**
 * The repository's default branch, asked of the remote rather than assumed.
 *
 * "master" was a guess that is wrong on most repositories made in the last few
 * years, and getting it wrong is not a visible failure: the diff is taken
 * against a branch that does not exist, so reviewers read the wrong change.
 * The remote's own HEAD is the authority; a repo with no remote falls back to
 * whichever local branch exists.
 */
async function defaultTrunk(dir) {
  const g = async (...a) => (await run("git", ["-C", dir, ...a])).stdout.trim();
  try {
    // origin/HEAD -> origin/main
    const ref = await g("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    const name = ref.replace(/^origin\//, "");
    if (name) return name;
  } catch { /* not set locally; ask the remote */ }
  try {
    const out = await g("ls-remote", "--symref", "origin", "HEAD");
    const m = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    if (m) return m[1];
  } catch { /* offline or no remote */ }
  for (const name of ["main", "master"]) {
    try {
      await g("rev-parse", "--verify", `refs/heads/${name}`);
      return name;
    } catch { /* try the next */ }
  }
  return "master";
}

/**
 * The PR's own title and body, asked of GitHub rather than retyped.
 *
 * These reach the reviewers: the summary is what tells them what the change is
 * for, and a reviewer given "(no summary supplied — read the diff)" reviews
 * mechanics without intent. Retyping it on the command line is both work and a
 * chance to describe something other than what the PR says. Best-effort: no gh,
 * no auth, or a URL that is not a PR all fall back silently.
 */
async function prDetails(url, dir) {
  if (!url) return {};
  try {
    const { stdout } = await run("gh", ["pr", "view", url, "--json", "title,body"], { cwd: dir });
    const { title, body } = JSON.parse(stdout);
    return {
      title: title || undefined,
      // A PR body can be enormous; reviewers need the intent, not the checklist.
      summary: body ? body.replace(/\r/g, "").trim().slice(0, 4000) : undefined,
    };
  } catch {
    return {};
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
  let remote = "";
  try {
    remote = await g("remote", "get-url", "origin");
    repo = remote.replace(/\.git$/, "").split(/[:/]/).slice(-2).join("/");
  } catch { /* no remote is fine */ }
  return { sha, branch, subject, repo, remote, trunk };
}

// Declarations, not const arrows: the dispatch switch above runs at module
// top level, so anything it reaches must be hoisted.
function repoFromUrl(u) {
  return repositoryFromPrUrl(u)?.path ?? "";
}

function idFromUrl(u) {
  const m = u.match(/\/merge_requests\/(\d+)|\/pull\/(\d+)/);
  return m ? (m[1] ? `!${m[1]}` : `#${m[2]}`) : "";
}

function firstLine(s) {
  return (s ?? "").split("\n").find((l) => l.trim()) ?? "";
}
