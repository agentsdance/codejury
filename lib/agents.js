// Spawning reviewers and reading what they said back.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where Code Jury itself is installed, for files that ship with it.
 *
 * An agent that takes a profile or policy file on its command line needs an
 * absolute path to one — the process starts in the worktree, so a relative
 * path would resolve into the code under review. kimi's read-only reviewer
 * profile in lib/agents/ is reached this way, as {{packageDir}}.
 */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");

function subst(argv, vars) {
  return argv.map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""));
}

/**
 * Run one reviewer against a worktree. Never throws for a failing agent — a
 * dead reviewer is a result, not a crash, and the round should still report the
 * others.
 */
export async function runAgent(agent, { worktree, prompt, stopToken, dryRun, onLog, onChunk, timeoutSeconds }) {
  const started = Date.now();

  if (dryRun) {
    await new Promise((r) => setTimeout(r, 120));
    return {
      agent: agent.name,
      ok: true,
      seconds: 0.1,
      verdict: "clean",
      findings: [],
      report: `${stopToken}\n\n(dry run — ${agent.name} was not executed)`,
      raw: "",
    };
  }

  let promptFile = null;
  let tmp = null;
  if (agent.promptDelivery === "file") {
    tmp = await mkdtemp(path.join(tmpdir(), "jury-"));
    promptFile = path.join(tmp, "prompt.md");
    await writeFile(promptFile, prompt, "utf8");
  }

  // An agent that takes its session id as input gets one generated here, so the
  // reply can name the exact conversation instead of asking for "the last one"
  // and hoping nothing else ran in between.
  const assigned = agent.newSession && agent.argv.some(arg => arg.includes("{{sessionId}}")) ? randomUUID() : null;
  const vars = {
    worktree, promptFile: promptFile ?? "", promptText: prompt,
    sessionId: assigned ?? "", packageDir: PACKAGE_DIR,
  };
  const [cmd, ...args] = subst(agent.argv, vars);
  const cwd = agent.cwd === "worktree" ? worktree : process.cwd();

  // The caller already prints the agent's name at the head of this line, so
  // repeating it here read as "codex: codex (in worktree)".
  onLog?.(`${cmd} (${agent.cwd === "worktree" ? "in worktree" : "via flag"})`);

  const limit = (timeoutSeconds ?? Math.max(600, (agent.expectSeconds ?? 600) * 3)) * 1000;

  const out = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // stdin must be closed, not an open pipe. A pipe that never delivers and
      // never ends leaves an agent waiting on input forever: codex sat at 0% CPU
      // for over an hour before this was fixed.
      child = spawn(cmd, args, { cwd, env: { ...process.env, PWD: cwd, ...agent.env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) });
      return;
    }

    // And a hard stop, so one stuck reviewer cannot hold the whole round.
    const timer = setTimeout(() => {
      onLog?.(`${agent.name}: no result after ${Math.round(limit / 1000)}s — terminating`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
      resolve({ code: -1, stdout, stderr: stderr + `\ntimed out after ${Math.round(limit / 1000)}s`, timedOut: true });
    }, limit);

    // Accumulate for the final parse AND hand each chunk on as it lands. A
    // reviewer that takes twenty minutes is otherwise a black box for all
    // twenty: nothing reaches disk until close, so "still thinking" and
    // "wedged" look identical to anyone watching.
    // A kimi-json agent's live output is JSON lines; the console wants the
    // words inside them, so those are decoded per complete line as they land.
    const speak = onChunk && agent.report === "kimi-json" ? lineDecoder(onChunk) : onChunk;
    child.stdout.on("data", (d) => { stdout += d; speak?.(String(d)); });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err) }); });
    child.on("close", (code) => { clearTimeout(timer); speak?.flush?.(); resolve({ code, stdout, stderr }); });
  });

  if (tmp) await rm(tmp, { recursive: true, force: true });

  const seconds = +((Date.now() - started) / 1000).toFixed(1);
  if (out.code !== 0) {
    return {
      agent: agent.name,
      ok: false,
      seconds,
      verdict: "error",
      findings: [],
      report: [out.stdout.trim(), out.stderr.trim(), `exited ${out.code}`].filter(Boolean).join("\n").slice(-4000),
      raw: out.stdout,
    };
  }

  // A resumable agent that prints a session id gets it captured here. Without
  // it a reply can only say "resume the last session", which is the review only
  // if nothing else ran in the meantime.
  let sessionId = assigned;
  if (!sessionId && agent.resume?.idFrom) {
    try {
      const re = agent.resume.idFrom instanceof RegExp
        ? agent.resume.idFrom
        : new RegExp(agent.resume.idFrom, "i");
      sessionId = out.stdout.match(re)?.[1] ?? null;
    } catch { /* a bad pattern must not fail the review */ }
  }

  let report;
  try {
    report = extractReport(out.stdout, agent.report);
  } catch (error) {
    return { agent: agent.name, ok: false, seconds, verdict: "error", findings: [],
      report: error.message, raw: out.stdout };
  }
  const findings = parseFindings(report);
  // The stop token plus header-formatted findings is a contradiction, and the
  // findings win. This catches only what carries a FINDING header — a reviewer
  // that signs off and then describes a bug in plain prose still reads as
  // clean, because nothing here can tell that prose from a cosmetic note. The
  // triage gate is what covers that; this is not a substitute for reading the
  // report.
  const said = hasStopToken(report, stopToken);
  return {
    agent: agent.name,
    ok: true,
    seconds,
    verdict: said && !findings.length ? "clean" : "found",
    contradicted: said && findings.length > 0,
    findings,
    report,
    sessionId,
    raw: out.stdout,
  };
}

