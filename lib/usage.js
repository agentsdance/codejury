// Provider-reported tokens only. Snapshots replace earlier snapshots from the
// same invocation; retrying or resuming creates a new invocation, not a reset.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const sum = values => values.some(n => n !== null) ? values.reduce((a, n) => a + (n ?? 0), 0) : null;
const fields = ["input", "output", "total", "cacheRead", "cacheWrite"];
const active = new Set();
export function interruptUsage() { for (const finish of [...active]) finish(); }

function tokens(u, { separateCache = false, separateThinking = false } = {}) {
  const cacheRead = count(u.cached_input_tokens ?? u.cache_read_input_tokens);
  const cacheWrite = count(u.cache_write_input_tokens ?? u.cache_creation_input_tokens);
  const rawInput = count(u.input_tokens);
  let output = count(u.output_tokens);
  const input = rawInput === null ? null : rawInput + (separateCache ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
  // Qwen reports candidate output separately from its total, which can also
  // include thinking. Preserve the total and include that difference in output.
  const reportedTotal = separateThinking ? count(u.total_tokens) : null;
  if (reportedTotal !== null && input !== null && output !== null && reportedTotal >= input + output) {
    output = reportedTotal - input;
  }
  return { input, output, total: reportedTotal ?? (input !== null && output !== null ? input + output : null),
    cacheRead, cacheWrite };
}

function modelIdentity(agent, model) {
  return typeof model === "string" && model.trim()
    ? { model, modelSource: "reported" }
    : { model: agent.model ?? null, modelSource: agent.model ? "configured" : "unavailable" };
}

/** Only decode known protocol envelopes, never usage quoted in tool/prose text. */
export function usageDecoder(agent, onUpdate = () => {}, previousSessions = new Map()) {
  const records = new Map();
  const sessions = new Map(previousSessions), baselines = new Map();
  let pending = "", document = "", turn = 0, model = null, sessionId = null;
  const streaming = ["codex-json", "opencode-json"].includes(agent.report);
  const snapshot = () => [...records.values()];
  function put(key, usage, reportedModel = model, details = {}) {
    if (!fields.some(f => usage[f] !== null) && !details.cumulative) return;
    records.set(key, { ...modelIdentity(agent, reportedModel), ...usage, ...details });
    onUpdate(snapshot());
  }
  function event(e) {
    if (!e || typeof e !== "object") return;
    if (agent.report === "result-json" && e.type === "system" && typeof e.model === "string") model = e.model;
    if (agent.report === "codex-json") {
      if (e.type === "turn.started") turn++;
      if (e.type === "thread.started") {
        if (typeof e.model === "string") model = e.model;
        if (typeof e.thread_id === "string" && e.thread_id.trim()) sessionId = e.thread_id;
      }
      if (["turn.completed", "turn.failed"].includes(e.type) && e.usage) {
        // Codex reports thread totals, including usage restored on resume.
        // Keep a fixed baseline for each turn so duplicate snapshots replace
        // its delta rather than subtracting that turn's own earlier snapshot.
        const key = JSON.stringify([sessionId, turn]), cumulative = tokens(e.usage);
        if (!baselines.has(key)) baselines.set(key, sessions.get(sessionId));
        const previous = baselines.get(key);
        const usage = Object.fromEntries(fields.map(f => [f, !previous ? cumulative[f]
          : cumulative[f] === null || previous[f] == null ? null : count(cumulative[f] - previous[f])]));
        usage.total = usage.input !== null && usage.output !== null ? usage.input + usage.output : null;
        sessions.set(sessionId, cumulative);
        put(key, usage, e.model ?? model, sessionId ? { sessionId, cumulative } : {});
      }
    } else if (agent.report === "opencode-json" && e.type === "step_finish" && e.part?.tokens) {
      const u = e.part.tokens;
      // OpenCode separates reasoning from output and cache tokens from input.
      put(e.part.id ?? e.part.messageID ?? `step-${records.size}`, tokens({
        input_tokens: u.input, output_tokens: count(u.output) === null ? null : u.output + (count(u.reasoning) ?? 0),
        cache_read_input_tokens: u.cache?.read, cache_creation_input_tokens: u.cache?.write,
      }, { separateCache: true }), e.model ?? e.part.modelID);
    } else if (agent.report === "result-json" && e.type === "result") {
      // Droid/Qwen result usage covers this invocation, unlike Claude's
      // session-cumulative modelUsage map. Do not sum both representations.
      const models = agent.name === "qwen" ? Object.entries(e.stats?.models ?? {}) : [];
      if (models.length) {
        // Qwen's usage aggregates these model counters. Replace the whole
        // result so a prior aggregate or model snapshot is not counted again.
        records.clear();
        for (const [name, stats] of models) {
          const u = stats?.tokens ?? {};
          put(name, tokens({ input_tokens: u.prompt, output_tokens: u.candidates,
            total_tokens: u.total, cache_read_input_tokens: u.cached,
          }, { separateThinking: true }), name);
        }
      } else if (["droid", "qwen"].includes(agent.name) && e.usage) {
        if (agent.name === "qwen") records.clear();
        put("result", tokens(e.usage, {
          separateCache: agent.name === "droid", separateThinking: agent.name === "qwen",
        }), e.model ?? model);
      }
    }
  }
  const parse = text => { try { event(JSON.parse(text)); } catch { /* partial/non-protocol output */ } };
  return {
    feed(text) {
      if (!streaming) { document += text; return; }
      pending += text;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      }
    },
    finish() {
      if (streaming) { if (pending.trim()) parse(pending); pending = ""; }
      else {
        try {
          const parsed = JSON.parse(document);
          for (const e of Array.isArray(parsed) ? parsed : [parsed]) event(e);
        } catch { for (const line of document.split("\n")) parse(line); }
        document = "";
      }
      return snapshot();
    },
    snapshot,
  };
}

