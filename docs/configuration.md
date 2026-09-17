# Configuration and permissions

Jury reads `jury.config.json` in the reviewed repository (the first PR for a related-PR task).
It also accepts the former `cr.config.json` and `macr.config.json` names, in that order.
Entries merge by agent name with the built-in registry. `enabled: false` disables an agent.
Exactly one enabled agent may have role `main`; it is the default judge.

The example configuration keeps Codex as judge and Claude as reviewer:

```json
{
  "agents": [
    { "name": "grok", "enabled": false },
    { "name": "droid", "enabled": false },
    { "name": "agy", "enabled": false }
  ]
}
```

The CLI checks executable availability before starting selected reviewers. It cannot preflight
provider login, credits, or quota without invoking the provider. Runtime failures stop the loop
and remain visible in the saved reports.

## Custom agent

```json
{
  "agents": [{
    "name": "my-reviewer",
    "role": "reviewer",
    "argv": ["my-reviewer", "--prompt", "{{promptText}}"],
    "cwd": "worktree",
    "promptDelivery": "argv",
    "report": "whole",
    "expectSeconds": 300
  }]
}
```

`my-reviewer` is a placeholder executable, not an included product. Use arguments supported by your CLI.
Supported prompt delivery is `argv` or `file` (`{{promptFile}}`); stdin is closed.
`cwd: "worktree"` starts in the checkout; with `cwd: "flag"`, pass `{{worktree}}` in the command.
`report: "tail"` extracts a final response from a verbose transcript; `report: "kimi-json"` reads the
assistant messages out of Kimi Code's `--output-format stream-json` lines; otherwise the whole output is read.
`expectSeconds` informs the timeout (at least 600 seconds, normally three times that estimate).
Command placeholders are `{{promptText}}`, `{{promptFile}}`, `{{worktree}}`, `{{sessionId}}` (for
resumable agents), and `{{packageDir}}`, the directory Code Jury is installed in, for files that ship
with it such as `lib/agents/kimi-reviewer.md`.
The historical YAML example is design documentation; the CLI loads JSON.

A judge may specify separate `judgeArgv`. A custom `argv` overrides the built-in judge invocation
unless you also specify `judgeArgv`. Optional session configuration is illustrated by the built-in
definitions in `lib/agents/`.

## Adding a built-in agent

Built-in agents are data, not code: each is one JSON file in `lib/agents/`, listed in
`lib/agents/registry.js`. Adding one is a new file plus a two-line change to that list, and
touches nothing else — `jury agents`, `--reviewer`, `--judge` and the saved global judge all
read from the registry.

1. Copy an existing definition, for example `lib/agents/qwen.json`.
2. Add it to the import list in `lib/agents/registry.js`.
3. Run `npm test`.

`lib/agent-schema.js` defines every permitted field, and `test/builtin-agents.test.js` validates
the whole registry, so these fail in CI rather than mid-review:

- a missing or unknown field, including a missing `sandbox`;
- an `argv` whose prompt template never reaches the agent;
- a `cwd: "flag"` entry that forgets to pass `{{worktree}}`;
- a resume that would reattach to the *latest* session instead of one named by `{{sessionId}}`;
- `sandbox: "none"` without a `sandboxNote` explaining the boundary.

Verify the flags against the agent's own `--help` before adding it, and record its `install`
command and `docs` URL so `jury agents` can tell users how to install a missing reviewer. New
agents should ship with `"enabled": false` so a default install needs no extra CLI.

## Execution boundary

Agents marked **opt-in** are not used unless named with `--reviewer`/`--jury`/`--judge`, or
enabled in `jury.config.json`. They are supported, just not conscripted by default — otherwise a
review could not start until every supported CLI was installed.

| Agent | Executable | Reviewer invocation | Judge invocation |
|---|---|---|---|
| Codex | `codex` | Read-only sandbox | Workspace-write sandbox |
| Claude | `claude` | Plan mode; edit tools disallowed | `acceptEdits` permission mode |
| Grok | `grok` | ⚠️ `--always-approve` | Same command unless overridden |
| Droid | `droid` | `--auto medium` | Same command unless overridden |
| Antigravity (`agy`) | `agy` | ⚠️ `--dangerously-skip-permissions`, print mode | Same command unless overridden |
| Qwen Code (opt-in) | `qwen` | Default approval; write tools excluded, Git inspection allowed | `--approval-mode yolo` |
| Copilot CLI (opt-in) | `copilot` | Write tools denied; read and Git inspection allowed | Tools allowed |
| OpenCode (opt-in) | `opencode` | Plan agent with explicit edit/task/shell restrictions | Build agent with `--auto` |
| Cursor Agent (opt-in) | `cursor-agent` | ⚠️ Print mode; all tools including write and bash | `--force` |
| Amp (opt-in) | `amp` | ⚠️ Execute mode; no read-only flag | Same command unless overridden |
| Kimi Code (opt-in) | `kimi` | Prompt mode with the shipped `lib/agents/kimi-reviewer.md` profile: Edit and Write tools removed, only the read-only `explore` sub-agent; shell available | Prompt mode with all tools |
| Custom | Your `argv[0]` | Your `argv` | Your `judgeArgv`, or `argv` |

