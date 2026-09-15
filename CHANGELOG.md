# Changelog

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