// Read durable baselines so separate CLI processes (and interrupted runs) can
// resume a thread without charging its earlier usage again.
function previousSessionUsage(dir) {
  const sessions = new Map(), snapshots = new Map();
  if (!dir) return sessions;
  let raw;
  try { raw = readFileSync(path.join(dir, "events.ndjson"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return sessions; throw error; }
  for (const line of raw.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; } // tolerate torn log lines
    if (e?.t !== "usage.snapshot") continue;
    // Even a running snapshot may be all that survived a forced kill. Until
    // this resumed invocation reports usage, later totals span an unknown gap.
    if (e.resumedSessionId && !(e.records ?? []).some(r => r.sessionId === e.resumedSessionId && r.cumulative)) {
      sessions.set(e.resumedSessionId, Object.fromEntries(fields.map(f => [f, null])));
    }
    // Finishing an invocation repeats its records with a new status. A late
    // finish must not replace usage already reported by a newer invocation.
    if (e.id) {
      const records = JSON.stringify(e.records ?? []);
      if (snapshots.get(e.id) === records) continue;
      snapshots.set(e.id, records);
    }
    for (const r of e.records ?? []) if (r.sessionId && r.cumulative) sessions.set(r.sessionId, r.cumulative);
  }
  return sessions;
}

/** Synchronous appends preserve received usage even during process shutdown. */
export function trackUsage(agent, context, onLog, resumedSessionId = null) {
  const id = randomUUID();
  let status = "running", records = [], finished = false;
  const base = { id, agent: agent.name, ...modelIdentity(agent),
    action: context?.action ?? "review", round: context?.round ?? null,
    ...(agent.report === "codex-json" && resumedSessionId ? { resumedSessionId } : {}),
    ...(context?.replyId ? { replyId: context.replyId } : {}),
    ...(context?.findingId ? { findingId: context.findingId } : {}) };
  const emit = () => {
    if (!context?.dir) return;
    mkdirSync(context.dir, { recursive: true });
    appendFileSync(path.join(context.dir, "events.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), t: "usage.snapshot", ...base, status, records,
    }) + "\n");
  };
  const previous = agent.report === "codex-json" ? previousSessionUsage(context?.dir) : new Map();
  // A restored thread can predate usage tracking, or its earlier invocation
  // may have died before reporting usage. Its cumulative total cannot tell us
  // the current invocation's cost. Retain the new baseline for the next turn.
  if (resumedSessionId && !previous.has(resumedSessionId)) {
    previous.set(resumedSessionId, Object.fromEntries(fields.map(f => [f, null])));
  }
  const decoder = usageDecoder(agent, next => { records = next; emit(); }, previous);
  const interrupted = () => finish("interrupted");
  function finish(next) {
    if (finished) return;
    decoder.finish();
    finished = true;
    status = next;
    emit();
    active.delete(interrupted);
    if (!active.size) process.off("exit", interruptUsage);
    if (next !== "interrupted") onLog?.(`tokens · ${formatUsage(summarizeUsage([{ ...base, status, records }]))}`);
  }
  emit();
  if (!active.size) process.once("exit", interruptUsage);
  active.add(interrupted);
  return { feed: text => decoder.feed(text), finish };
}

function totalOf(rows, partial = false) {
  const result = Object.fromEntries(fields.map(f => [f, sum(rows.map(r => count(r[f])))]));
  return { ...result, partial: partial || !rows.length || rows.some(r => r.input == null || r.output == null) };
}

