// The built-in Kimi Code entry, driven through a stand-in `kimi`. Run with `node --test`.
//
// The stand-in prints exactly what Kimi Code CLI 0.39–0.42 prints in prompt
// mode with --output-format stream-json, so what is under test is Jury's side
// of the contract: the reviewer profile reaches the command line as a real file
// of the installed package, the report is the assistant's words alone, a tool
// result cannot end the loop, the session id is captured, and the reply resumes
// that session without the profile flag Kimi refuses next to --session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL("../bin/jury.js", import.meta.url));
const root = realpathSync(path.dirname(path.dirname(cli)));
const { DEFAULTS, loadConfig, judgeAgent, knownAgents } = await import(pathToFileURL(path.join(root, "lib/config.js")));
const { runAgent, hasStopToken } = await import(pathToFileURL(path.join(root, "lib/agents.js")));
const { replyArgv } = await import(pathToFileURL(path.join(root, "lib/reply.js")));
const { appendEvent, readEvents } = await import(pathToFileURL(path.join(root, "lib/store.js")));

const SESSION = "session_75050fde-14b3-43af-a479-2946f0f11375";
const STOP = "NO NEW FINDINGS";
// Verbatim from kimi 0.39.1 (0.42.0 adds retry notices with role "meta"): a
// version banner, an assistant turn that calls a tool, the tool's result — which
// quotes the prompt's stop-token line — the answer, and the resume hint.
const HINT = `{"role":"meta","type":"session.resume_hint","session_id":"${SESSION}","command":"kimi -r ${SESSION}","content":"To resume this session: kimi -r ${SESSION}"}`;

// The stand-in records how it was called and answers with KIMI_STUB_ANSWER;
// KIMI_STUB_OUTPUT switches it to plain text or to a stream with no answer.
const STUB = `const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--agent-file");
fs.writeFileSync("call.json", JSON.stringify({ cwd: process.cwd(), args,
  profile: at >= 0 ? { path: args[at + 1], exists: fs.existsSync(args[at + 1]) } : null }));
const answer = process.env.KIMI_STUB_ANSWER || ${JSON.stringify(STOP)};
const json = (o) => JSON.stringify(o);
const lines = process.env.KIMI_STUB_OUTPUT === "text" ? ["• " + answer]
  : process.env.KIMI_STUB_OUTPUT === "meta" ? [json({ role: "meta", type: "system.version", version: "0.39.1" })]
  : [
    json({ role: "meta", type: "system.version", version: "0.39.1" }),
    json({ role: "assistant", tool_calls: [{ type: "function", id: "Bash_0_ed8a0b21", function: { name: "Bash", arguments: json({ command: "grep -n 'NO NEW FINDINGS' prompt.md" }) } }] }),
    json({ role: "tool", tool_call_id: "Bash_0_ed8a0b21", content: "40:say exactly \\"NO NEW FINDINGS\\" on its own line\\n" }),
    json({ role: "assistant", content: answer }),
    ${JSON.stringify(HINT)},
  ];
process.stdout.write(lines.join("\\n") + "\\n");
`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "jury-kimi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, "work tree");
  const bin = path.join(dir, "bin");
  await mkdir(worktree); await mkdir(bin);
  const exe = path.join(bin, "kimi");
  await writeFile(exe, `#!${process.execPath}\n${STUB}`, { mode: 0o755 });
  const cfg = await loadConfig(worktree, { globalFile: path.join(dir, "absent") });
  const agent = knownAgents(cfg).find((a) => a.name === "kimi");
  const call = async () => JSON.parse(await readFile(path.join(worktree, "call.json"), "utf8"));
  return { dir, worktree, bin, exe, cfg, agent, call };
}

test("kimi is an opt-in built-in whose review, judge and reply commands differ where they must", async (t) => {
  const { cfg, agent } = await fixture(t);
  assert.ok(agent, "kimi must be a known built-in agent");
  assert.ok(!cfg.agents.some((a) => a.name === "kimi"), "kimi ships opt-in");
  assert.equal(agent.report, "kimi-json");
  assert.equal(agent.cwd, "worktree", "Kimi Code has no --work-dir; it reviews where it is started");
  assert.equal(agent.sandbox, "tools");

  // Prompt mode refuses --plan, --yolo and --auto, so none may appear anywhere.
  const judge = judgeAgent(cfg, "kimi");
  for (const argv of [agent.argv, judge.argv, agent.resume.argv]) {
    assert.equal(argv[0], "kimi");
    assert.ok(argv.includes("-p") && argv.includes("{{promptText}}"));
    assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), ["--output-format", "stream-json"]);
    assert.ok(!argv.some((a) => ["--plan", "--yolo", "--auto", "--continue"].includes(a)), "refused next to -p, or resumes the wrong session");
  }
  // The reviewer is boxed by the shipped profile; the judge writes without it.
  const at = agent.argv.indexOf("--agent-file");
  assert.ok(at > 0);
  assert.equal(agent.argv[at + 1], "{{packageDir}}/lib/agents/kimi-reviewer.md");
  assert.ok(!judge.argv.includes("--agent-file"));
  // A resume names the exact session and, because Kimi refuses the pair, no profile.
  assert.ok(agent.resume.supported);
  assert.deepEqual(agent.resume.argv.slice(-2), ["--session", "{{sessionId}}"]);
  assert.ok(!agent.resume.argv.includes("--agent-file"));
  // The id is read from the trailing meta line Kimi prints on stdout, prefix and all:
  // `kimi --session` wants the same string the hint shows.
  assert.equal(HINT.match(new RegExp(agent.resume.idFrom, "i"))?.[1], SESSION);
});

