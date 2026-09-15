# Changelog

## Unreleased

### Added

- Six built-in agents: OpenCode, Qwen Code, GitHub Copilot CLI, Cursor Agent CLI, Amp, and Kimi.
  Each can be selected with `--reviewer`/`--jury`, used as the judge with `--judge`, and saved as
  the global default judge.
- Built-in agents are now one JSON file each under `lib/agents/`, validated by `lib/agent-schema.js`,
  so contributing an agent no longer means editing shared code. See
  [Adding a built-in agent](docs/configuration.md#adding-a-built-in-agent).
- Every agent declares a `sandbox` level. `jury agents` now warns which installed reviewers have no
  read-only mode, and prints an install command for missing agents.

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