⚠️ marks agents whose CLI offers **no read-only invocation**. They still review, but only the
review prompt — not the tool — withholds writes. `jury agents` prints this warning for every such
reviewer that is installed. Prefer a sandboxed agent where that distinction matters.

Each definition records this as a `sandbox` field (`sandbox`, `plan`, `tools`, or `none`); an
agent declaring `none` must also carry a `sandboxNote` explaining the boundary, which is what
`jury agents` prints.

These are Jury's configured arguments, not a guarantee about third-party behavior.
Prompts ask reviewers not to edit, but permissions vary by agent, and resumed sessions have their
own provider semantics. Only run agents and repositories you trust. `--push=false` controls Jury's
push step; it does not prevent an agent from executing Git or other commands.

No provider keys belong in configuration. Each CLI uses its own login/configuration and inherits
your environment. Run records include prompts and outputs, so redact them before sharing.

### Authentication, versions, and conversations

A reviewer's reply is a turn in the conversation that raised the findings, so
the agent can see what it said. Every resume names an explicit session id —
never "the latest session", which would answer whatever ran most recently in
that worktree rather than this review.

An id reaches Jury one of two ways. Some CLIs accept one we generate
(`--session-id`), so the conversation is identified before it exists. The rest
print one in structured output, which is read back with `resume.idFrom`. An id
is never inferred from assistant prose: a model that happens to mention a UUID
is not reporting its session, and resuming on that would deliver a verdict into
an unrelated conversation.

| Agent | Session id | Resumes |
|---|---|---|
| Claude | assigned `--session-id` | yes |
| Grok | assigned `--session-id` | yes |
| Qwen | assigned `--session-id` | yes |
| Codex | printed by `exec` | yes |
| Droid | `session_id` in `-o json` | yes |
| Antigravity | `conversation_id` in `--output-format json` | yes |
| OpenCode | `sessionID` in the JSON event stream | yes |
| Kimi Code | printed at the end of the `stream-json` output | yes |
| Amp, Cursor, Copilot | — | no; replies start fresh with the finding context |

Agents that do not resume lose nothing in substance: `buildReply` quotes their
own prior findings back to them. The judge never resumes at all — each finding
is triaged in its own session so one verdict cannot anchor the next.

- Kimi Code: verified CLI 0.39.1 and 0.42.0 (`npm install -g @moonshot-ai/kimi-code`); run `kimi login`, or put an API key in `~/.kimi-code/config.toml`, whose `default_model` is the model used. Prompt mode (`kimi -p`) rejects `--plan`, `--yolo` and `--auto` and approves every tool call itself, so the reviewer boundary is the shipped agent profile: it wraps Kimi's default prompt, removes the Edit and Write tools, and allows only the read-only `explore` sub-agent (the default `coder` sub-agent can write). The shell stays available, so the profile is not a sandbox. The report is read from `--output-format stream-json`, and replies resume the exact session id Kimi prints at the end of the stream; the profile flag is omitted on resume because Kimi refuses it next to `--session`, and the session keeps the agent it was created with. Kimi keeps its own session history per working directory under `~/.kimi-code`. The legacy Python `kimi-cli` installs an executable of the same name but takes different flags (`kimi --version` prints 1.x for it and 0.x for Kimi Code); to keep using it, override the entry in `jury.config.json`:

  ```json
  { "agents": [{ "name": "kimi", "argv": ["kimi", "--quiet", "--work-dir", "{{worktree}}", "--prompt", "{{promptText}}"], "report": "whole", "resume": { "supported": false, "reason": "quiet mode prints no session id" } }] }
  ```
- Cursor: verified `cursor-agent` 2025.10.28-0a91dc2; run `cursor-agent login`. The generic executable `agent` may belong to another product, so Jury uses `cursor-agent`. Final JSON must explicitly report success. Replies start fresh.
- Copilot: verified CLI 0.0.392 flags; authenticate with interactive `/login`. A reviewer can inspect files and Git but cannot use write tools; the judge allows tools. Local permission configuration remains trusted. Replies start fresh.
- Qwen: targets CLI 0.23.4 (`npm install -g @qwen-code/qwen-code`); run `qwen` and complete `/auth` before headless use. It runs in the process worktree, not merely an added access directory. Reviews use assigned UUIDs, and replies resume only that UUID; no implicit latest session. Final JSON must explicitly report success.
- Amp: verified CLI 0.0.1788739286; run `amp login`. Threads are private and IDE context is disabled. Both roles can execute tools automatically; replies start fresh with their own finding context. (`--stream-json` does expose a thread id, so resume is possible once that output mode is parsed.)

A missing executable, nonzero exit, timeout, or unsuccessful structured result never approves a review. Git command allowlists are CLI tool permissions, not OS sandboxes; use trusted local agent configuration. Model credentials and service availability are prerequisites for live inference.