test("the shipped reviewer profile is in the package and says what it removes", async () => {
  const file = path.join(root, "lib", "agents", "kimi-reviewer.md");
  await access(file);
  const text = (await readFile(file, "utf8")).replace(/\r/g, "");
  const [, front] = text.match(/^---\n([\s\S]*?)\n---\n/) ?? [];
  assert.ok(front, "a frontmatter block is what Kimi reads the tool policy from");
  assert.match(front, /^description: .+/m, "Kimi requires a description");
  assert.match(front, /^name: [a-z0-9-]+$/m, "a non-kebab-case name is skipped with a warning");
  const list = (key) => (front.match(new RegExp(`^${key}:\\n((?:  - .+\\n?)+)`, "m"))?.[1] ?? "").match(/- (.+)/g)?.map((s) => s.slice(2).trim()) ?? [];
  assert.deepEqual(list("disallowedTools").sort(), ["Edit", "Write"]);
  assert.deepEqual(list("subagents"), ["explore"], "the default coder sub-agent can write files");
  assert.match(text, /\$\{base_prompt\}/, "wrap Kimi's default prompt rather than replace it");
});

test("a review is parsed from the JSON stream, its session captured, and its live output decoded", async (t) => {
  const { worktree, exe, cfg, agent, call } = await fixture(t);
  const prompt = 'Read this literally: "quotes"; $(touch unwanted)\nReview only.';
  const chunks = [];
  const review = await runAgent({
    ...agent, argv: [exe, ...agent.argv.slice(1)],
    env: { KIMI_STUB_ANSWER: "FINDING: jitter is deletable\nWHERE: main_test.go:2237\n\nEvery assertion accepts the nominal delay." },
  }, { worktree, prompt, stopToken: STOP, onChunk: (text) => chunks.push(text) });
  assert.equal(review.ok, true, review.report);
  // The tool result quoted the stop token; only the assistant's words count.
  assert.equal(review.verdict, "found");
  assert.equal(hasStopToken(review.report, STOP), false);
  assert.equal(review.findings.length, 1);
  assert.equal(review.findings[0].claim, "jitter is deletable");
  assert.equal(review.sessionId, SESSION, "the id the reply will resume");
  assert.match(review.raw, /system\.version/, "the raw artifact keeps the whole stream");

  let made = await call();
  assert.equal(made.args[0], "-p");
  assert.equal(made.args[1], prompt, "the prompt arrives literally, as one argument");
  assert.deepEqual(made.args.slice(2, 4), ["--output-format", "stream-json"]);
  assert.ok(path.isAbsolute(made.profile.path), "the profile must be an absolute path: the process starts in the worktree");
  assert.equal(made.profile.exists, true, "{{packageDir}} must point at the installed package");
  // Compare real paths on both sides. On macOS the temp root is /var/... while
  // {{packageDir}} resolves through /private/var/..., so the same file reached
  // two ways compares unequal and path.relative answers with a ../../.. chain.
  assert.equal(
    path.relative(await realpath(root), await realpath(made.profile.path)).split(path.sep).join("/"),
    "lib/agents/kimi-reviewer.md");

  // What the console saw while it ran: words and tool calls, no JSON envelope.
  const live = chunks.join("");
  assert.match(live, /» Bash \{"command":"grep -n 'NO NEW FINDINGS' prompt.md"\}/);
  assert.match(live, /FINDING: jitter is deletable/);
  assert.doesNotMatch(live, /"role"|resume_hint|say exactly/);

  // The judge runs the same CLI with every tool: no profile on its command line.
  const judge = judgeAgent(cfg, "kimi");
  const triage = await runAgent({ ...judge, argv: [exe, ...judge.argv.slice(1)] }, { worktree, prompt, stopToken: STOP });
  assert.equal(triage.verdict, "clean");
  made = await call();
  assert.equal(made.profile, null);
  assert.deepEqual(made.args, ["-p", prompt, "--output-format", "stream-json"]);

  // And the reply goes to that exact session, without the profile flag.
  const reply = replyArgv(agent, { promptText: "verdicts", worktree, sha: "abc", sessionId: review.sessionId });
  assert.equal(reply.resumed, true);
  assert.deepEqual(reply.argv, ["kimi", "-p", "verdicts", "--output-format", "stream-json", "--session", SESSION]);
  const fresh = replyArgv(agent, { promptText: "verdicts", worktree, sha: "abc" });
  assert.equal(fresh.resumed, false);
  assert.ok(!fresh.argv.includes("--session"));
});