export function summarizeUsage(invocations) {
  const expanded = invocations.flatMap(i => (i.records?.length ? i.records : [{
    ...modelIdentity(i, i.modelSource === "reported" ? i.model : null),
    ...Object.fromEntries(fields.map(f => [f, null])),
  }]).map(r => ({ ...r, agent: i.agent, action: i.action, round: i.round,
    partial: i.status !== "completed" || !i.records?.length })));
  const aggregate = rows => totalOf(rows, rows.some(r => r.partial));
  const groups = (key, identity) => {
    const buckets = new Map();
    for (const r of expanded) {
      const k = key(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    return [...buckets.values()].map(rows => ({ ...identity(rows[0]), ...aggregate(rows) }));
  };
  const rounds = groups(r => r.round, r => ({ round: r.round }));
  for (const r of rounds) for (const action of ["review", "fix", "reply"]) {
    const rows = expanded.filter(x => x.round === r.round && x.action === action);
    r[action] = rows.length ? aggregate(rows) : null;
  }
  return {
    ...aggregate(expanded), invocations: invocations.map(i => ({ ...i,
      ...totalOf(i.records ?? [], i.status !== "completed" || !i.records?.length) })),
    rounds,
    models: groups(r => JSON.stringify([r.agent, r.model, r.modelSource]),
      r => ({ agent: r.agent, model: r.model, modelSource: r.modelSource })),
  };
}

export function usageFromEvents(events) {
  const invocations = new Map(), pending = new Map(), history = [];
  let round = null;
  const keyFor = (agent, action, n, replyId) => JSON.stringify(
    action === "reply" && replyId ? [agent, action, "replyId", replyId] : [agent, action, n]);
  const unavailable = (e, action, n) => {
    const entry = { recorded: false, usage: {
      id: `unavailable-${history.length}`, agent: e.agent, ...modelIdentity({}),
      action, round: n, status: "unknown", records: [],
      ...(e.replyId ? { replyId: e.replyId } : {}),
    } };
    history.push(entry);
    return entry;
  };
  for (const e of events) {
    if (e.t === "round.start") round = e.n;
    if (e.t === "usage.snapshot" && e.id) {
      let entry = invocations.get(e.id);
      if (!entry) {
        const n = e.round ?? round;
        let key = keyFor(e.agent, e.action, n, e.replyId);
        // Older snapshots omit replyId even when their lifecycle events have
        // one. Attach only the first snapshot to the latest unmatched send;
        // subsequent snapshots use the invocation id and answers use replyId.
        if (e.action === "reply" && !e.replyId) {
          const match = [...pending].reverse().find(([, candidate]) => !candidate.recorded
            && candidate.usage.agent === e.agent && candidate.usage.action === "reply" && candidate.usage.round === n);
          if (match) key = match[0];
        }
        entry = pending.get(key);
        if (!entry || entry.recorded) { entry = {}; history.push(entry); }
        entry.recorded = true;
        invocations.set(e.id, entry);
        pending.set(key, entry);
      }
      entry.usage = e;
      continue;
    }
    const action = ["agent.launch", "agent.report"].includes(e.t) ? "review"
      : ["reply.sent", "reply.answered"].includes(e.t) ? "reply" : null;
    if (!action || !e.agent) continue;
    const n = e.round ?? round, key = keyFor(e.agent, action, n, e.replyId);
    // Old runs have lifecycle events without usage snapshots. Match each
    // launch to its snapshot/report, retaining unmatched attempts as unknown
    // usage rather than letting a later measured retry hide them.
    if (["agent.launch", "reply.sent"].includes(e.t)) {
      pending.set(key, unavailable(e, action, n));
    } else {
      const entry = pending.get(key) ?? unavailable(e, action, n);
      if (!entry.recorded) entry.usage.status = e.timedOut ? "timed-out" : e.verdict === "error" ? "failed" : "completed";
      pending.delete(key);
    }
  }
  return summarizeUsage(history.map(entry => entry.usage));
}

export function formatUsage(u) {
  const n = v => v == null ? "unavailable" : String(v);
  return `${n(u.total)} total · ${n(u.input)} input · ${n(u.output)} output`
    + ` · cache read ${n(u.cacheRead)} / write ${n(u.cacheWrite)}` + (u.partial ? " (partial)" : "");
}

export function printUsage(usage, log = console.log) {
  log(`\nToken usage: ${formatUsage(usage)}`);
  for (const i of usage.invocations) {
    log(`  round ${i.round ?? "?"} ${i.action} · ${i.agent} · ${i.status}: ${formatUsage(i)}`);
    for (const m of i.records ?? []) log(`    ${m.model ?? "model unavailable"} (${m.modelSource}): ${formatUsage(m)}`);
  }
  for (const r of usage.rounds) {
    log(`  round ${r.round ?? "?"}: ${formatUsage(r)}`);
    for (const action of ["review", "fix", "reply"]) if (r[action]) log(`    ${action}: ${formatUsage(r[action])}`);
  }
  for (const m of usage.models) log(`  ${m.agent} / ${m.model ?? "model unavailable"} (${m.modelSource}): ${formatUsage(m)}`);
}
