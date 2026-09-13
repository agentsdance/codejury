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
    { "name": "droid", "enabled": false }
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
unless you also specify `judgeArgv`. Optional session configuration is illustrated in `lib/config.js`.

## Execution boundary

| Agent | Reviewer invocation | Judge invocation |
|---|---|---|
| Codex | Read-only sandbox | Workspace-write sandbox |
| Claude | Plan mode; edit tools disallowed | `acceptEdits` permission mode |
| Grok | `--always-approve` | Same command unless overridden |
| Droid | `--auto medium` | Same command unless overridden |
| Custom | Your `argv` | Your `judgeArgv`, or `argv` |

These are Jury's configured arguments, not a guarantee about third-party behavior.
Prompts ask reviewers not to edit, but permissions vary by agent, and resumed sessions have their
own provider semantics. Only run agents and repositories you trust. `--push=false` controls Jury's
push step; it does not prevent an agent from executing Git or other commands.

No provider keys belong in configuration. Each CLI uses its own login/configuration and inherits
your environment. Run records include prompts and outputs, so redact them before sharing.
