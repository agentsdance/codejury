# CodeJury for Codex

Use CodeJury in Codex to set up your agents, review a pull request, resume a review,
or inspect saved findings. Follow the [installation quick start](../README.md#codex-desktop-plugin)
to install from GitHub.

## Setup

You need Node.js 20.10 or newer, npm, Git, and installed, authenticated coding-agent
CLIs. GitHub PRs also require GitHub CLI (`gh auth login`) and Git credentials that
can clone the repository. Reviews use your agent accounts and their usage quotas.

In a new Codex chat, select **CodeJury** and ask:

> Set up CodeJury and check which agents I can use.

Setup checks prerequisites without starting a review. The plugin uses your global
CodeJury CLI, or installs it globally with `npm install --global @agentsdance/codejury@latest`
if missing. Agent installation and login are separate.

## Review a PR

Provide a PR link when starting a review. For example:

> Review https://github.com/OWNER/REPO/pull/123 with Codex as judge and Droid as reviewer.

Replace the example URL with your PR and choose agents you have installed. The
plugin shares a live browser console link so you can follow the review.

The judge can edit files, create commits, and push fixes to the PR's source branch.
Pushing is enabled by default (`--push=true`). Ask to keep fixes local, or specify
`--push=false`, to retain them in a persistent local checkout instead. Local files
or folders alone are not supported review targets for this plugin.

To continue or inspect a saved review, ask:

> Resume the CodeJury review of this PR: https://github.com/OWNER/REPO/pull/123

> Summarize the findings from my latest CodeJury review.

## Development and packaging

The plugin source is in [`plugins/codejury`](../plugins/codejury). Its launcher
checks npm's global package directory and reuses CodeJury there. If missing, it
installs globally; it never creates a separate plugin CLI installation. The plugin
and CLI have separate versions.

Build the submission archive from the repository root:

```sh
npm run package:plugin
```

The ZIP is written to `dist/codejury-plugin-<version>.zip`. GitHub installation
and ZIP packaging are separate from approval for OpenAI's public directory.
