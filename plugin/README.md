# Code Jury for Claude Code

Run `/codejury:review <pr-url>` inside Claude Code to review and fix a pull request.
Code Jury starts a Claude reviewer to find issues and a separate Claude judge to
evaluate them and make fixes. It repeats the review until there are no new findings
or the round limit is reached.

## Quick start

### 1. Check prerequisites in your terminal

You need Node.js **20.10 or newer**, npm, Git, and a signed-in Claude Code CLI.
For GitHub PRs, you also need the GitHub CLI (`gh`) signed in to an account that can
access the repository. Claude is the only coding-agent CLI this plugin needs.

Run these in your **terminal** (Terminal, iTerm, or your IDE's terminal):

```sh
node --version
npm --version
git --version
claude --version
claude auth status
gh auth status
```

Install any missing tools before continuing. If authentication is missing, run
`claude auth login` or `gh auth login` for the corresponding tool.

You do **not** need to install the `jury` CLI separately. The plugin uses `jury`
if it is on your PATH; otherwise it runs `npx -y @agentsdance/codejury`, which
downloads the CLI on first use. The plugin does not install or sign in to Claude
or GitHub for you.

### 2. Install the plugin in your terminal

```sh
claude plugin marketplace add agentsdance/codejury
claude plugin install codejury@codejury
claude plugin list
```

The first command registers this repository as a plugin source. The second installs
the plugin for your user account, so it is available across projects. In
`codejury@codejury`, the first name is the plugin and the second is the marketplace.
The list should show `codejury@codejury` as enabled.

Start a new Claude Code session to load it:

```sh
claude
```

### 3. Start a review inside Claude Code

Enter this at the **Claude Code prompt**, replacing the example URL with your PR:

```text
/codejury:review https://github.com/owner/repo/pull/123
```

This is a Claude slash command. All `/codejury:...` examples in this guide go in
Claude Code; commands beginning with `claude`, `jury`, or `npx` go in your terminal.

You should see Claude report the selected roles and share a clickable browser
console URL. The console shows findings, the judge's verdicts, and review progress.
When the review ends, Claude summarizes the outcome and leaves the console running
for you to inspect. A run that hits its round limit or fails is reported as incomplete.

A PR URL is required, even if you start Claude in the PR's repository. If you omit
it, Claude asks for it. Jury creates an isolated checkout from the URL; you do not
need to clone the PR yourself. Local files, folders, and branches alone are not
supported review targets for this plugin.

## What the review does

| Role | What it does |
| --- | --- |
| Your Claude Code session | Starts and monitors the automated run, shares its console link, and reports the result. |
| Claude reviewer | Reads the code and reports findings in a separate, read-only session. |
| Claude judge | Evaluates findings and can edit files and create commits in another session. |

The plugin always selects `--judge claude --reviewer claude`, including when
resuming. It overrides supplied role flags and saved role choices for this run.
Other settings, such as models, still apply; saved configuration is unchanged.
Separate Claude sessions do not provide model diversity.

**Reviews can edit files and create commits. Pushing is off by default.**
The plugin adds `--push=false`; add `--push` only when you want Jury to push fixes
to the PR branch. A single-PR checkout is temporary, and its unpushed fixes are
removed during cleanup. Saved review records remain available, but they are not
a retained checkout of those fixes. See [state and retention](https://github.com/agentsdance/codejury/blob/master/docs/usage.md#working-directories).

The browser console is on by default (`--web=true`). Add `--web=false` to skip it
and let the command exit after review. Explicit `--web` and `--push` values take
precedence over these defaults.

## Common commands

Enter these **inside Claude Code**, replacing the URLs and run slug:

| To… | Enter… |
| --- | --- |
| Limit the review to three rounds | `/codejury:review https://github.com/owner/repo/pull/123 --rounds 3` |
| Skip the browser console | `/codejury:review https://github.com/owner/repo/pull/123 --web=false` |
| Allow pushes to the PR branch | `/codejury:review https://github.com/owner/repo/pull/123 --push` |
| Review related PRs together | `/codejury:review https://github.com/owner/repo/pull/123 https://github.com/owner/repo/pull/456` |
| Continue a saved run | `/codejury:review https://github.com/owner/repo/pull/123 --resume <run-slug>` |

For resume, supply the original PR URL(s), keeping related URLs in the same order.
With a PR URL, `--dir /path/to/state` chooses where Jury stores checkouts and run
records; it does not select a local folder to review. Repeat the same `--dir` when
resuming. For all flags, run `npx -y @agentsdance/codejury help review` in your
terminal (or `jury help review` if `jury` is installed).

### Find saved results

URL-based reviews store records in `~/.jury` by default. Run these in your **terminal**:

```sh
npx -y @agentsdance/codejury runs --dir ""
npx -y @agentsdance/codejury --web-only --dir "" --run <run-slug>
```

Replace `<run-slug>` with a slug from the first command. `--dir ""` explicitly selects
`~/.jury`, even when your terminal is in a Git repository. If the review used a custom
`--dir`, use that path instead. Use `jury` in place of `npx -y @agentsdance/codejury`
if that was the CLI used for the review. Opening saved results does not start reviewers.

### Which skill should I use?

| Claude Code command | Use it for |
| --- | --- |
| `/codejury:review <pr-url>` | The automated review-and-fix loop described above. Start here. It runs only when you invoke it. |
| `/codejury:codejury` | Guidance for explicitly requested manual review and triage, where your current Claude session acts as judge and coordinates separate Claude reviewers. It still requires a PR URL before reviewers start. |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `/codejury:review` is missing | Run `claude plugin list` in your terminal. If absent, repeat installation; if disabled, run `claude plugin enable codejury@codejury`. Start a new Claude session. `claude plugin details codejury` should list the `review` and `codejury` skills. |
| `jury: command not found` in your terminal | Use `npx -y @agentsdance/codejury` in place of `jury`. The plugin already makes this choice automatically. |
| Claude or GitHub authentication fails | Check `claude auth status` or `gh auth status` and sign in with the corresponding `auth login` command. `jury agents` checks installed executables, not authentication or quota. |
| An older CLI rejects Claude as both judge and reviewer | The plugin retries once with the repository CLI: `npx -y --package=git+https://github.com/agentsdance/codejury.git jury`. It keeps your arguments and saved configuration. If that also fails, it reports the error. |
| The review is done but the process is still running | The web console stays up for inspection. Ask Claude to stop the console when finished, or use `--web=false` on the next review. |
| A saved run is missing | List runs with the same state root used for review. For the default URL-based review, use `runs --dir ""`. |

## Update

Run these in your **terminal**, then start a new Claude Code session:

```sh
claude plugin marketplace update codejury
claude plugin update codejury@codejury
```

The plugin and Code Jury CLI are separate. Updating the plugin refreshes its skills;
if you installed `jury` globally, update that CLI with `npm install -g @agentsdance/codejury`.
The plugin deliberately omits a version field so it follows the repository without
maintaining a second release number. See Claude Code's [plugin installation and management guide](https://code.claude.com/docs/en/discover-plugins)
for installation scopes and other plugin controls.

## For plugin contributors

From the Code Jury repository root, run these in your terminal:

```sh
claude plugin validate ./plugin
claude plugin validate .
node --test test/plugin.test.js
claude --plugin-dir ./plugin
```

`--plugin-dir` loads the local plugin for that session. To test marketplace installation,
add the local repository path as a marketplace and install `codejury@codejury` using an
isolated `CLAUDE_CONFIG_DIR`. `claude plugin details codejury` should list `codejury` and `review`.

The Claude Code plugin lives under `plugin/`. Installation includes its manifest,
skills, and this guide. Skill references to repository documentation use GitHub URLs
because the rest of the source tree is not installed. The manual skill moved from
`skill/SKILL.md` to `plugin/skills/codejury/SKILL.md`; update old copies or symlinks.
