# Code Jury

**Independent AI reviewers. One judge. A review you can follow.**

[![CI](https://github.com/agentsdance/codejury/actions/workflows/ci.yml/badge.svg)](https://github.com/agentsdance/codejury/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agentsdance/codejury)](https://www.npmjs.com/package/@agentsdance/codejury)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Code Jury is a local CLI that asks independent coding agents to review a pull request,
then lets one judge reproduce findings, apply fixes, and ask the reviewers to check again.
Follow each conversation in a browser console, with prompts, reports, verdicts, and commits saved locally.
It also reviews related PRs across repositories as one coordinated task.

[Download the interactive console demo](docs/console-demo.html) and open the HTML file in a browser.
It uses illustrative data and does not start agents.

## Quick start

You need Node.js 20+, Git, and authenticated coding-agent CLIs. GitHub PRs also need
[GitHub CLI](https://cli.github.com/) (`gh auth login`) and Git credentials that can clone the repository.
Start with an installed Codex judge and Claude reviewer, or choose your own configured agents.
Agent installation, login, subscriptions, and usage charges are separate from Code Jury.

```sh
npm install -g @agentsdance/codejury
jury agents
jury review https://github.com/OWNER/REPO/pull/123 --reviewer claude --push=false
```

Replace the example URL with your PR. `jury agents` lists configured executables and roles;
it checks installation, not authentication or available quota. Authenticate each selected agent
using its own CLI before the review. With the command above, Codex judges and Claude reviews.

**Reviews can edit files and create commits. Pushing is enabled by default.**
`--push=false` disables Jury's pushes; it is not a read-only mode or an agent sandbox.
Single-PR URL checkouts are temporary and removed on completion; for durable local-only fixes,
use your own checkout without a URL. See [state and retention](docs/usage.md).
The console opens automatically and stays up after the review; press Ctrl-C when finished.
For terminal-only use, add `--web=false`.

```text
jury agents                           # installed executables and configured roles
jury review <pr-url> --push=false      # review and fix without pushing
jury review <pr-url>                   # review, fix, commit, and push
jury runs --dir ""                    # list saved URL-based reviews
jury --web-only --dir ""               # reopen their console
jury help review                      # complete review options
```

`jury <pr-url>` is shorthand for `jury review <pr-url>`. You can also run without installing:
`npx @agentsdance/codejury review <pr-url> --reviewer claude --push=false`.

## How it works

1. Resolve the PR's base branch and head commit into an isolated checkout.
2. Run selected reviewers concurrently. Each reports independently.
3. Let one judge investigate each finding and record a verdict. Accepting a finding requires reproduction evidence and a test description.
4. Commit fixes and, unless disabled, push to the source branch. Send each reviewer feedback about its own findings.
5. Repeat until reviewers agree and no findings remain open, or the round limit is reached.

Agent agreement is a review result, not proof that code is defect-free. The evidence is recorded
so you can inspect it. Judge-provided test evidence is not an independent certification.
The default limit is 10 rounds, with up to three exchanges per disputed finding.

Missing selected executables stop the run before agents start. A reviewer that exits unsuccessfully
stops the loop after the current review or reply round; its failure is saved and never counted as approval.
Fix the installation, login, or quota issue and resume with the same target arguments and `--resume <slug>`.

## Choose your reviewers

```sh
jury review <pr-url> --reviewer claude --reviewer grok
jury review <pr-url> --jury claude,grok
jury review <pr-url> --judge claude --reviewer droid --push=false
```

`--reviewer` and `--jury` accept repeated flags and comma-separated names. The selected judge
is excluded from the reviewer pool. Built-in agents are Codex (default judge), Claude, Grok, and Droid.
Without an explicit selection, enabled agents with the reviewer role are used; disable unavailable ones
or select installed reviewers explicitly.

Use [`jury.config.example.json`](jury.config.example.json) to configure agents in the target repository.
See [configuration and permissions](docs/configuration.md) for the actual execution boundary and custom commands.

## Review related PRs together

```sh
jury review https://github.com/acme/api/pull/12 https://github.com/acme/client/pull/34 \
  --reviewer claude --push=false
```

Every reviewer sees all supplied PRs, their descriptions, and separate checkouts. The judge can fix
cross-repository problems in the appropriate branches. Findings and commits stay associated with each PR.
The first PR supplies configuration. Omit `--trunk`: each PR has its own base branch.
See [usage and troubleshooting](docs/usage.md) for resume behavior, GitLab limitations, and state directories.

## Data and permissions

- Jury runs agent CLIs on your machine. Those agents may send source code, prompts, and outputs to their providers under your account settings and terms.
- Agents inherit the process environment. Repository configuration defines executable commands; inspect it before running on an unfamiliar repository.
- Read-only intent is enforced only as far as each agent's configured permissions allow. Some built-in/custom agents use broad approval settings. Jury is not a security sandbox.
- Prompts, transcripts, findings, and run metadata are saved under the selected state root. They may contain sensitive source material; review them before sharing.
- The console binds to `127.0.0.1` and has no login. Keep it local. See [SECURITY.md](SECURITY.md).

## Project status and contributing

Code Jury is pre-1.0. CLI changes are recorded in the [changelog](CHANGELOG.md).
CI exercises Node.js 20, 22, and 24 on Linux and macOS, including a fresh package installation.
Windows is experimental; the complete workflow has not been validated there.
External agent services are tested with local fixtures in CI, so provider CLI compatibility still depends on your installed versions.
The Go console prototype is retained for development; the npm CLI is the supported distribution.

[Report a bug](https://github.com/agentsdance/codejury/issues/new/choose) ·
[Contribute](CONTRIBUTING.md) · [Security reports](SECURITY.md) ·
[Case study](CASE-STUDY.md) · [Known limitations](TODO.md)

## Sponsors

Supported by OpenAI's [Codex for Open Source](https://openai.com/form/codex-for-oss/)
program with ChatGPT Pro (20x) access.

## License

[MIT](LICENSE).
