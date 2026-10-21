---
name: codejury-setup
description: Set up CodeJury or diagnose its local prerequisites when the user asks to install it, choose coding agents, or check whether a review can run. Setup does not start a review.
---

# Set up CodeJury

CodeJury runs on the user's computer. It orchestrates separately installed agent
CLIs; this plugin supplies instructions, not agent accounts or subscriptions.
Follow the user's requested scope and existing authorization.
Reviews start from PR links; local files or folders alone are not supported
review targets for this plugin. Setup can check prerequisites before a PR is
selected, without starting a review.

1. Check `node --version`, `npm --version`, and `git --version`. Node must be at
   least 20.10. For GitHub PRs, also check `gh --version` and `gh auth status`.
   Identify missing prerequisites before attempting a review. Help install or
   authenticate them only within the user's requested setup scope.
2. Resolve `<plugin-root>` as two directories above this skill folder. Use this
   pinned runner for plugin commands:

   ```sh
   node "<plugin-root>/scripts/jury.mjs" version
   node "<plugin-root>/scripts/jury.mjs" agents
   ```

   First use downloads the exact published release candidate into
   `~/.cache/codejury/plugin-cli/` and invokes its absolute entrypoint. It
   does not require a global installation or change the user's installed CLI.
   An explicitly requested CLI version takes precedence; check its help before
   using version-dependent options.
3. `jury agents` checks executable availability, not authentication or quota.
   Report these separately. Consult the CLI's built-in install hints for missing
   agents. Let the user complete provider sign-in; do not collect credentials
   into the plugin or copy credentials between providers.
4. Preserve existing role/model settings. Use per-run `--judge`, `--jury`, and
   `--model` flags for a particular review. Change global defaults with `jury
   agents judge`, `jury agents jury`, or `jury agents model` only when the user
   asks to save defaults.
5. Report the CLI version, available agents, remaining prerequisites, and a
   suitable PR-link command. If no PR URL is available, request it before a
   subsequent review rather than defaulting to local files. Do not start agents
   just to validate setup.

A CodeJury review can edit files and create commits. Agent providers process
the review's code and prompts and may charge for usage. `--push=false` disables
Jury's pushes; it does not make a review read-only or sandbox an agent.

Official project documentation:
[setup](https://github.com/agentsdance/codejury#quick-start) and
[configuration](https://github.com/agentsdance/codejury/blob/master/docs/configuration.md).