/**
 * A verbose agent prints a transcript that includes the prompt it was given, so
 * the stop token appears in the instruction as well as the answer. Take the tail
 * for those; the whole stream for agents that print only their report.
 */
export function extractReport(stdout, mode = "whole") {
  const text = stdout.replace(/\r/g, "");
  if (mode === "kimi-json") return kimiText(text);
  if (mode === "result-json") {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Invalid agent JSON output"); }
    const result = Array.isArray(data) ? data.at(-1) : data;
    if (result?.type !== "result" || result.subtype !== "success" || result.is_error !== false
      || typeof result.result !== "string" || !result.result.trim()) {
      throw new Error("Agent returned no successful final result");
    }
    return result.result.trim();
  }
  if (mode === "opencode-json") {
    let parts = [];
    let messageId;
    // Any event carrying a message id moves the stream on, not just text. A
    // later message that runs to the token limit without ever emitting text
    // would otherwise leave an earlier message's sign-off standing as the
    // report, and a truncated review would be accepted as clean.
    let finishReason;
    for (const line of text.split("\n").filter(line => line.trim())) {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error("Invalid OpenCode JSON output"); }
      if (event?.type === "error") throw new Error(`OpenCode error: ${JSON.stringify(event.error)}`);
      const id = event?.part?.messageID;
      if (id !== undefined && id !== messageId) { parts = []; messageId = id; finishReason = undefined; }
      if (event?.type === "step_finish") finishReason = event.part?.reason;
      if (event?.type === "text" && typeof event.part?.text === "string") parts.push(event.part.text);
    }
    if (!parts.some(part => part.trim())) throw new Error("OpenCode returned no assistant text");
    // "stop" is a completed turn; anything else (notably "length") means the
    // answer was cut off mid-thought and must not be read as a verdict.
    if (finishReason !== "stop") {
      throw new Error(`OpenCode stopped early: ${finishReason ?? "missing completion"}`);
    }
    return parts.join("\n").trim();
  }
  if (mode !== "tail") return text.trim();
  const lines = text.split("\n");
  // The last agent turn starts at the final bare "codex" marker line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "codex") return lines.slice(i + 1).join("\n").trim();
  }
  return lines.slice(-80).join("\n").trim();
}

/**
 * The assistant's words out of Kimi Code's `--output-format stream-json`.
 *
 * One JSON object per line: assistant messages, the tool calls they made, the
 * tool results, and metadata — the version banner, retry notices, and the
 * session hint at the end. Only the assistant's text is the report: a tool
 * result that happens to print the prompt's "NO NEW FINDINGS" line must not
 * end the loop. A line that is not JSON means the agent was not run in
 * stream-json mode, and a stream with no assistant text is a turn that never
 * answered; both are errors rather than a report to be read.
 */