test("output that is not Kimi's JSON, or has no answer, is an error rather than a report", async (t) => {
  const { worktree, exe, agent } = await fixture(t);
  const invoke = (env) => runAgent({ ...agent, argv: [exe, ...agent.argv.slice(1)], env }, { worktree, prompt: "review", stopToken: STOP });
  // Text mode is what a customised argv without --output-format stream-json
  // produces; its bullet-prefixed stop token must not be mistaken for clean.
  const text = await invoke({ KIMI_STUB_OUTPUT: "text" });
  assert.equal(text.ok, false);
  assert.equal(text.verdict, "error");
  assert.match(text.report, /Invalid Kimi Code JSON output/);
  const silent = await invoke({ KIMI_STUB_OUTPUT: "meta" });
  assert.equal(silent.verdict, "error");
  assert.match(silent.report, /no assistant text/);
});

test("through the CLI: listed opt-in, run when named, and replied to in its recorded session", async (t) => {
  const { dir, worktree, bin, agent, call } = await fixture(t);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const command = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: worktree, env, encoding: "utf8", timeout: 30000 });

  assert.match(command(["agents"]).stdout, /ok\s+kimi\s+reviewer\s+\S+\s+\(opt-in\)/);
  assert.equal(command(["agents", "judge", "kimi"]).status, 0);
  assert.equal(JSON.parse(await readFile(path.join(dir, ".jury/config.json"))).judge, "kimi");
  assert.equal(command(["agents", "judge", "--reset"]).status, 0);

  const git = (args) => execFileSync("git", args, { cwd: worktree, env, stdio: "ignore" });
  git(["init", "-q", "-b", "master"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-qm", "base"]);
  git(["checkout", "-qb", "feature"]);
  // Keep one mock judge and this actual built-in registry entry. Never launch another installed agent.
  await writeFile(path.join(worktree, "jury.config.json"), JSON.stringify({ agents: [
    ...DEFAULTS.agents.filter((a) => a.name !== "kimi").map(({ name }) => ({ name, enabled: false })),
    { name: "fixture-judge", role: "main", argv: [process.execPath, "-e", "console.log('NO NEW FINDINGS')"] },
  ] }));

  const review = command(["review", "--dir", worktree, "--trunk", "master", "--web=false", "--push=false", "--rounds", "1", "--reviewer", "kimi"]);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /REVIEW COMPLETE/);
  let made = await call();
  assert.equal(made.profile.exists, true, "the profile reached a real file from the installed CLI");
  assert.deepEqual(made.args.slice(-4, -2), ["--output-format", "stream-json"]);

  const [slug] = await readdir(path.join(worktree, "runs"));
  const runDir = path.join(worktree, "runs", slug);
  const report = (await readEvents(runDir)).filter((e) => e.t === "agent.report" && e.agent === "kimi").at(-1);
  assert.equal(report.sessionId, SESSION);
  assert.equal(report.verdict, "clean");

  await appendEvent(runDir, { t: "finding.raised", id: "reply-check", round: 1, agent: "kimi", claim: "fixture claim", body: "original finding context" });
  await appendEvent(runDir, { t: "finding.resolved", id: "reply-check", verdict: "rejected", reason: "fixture verdict" });
  const reply = command(["reply", "--dir", worktree, "--run", slug, "--jury", "kimi"]);
  assert.equal(reply.status, 0, reply.stderr);
  made = await call();
  assert.equal(made.args[made.args.indexOf("--session") + 1], SESSION, "the reply resumes the session the review recorded");
  assert.equal(made.profile, null, "Kimi refuses --agent-file next to --session; the session keeps its agent");
  assert.ok(!made.args.some((a) => a.includes("original finding context")), "a resumed session already holds its review");

  const self = command(["review", "--dir", worktree, "--trunk", "master", "--web=false", "--push=false", "--judge", "kimi", "--reviewer", "kimi"]);
  assert.notEqual(self.status, 0);
  assert.match(self.stderr, /selected judge and cannot review its own work/);
});
