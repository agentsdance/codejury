# Code Jury for Claude Code

Run independent AI code reviewers and a judge from a Claude Code session. The judge triages
findings and fixes accepted issues; Jury repeats the loop until the reviewers agree or the run
reaches its limit.

## Install

```sh
claude plugin marketplace add agentsdance/codejury
claude plugin install codejury@codejury
```

Start a new Claude Code session after installing, then run:

```text
/codejury:review https://github.com/owner/repo/pull/123
/codejury:review --reviewer claude --judge codex --rounds 3
```

The second example reviews the current branch. You can also pass multiple related PR URLs,
use `--dir` to select a checkout, or pass other `jury review` flags.

You need Node.js 20.10 or newer, npm, Git, and installed, authenticated agent CLIs. GitHub PR URLs
also need an authenticated `gh` CLI. The plugin uses an installed `jury`, or
`npx -y @agentsdance/codejury` if `jury` is absent. It does not bundle or authenticate agent CLIs.
Use `jury agents` (or `npx -y @agentsdance/codejury agents`) to inspect your setup.

## Behavior

- `/codejury:review` runs only when invoked by the user. It respects your CLI flags,
  `jury.config.json`, and saved agent/model defaults.
- It defaults to `--web=false` so the command exits after review, and `--push=false` so fixes stay
  local. The judge can still edit files and Jury can create commits. Pass `--push` to publish them.
- Explicit `--web` and `--push` values take precedence. With `--web=true`, the console stays open
  after the review completes.
- `multi-agent-code-review` provides guidance for manually coordinating reviewers and triaging
  findings. Its source moved from `skill/SKILL.md` to `plugin/skills/multi-agent-code-review/SKILL.md`;
  update any copies or symlinks that used the old path.

## Update

```sh
claude plugin marketplace update codejury
claude plugin update codejury@codejury
```

The plugin deliberately omits a version field so updates follow the repository without maintaining
a second release number. The installed Code Jury CLI is separate; update a global CLI installation
with `npm install -g @agentsdance/codejury` when needed.

## Develop and validate

From the repository root:

```sh
claude plugin validate ./plugin
claude plugin validate .
node --test test/plugin.test.js
claude --plugin-dir ./plugin
```

To test marketplace installation, add the local repository path as a marketplace and install
`codejury@codejury`. Use an isolated `CLAUDE_CONFIG_DIR` for development so this does not change your
normal marketplace settings. `claude plugin details codejury` should list `review` and
`multi-agent-code-review`.

The plugin lives under `plugin/` so installation includes only its manifest, skills, and this guide.
Skill references to repository documentation use GitHub URLs because the rest of the source tree
is not part of the installed plugin.