export function kimiText(text) {
  const said = [];
  for (const line of text.split("\n").filter((l) => l.trim())) {
    const o = parseLine(line);
    if (!o) throw new Error("Invalid Kimi Code JSON output");
    if (o.role !== "assistant") continue;
    const t = contentText(o.content).trim();
    if (t) said.push(t);
  }
  if (!said.length) throw new Error("Kimi Code returned no assistant text");
  return said.join("\n\n");
}

function parseLine(line) {
  if (!line.trim().startsWith("{")) return null;
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** Message content as text, whether it is a string or a list of typed parts. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Live output from a kimi-json agent, as words rather than JSON.
 *
 * Streaming the raw lines to the console shows escaped newlines and tool
 * payloads in place of a reviewer mid-sentence. Each complete line is decoded
 * as it lands: the assistant's text as it is, a tool call as one short line so
 * the console can tell "reading the diff" from "wedged", and tool results and
 * metadata not at all. The raw stream is still kept whole for the artifact and
 * the final parse.
 */
function lineDecoder(onChunk) {
  let pending = "";
  const emit = (line) => {
    const text = spokenLine(line);
    if (text) onChunk(text);
  };
  const decode = (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) emit(line);
  };
  decode.flush = () => {
    if (pending.trim()) emit(pending);
    pending = "";
  };
  return decode;
}

function spokenLine(line) {
  const o = parseLine(line);
  // Not JSON: a warning, or a misconfigured agent. Shown as it is; the final
  // parse is what decides whether that was acceptable.
  if (!o) return line.trim() ? `${line.replace(/\r$/, "")}\n` : "";
  if (o.role !== "assistant") return "";
  const parts = [];
  const text = contentText(o.content).trim();
  if (text) parts.push(text);
  for (const call of Array.isArray(o.tool_calls) ? o.tool_calls : []) {
    const name = call?.function?.name ?? call?.name ?? "tool";
    const args = String(call?.function?.arguments ?? call?.arguments ?? "").replace(/\s+/g, " ");
    parts.push(`» ${name} ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`.trimEnd());
  }
  return parts.length ? `${parts.join("\n")}\n` : "";
}

// Agents write markdown even when asked for plain text, so strip the decoration
// before matching rather than spelling every variant out in the pattern.
// Headings and list numbering count: "### FINDING:" and "1. FINDING:" are both
// ordinary agent formatting.
const bare = (s) => s
  .replace(/\*\*|`/g, "")
  .replace(/^\s*#{1,6}\s+/, "")
  .replace(/^\s*(?:[-*>]\s*)+/, "")
  .replace(/^\s*\d+[.)]\s+/, "")
  .trim();

/**
 * The token must stand on its own line — not merely appear in the prose. It is
 * compared bare, because a reviewer that bolds its output would otherwise never
 * be able to end the loop, at roughly twenty minutes per wasted round.
 */
export function hasStopToken(report, stopToken) {
  return report.split("\n").some((l) => bare(l) === stopToken);
}

/**
 * Which lines are the agent's own words rather than quoted material. The prompt
 * shows the FINDING/WHERE format, so a reviewer that echoes the instructions
 * back — or quotes a diff — would otherwise have the placeholder filed as a
 * real finding, and a clean round would be reported as not converged.
 */
function speaking(lines) {
  let fenced = false;
  const open = lines.map((l) => {
    if (/^\s*(?:```|~~~)/.test(l)) { fenced = !fenced; return false; }
    return !fenced;
  });

  // The prompt shows the header format inside a fence, so agents reasonably
  // answer in the same shape: a fenced block containing only FINDING/WHERE is
  // the reviewer's own finding, not quoted material. Reading it as a quote lost
  // every finding one reviewer raised — five real bugs, none tracked.
  // A fence holding anything else (a diff, an error, sample code) still is not
  // speech, so the protection this rule exists for is unaffected.
  for (let i = 0; i < lines.length; i++) {
    if (open[i] || !/^\s*(?:```|~~~)/.test(lines[i])) continue;
    let j = i + 1;
    const body = [];
    while (j < lines.length && !/^\s*(?:```|~~~)/.test(lines[j])) body.push(j++);
    // A fence that OPENS with FINDING: is the reviewer answering in the shape
    // the prompt showed. Requiring every line to be a header lost the whole
    // finding the moment a reviewer added its explanation inside the same
    // fence — and reviewers do that constantly. A fence starting with anything
    // else (a diff, an error, sample code) is still quoted material.
    // The reviewer is speaking when the fence opens with FINDING: and carries
    // no code. Requiring EVERY line to be a header lost the whole finding as
    // soon as a reviewer put its explanation in the same fence — which they do
    // constantly. Accepting any fence that merely starts with FINDING: went too
    // far the other way and swallowed quoted diffs. Prose after the headers is
    // fine; a diff or code line means it is quoted material.
    const said = body.map((k) => bare(lines[k])).filter(Boolean);
    const code = (l) => /^[+-]\s|^[+-]{1,2}[^-]|[;{}]\s*$|^\s*(?:function|const|let|var|import|def|class)\b/.test(l);
    if (said.length && /^FINDING\s*:/i.test(said[0]) && !said.some(code)) {
      for (const k of body) open[k] = true;
    }
    i = j;
  }
  return open;
}

