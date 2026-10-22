// Provider-reported tokens only. Snapshots replace earlier snapshots from the
// same invocation; retrying or resuming creates a new invocation, not a reset.
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const sum = values => values.some(n => n !== null) ? values.reduce((a, n) => a + (n ?? 0), 0) : null;
const fields = ["input", "output", "total", "cacheRead", "cacheWrite"];
const active = new Set();
export function interruptUsage() { for (const finish of [...active]) finish(); }

function tokens(u, { separateCache = false } = {}) {
  const cacheRead = count(u.cached_input_tokens ?? u.cache_read_input_tokens);
  const cacheWrite = count(u.cache_write_input_tokens ?? u.cache_creation_input_tokens);
  const rawInput = count(u.input_tokens), output = count(u.output_tokens);
  const input = rawInput === null ? null : rawInput + (separateCache ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
  return { input, output, total: input !== null && output !== null ? input + output : null,
    cacheRead, cacheWrite };
}

function modelIdentity(agent, model) {
  return typeof model === "string" && model.trim()
    ? { model, modelSource: "reported" }
    : { model: agent.model ?? null, modelSource: agent.model ? "configured" : "unavailable" };
}

/** Only decode known protocol envelopes, never usage quoted in tool/prose text. */
export function usageDecoder(agent, onUpdate = () => {}) {
  const records = new Map();
  let pending = "", document = "", turn = 0, model = null;
  const streaming = ["codex-json", "opencode-json"].includes(agent.report);
  const snapshot = () => [...records.values()];
  function put(key, usage, reportedModel = model) {
    if (!fields.some(f => usage[f] !== null)) return;
    records.set(key, { ...modelIdentity(agent, reportedModel), ...usage });
    onUpdate(snapshot());
  }
  function event(e) {
    if (!e || typeof e !== "object") return;
    if (agent.report === "result-json" && e.type === "system" && typeof e.model === "string") model = e.model;
    if (agent.report === "codex-json") {
      if (e.type === "turn.started") turn++;
      if (e.type === "thread.started" && typeof e.model === "string") model = e.model;
      if (["turn.completed", "turn.failed"].includes(e.type) && e.usage) {
        put(`turn-${turn}`, tokens(e.usage), e.model ?? model);
      }
    } else if (agent.report === "opencode-json" && e.type === "step_finish" && e.part?.tokens) {
      const u = e.part.tokens;
      // OpenCode separates reasoning from output and cache tokens from input.
      put(e.part.id ?? e.part.messageID ?? `step-${records.size}`, tokens({
        input_tokens: u.input, output_tokens: count(u.output) === null ? null : u.output + (count(u.reasoning) ?? 0),
        cache_read_input_tokens: u.cache?.read, cache_creation_input_tokens: u.cache?.write,
      }, { separateCache: true }), e.model ?? e.part.modelID);
    } else if (agent.report === "result-json" && e.type === "result" && e.usage) {
      // Droid/Qwen result usage covers this invocation, unlike Claude's
      // session-cumulative modelUsage map. Do not sum both representations.
      if (["droid", "qwen"].includes(agent.name)) put("result", tokens(e.usage, { separateCache: agent.name === "droid" }), e.model ?? model);
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

/** Synchronous appends preserve received usage even during process shutdown. */
export function trackUsage(agent, context, onLog) {
  const id = randomUUID();
  let status = "running", records = [], finished = false;
  const base = { id, agent: agent.name, ...modelIdentity(agent),
    action: context?.action ?? "review", round: context?.round ?? null,
    ...(context?.findingId ? { findingId: context.findingId } : {}) };
  const emit = () => {
    if (!context?.dir) return;
    mkdirSync(context.dir, { recursive: true });
    appendFileSync(path.join(context.dir, "events.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), t: "usage.snapshot", ...base, status, records,
    }) + "\n");
  };
  const decoder = usageDecoder(agent, next => { records = next; emit(); });
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
  const invocations = new Map();
  for (const e of events) if (e.t === "usage.snapshot" && e.id) invocations.set(e.id, e);
  return summarizeUsage([...invocations.values()]);
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
