// What a built-in agent definition is allowed to say, and what it must say.
//
// This exists so that adding an agent is a data change, not a code change. A
// contributor drops one file into lib/agents/ and the schema decides whether it
// is well formed; nothing here needs editing to accept a new entry. The test
// suite validates every shipped definition against this, so a typo in a new
// agent's file fails CI rather than surfacing months later as "that reviewer
// silently never ran".

/** Prompt delivery mechanisms runAgent knows how to perform. */
export const PROMPT_DELIVERY = ["argv", "file", "stdin"];

/** How the working directory reaches the agent. */
export const CWD_MODES = ["worktree", "flag"];

/** How much of stdout is the agent's report. */
export const REPORT_MODES = ["whole", "tail", "opencode-json", "result-json", "kimi-json", "agy-json"];

/**
 * How strongly the reviewer invocation is prevented from writing.
 *
 *   sandbox    the CLI enforces read-only (codex --sandbox read-only)
 *   plan       the CLI has a no-edit/plan mode (claude, qwen)
 *   tools      writes are withheld by denying specific tools (claude, copilot)
 *   none       the CLI offers no read-only mode at all
 *
 * "none" is not a defect to be hidden. Several good agents simply have no
 * read-only invocation, and a reviewer that can write is a real difference in
 * what a run guarantees — so it is recorded per agent and surfaced by
 * `jury agents` rather than buried in whichever flags happen to be in argv.
 */
export const SANDBOX_LEVELS = ["sandbox", "plan", "tools", "none"];

const isTemplate = (v) => typeof v === "string";
const isArgv = (v) => Array.isArray(v) && v.length > 0 && v.every(isTemplate);
// Environment overrides must be flat strings: spawn cannot pass anything else,
// and a nested object would silently arrive as "[object Object]".
const isEnv = (v) => v && typeof v === "object" && !Array.isArray(v)
  && Object.values(v).every((x) => typeof x === "string");

/** Every key a definition may carry, with its validator and whether it is required. */
const FIELDS = {
  name: { required: true, check: (v) => typeof v === "string" && /^[a-z][a-z0-9-]*$/.test(v),
    why: "a lowercase slug — it is what --reviewer and --judge accept" },
  product: { required: true, check: (v) => typeof v === "string" && v.trim().length > 0,
    why: "the human-readable product name shown in documentation" },
  role: { required: false, check: (v) => v === "main" || v === "reviewer",
    why: '"main" or "reviewer"' },
  promptDelivery: { required: true, check: (v) => PROMPT_DELIVERY.includes(v),
    why: `one of ${PROMPT_DELIVERY.join(", ")}` },
  cwd: { required: true, check: (v) => CWD_MODES.includes(v),
    why: `one of ${CWD_MODES.join(", ")}` },
  argv: { required: true, check: isArgv, why: "a nonempty array of strings" },
  judgeArgv: { required: false, check: isArgv, why: "a nonempty array of strings" },
  replyArgv: { required: false, check: isArgv, why: "a nonempty array of strings" },
  report: { required: true, check: (v) => REPORT_MODES.includes(v),
    why: `one of ${REPORT_MODES.join(", ")}` },
  sandbox: { required: true, check: (v) => SANDBOX_LEVELS.includes(v),
    why: `one of ${SANDBOX_LEVELS.join(", ")}` },
  sandboxNote: { required: false, check: (v) => typeof v === "string" && v.trim().length > 0,
    why: "a short phrase explaining the reviewer's write boundary" },
  env: { required: false, check: isEnv,
    why: "an object of string environment variables for the reviewer run" },
  judgeEnv: { required: false, check: isEnv,
    why: "an object of string environment variables for the judge run" },
  newSession: { required: false, check: (v) => typeof v === "boolean",
    why: "true when the agent accepts a session id we generate" },
  resume: { required: true, check: (v) => v && typeof v === "object" && typeof v.supported === "boolean",
    why: "an object with a boolean `supported`" },
  expectSeconds: { required: false, check: (v) => Number.isFinite(v) && v > 0,
    why: "a positive number of seconds" },
  enabled: { required: false, check: (v) => typeof v === "boolean", why: "a boolean" },
  install: { required: false, check: (v) => typeof v === "string" && v.trim().length > 0,
    why: "the command that installs this agent" },
  docs: { required: false, check: (v) => typeof v === "string" && /^https?:\/\//.test(v),
    why: "an http(s) URL to the agent's own documentation" },
};

/**
 * Check one built-in agent definition. Returns the list of problems; empty
 * means valid. Reporting every problem at once matters for the intended
 * audience — a contributor adding an agent should see all of it in one run,
 * not peel the errors off one at a time.
 */
export function validateAgent(agent, { source = "agent" } = {}) {
  const problems = [];
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    return [`${source}: expected an object`];
  }

  for (const [key, spec] of Object.entries(FIELDS)) {
    const has = Object.hasOwn(agent, key);
    if (!has) {
      if (spec.required) problems.push(`${source}: missing "${key}" — expected ${spec.why}`);
      continue;
    }
    if (!spec.check(agent[key])) problems.push(`${source}: "${key}" must be ${spec.why}`);
  }

  for (const key of Object.keys(agent)) {
    if (!Object.hasOwn(FIELDS, key)) {
      problems.push(`${source}: unknown field "${key}" — remove it or add it to lib/agent-schema.js`);
    }
  }

  // A resume entry that claims support must say how, or the reply path has
  // nothing to run; one that declines must say why, so the next person to read
  // it knows it was a decision rather than an omission.
  const resume = agent.resume;
  if (resume && typeof resume === "object") {
    if (resume.supported && !isArgv(resume.argv)) {
      problems.push(`${source}: resume.supported is true but resume.argv is not a nonempty array of strings`);
    }
    if (!resume.supported && !(typeof resume.reason === "string" && resume.reason.trim())) {
      problems.push(`${source}: resume.supported is false, so resume.reason must explain why`);
    }
    // Resuming "the last session" is the one resume shape this project refuses:
    // it delivers a reply into whatever ran most recently, which is the review
    // being answered only if nothing else ran in between.
    if (resume.supported && isArgv(resume.argv)
      && !resume.argv.some((a) => a.includes("{{sessionId}}"))) {
      problems.push(`${source}: resume.argv must name the session with {{sessionId}} — resuming the latest session can answer an unrelated conversation`);
    }
  }

  // An agent that cannot be held read-only has to say so in words, because
  // that sentence is what `jury agents` shows the user.
  if (agent.sandbox === "none" && !(typeof agent.sandboxNote === "string" && agent.sandboxNote.trim())) {
    problems.push(`${source}: sandbox is "none", so sandboxNote must describe the reviewer's write boundary`);
  }

  // The executable must actually appear in argv, or probe() looks up the wrong
  // binary and reports an installed agent as missing.
  if (isArgv(agent.argv) && agent.argv[0].includes("{{")) {
    problems.push(`${source}: argv[0] must be the executable name, not a template`);
  }

  return problems;
}

/** Validate a whole registry, including cross-entry rules. */
export function validateRegistry(agents) {
  const problems = [];
  const seen = new Set();
  for (const agent of agents) {
    problems.push(...validateAgent(agent, { source: agent?.name ?? "agent" }));
    if (agent?.name) {
      if (seen.has(agent.name)) problems.push(`${agent.name}: defined twice`);
      seen.add(agent.name);
    }
  }
  const mains = agents.filter((a) => a?.role === "main");
  if (mains.length > 1) {
    problems.push(`only one built-in agent may have role "main"; found ${mains.map((a) => a.name).join(", ")}`);
  }
  return problems;
}