/**
 * Pull the FINDING/WHERE headers out of a report so each claim can be tracked
 * across rounds. Prose without a header is left alone — the full report is
 * recorded regardless, this only decides what becomes a trackable finding.
 */
export function parseFindings(report) {
  const lines = report.replace(/\r/g, "").split("\n");
  const own = speaking(lines);

  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    if (!own[i]) continue;
    const claim = bare(lines[i]).match(/^FINDING\s*:\s*(.+)$/i);
    // "<the claim, one line>" is the template from the prompt, not a claim. An
    // agent that restates the format it was given must not have the
    // placeholder filed against it as a real finding.
    if (claim && !/^<.*>$/.test(claim[1].trim())) heads.push({ i, claim: claim[1] });
  }

  return heads.map((h, n) => {
    // A finding runs until the next one starts, so nothing below can reach into
    // the following finding's text. When the next header sits inside a fence,
    // that fence's opening line — and any heading introducing it — are already
    // the next finding, so stop there rather than swallowing them.
    let end = n + 1 < heads.length ? heads[n + 1].i : lines.length;
    if (n + 1 < heads.length) {
      let k = end - 1;
      if (k > h.i && /^\s*(?:```|~~~)/.test(lines[k])) k--;        // its opening fence
      while (k > h.i && !lines[k].trim()) k--;                      // blank space before it
      if (k > h.i && /^\s*#{1,6}\s+/.test(lines[k])) k--;           // the heading above it
      end = k + 1;
    }

    let where = -1;
    let loc = "";
    for (let j = h.i + 1; j < end; j++) {
      const w = own[j] ? bare(lines[j]).match(/^WHERE\s*:\s*(.+)$/i) : null;
      if (w) { where = j; loc = w[1]; break; }
    }

    // A claim asked for on one line often wraps onto a second. Whatever sits
    // between the header and the WHERE is the rest of the claim — the
    // explanation comes after the WHERE. More than two lines is prose, not a
    // wrap, so it is left in the body rather than glued into the claim.
    const gap = where > h.i + 1
      ? lines.slice(h.i + 1, where).map(bare).filter(Boolean)
      : [];
    const wrapped = gap.length <= 2 ? gap : [];

    let bodyFrom = where >= 0 && wrapped.length === gap.length ? where + 1 : h.i + 1;
    // When the header pair was fenced, the fence that closes it is not prose.
    if (bodyFrom < end && /^\s*(?:```|~~~)\s*$/.test(lines[bodyFrom])) bodyFrom++;
    const body = lines.slice(bodyFrom, end).join("\n").replace(/^\s*[-—]{3,}\s*$/gm, "").trim();
    return { claim: [h.claim, ...wrapped].join(" "), loc, body };
  });
}

export async function probe(agent) {
  const bin = agent.argv?.[0];
  // An agent with no argv is in-process — the session driving the loop, not
  // something spawned. There is no binary to look for, and reporting it missing
  // would fail `jury agents` for an agent that is by definition present.
  if (!bin) return { name: agent.name, bin: "", path: "(in-process)", ok: true, inProcess: true };
  // No shell: passing args through one is both a deprecation warning and an
  // injection surface, and the agent name comes from a config file.
  const lookup = process.platform === "win32" ? "where" : "which";
  const found = await new Promise((resolve) => {
    const c = spawn(lookup, [bin]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => resolve(code === 0 ? out.trim().split("\n")[0] : null));
    c.on("error", () => resolve(null));
  });
  return { name: agent.name, bin, path: found, ok: Boolean(found) };
}
