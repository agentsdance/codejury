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
`report: "tail"` extracts a final response from a verbose transcript; otherwise the whole output is read.
`expectSeconds` informs the timeout (at least 600 seconds, normally three times that estimate).
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
| Qwen Code (opt-in) | `qwen` | `--approval-mode plan` | `--approval-mode auto-edit` |
| Copilot CLI (opt-in) | `copilot` | `write` and `shell` tools denied | Tools allowed |
| OpenCode (opt-in) | `opencode` | ⚠️ No read-only flag; `--auto` withheld | `--auto` |
| Cursor Agent (opt-in) | `cursor-agent` | ⚠️ Print mode; all tools including write and bash | `--force` |
| Amp (opt-in) | `amp` | ⚠️ Execute mode; no read-only flag | Same command unless overridden |
| Kimi (opt-in) | `kimi` | ⚠️ Print mode auto-approves tool calls | Same command unless overridden |
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
