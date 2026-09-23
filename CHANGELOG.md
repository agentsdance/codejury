# Changelog

## Unreleased

- Add TRAE CLI (`traecli`) as an opt-in built-in agent named `trae`, usable as a reviewer (`--jury trae`) or the main agent (`--judge trae`). Reviews run in its read-only sandbox (#96).

## 0.7.0 — 2026-09-18

### Changed

- The built-in `kimi` agent now drives Kimi Code CLI (`@moonshot-ai/kimi-code`), the successor to
  the legacy Python `kimi-cli` that 0.6.0 targeted. Both install a `kimi` executable, but Kimi Code
  rejects `--quiet` and `--work-dir`. Reviews run in prompt mode with a shipped read-only profile
  (`lib/agents/kimi-reviewer.md`: no Edit or Write tools, read-only sub-agents only), the report is
  read from `--output-format stream-json`, and replies resume the exact session id Kimi prints.
  The entry stays opt-in. Users of the legacy CLI can keep the old command with a `jury.config.json`
  override; see [docs/configuration.md](docs/configuration.md#authentication-versions-and-conversations).

### Added

- `report: "kimi-json"` reads the assistant text out of Kimi Code's JSON lines, ignoring tool
  results and metadata, and rejects non-JSON or empty output; the console shows the decoded words
  while the agent runs. `{{packageDir}}` in a command names the installed package directory, for
  files that ship with it.
- Claude, Droid, Antigravity and OpenCode now resume their own review conversation
  when replying to verdicts, instead of starting fresh with their findings quoted
  back. Eight of eleven agents now resume. Each names an explicit session id —
  Claude via an assigned `--session-id`, the others read from structured output —
  so a reply can never land in an unrelated conversation.
- Droid and Antigravity are read through their JSON output modes, which is where
  each reports its session id. Antigravity's reported status is now checked, so a
  run that ends early cannot be read as a sign-off.

## 0.6.0 — 2026-09-16

- Validate new agents through fresh installed CLI tests; fix Qwen worktree and Git access, Copilot Git permissions, final structured result handling, and conversation isolation. All six new agents are opt-in.


### Added

- Five more built-in agents: Qwen Code, GitHub Copilot CLI, Cursor Agent CLI, Amp, and Kimi.
  Each is selectable with `--reviewer`/`--jury`, usable as the judge with `--judge`, and can be
  saved with `jury agents judge`. They ship opt-in, so a default install still requires no extra
  CLI; `jury agents` lists them marked `(opt-in)`.
- Add OpenCode as a built-in reviewer and judge, with JSON report parsing, separate role permissions, fresh conversations, and installed-package checks.
- Built-in agents are now one JSON file each under `lib/agents/`, validated by
  `lib/agent-schema.js`, so contributing an agent no longer means editing shared code. See
  [Adding a built-in agent](docs/configuration.md#adding-a-built-in-agent).
- Every agent declares a `sandbox` level. `jury agents` warns which installed reviewers have no
  read-only mode, and prints an install command for missing agents.

## 0.5.0 — 2026-09-16

- Add Google Antigravity (`agy`) as a built-in reviewer, selectable with `--jury agy` or as the main agent with `--judge agy` / `jury agents judge agy`.

- Label review participants as juries in the console.
- Keep agent durations readable below timeline tracks and align round markers with their tracks.
- Add real review screenshots to the README.

## 0.4.0 — 2026-09-15

### Added

- `jury agents judge <agent>` saves the default main agent across repositories. Run without an agent to show the saved default, or use `--reset` to remove it.
- Defaults are saved atomically in `~/.jury/config.json`. Explicit `--judge` and repository `role: main` settings take precedence; otherwise the global setting applies before the built-in Codex default.
- Invalid or disabled agent selections are rejected without changing the saved setting.

## 0.3.0 — 2026-09-13

### Added

- Coordinated review of related PRs across repositories, with separate checkouts, per-PR findings and commits, and retained workspaces for resume.
- Repeatable `--reviewer` and `--jury` selection, command-specific help, and clearer CLI defaults.
- Executable preflight for selected reviewers; runtime review/reply failures now stop the loop with saved diagnostics and resume guidance.
- Linux/macOS CI, fresh-package verification, contributor documentation, security reporting, and a console demo.

### Fixed

- A nonzero agent exit cannot count as approval, even if stdout contains the clean stop token.
- README and JSON configuration examples now describe the shipped CLI and execution permissions.

### Changed

- Use `jury review` for the loop and `jury --web-only` to view saved runs. The former `review-once` and `web` commands are removed.
- `--agents` remains a hidden compatibility alias; prefer `--reviewer` or `--jury`.

## 0.2.0 — 2026-09-08

- Codex became the default judge; reviews open the live console by default.
- Judge selection and isolated PR/MR checkout workflows.

For earlier releases, see [GitHub releases](https://github.com/agentsdance/codejury/releases).
