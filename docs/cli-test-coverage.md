# CLI command coverage

Every supported command and subcommand has a behavioral subprocess check. Run
`npm test` for the source suite and `npm run test:package` to repeat the command
checks against a freshly packed and installed distribution.

This is 100% **command/subcommand coverage**, not 100% line, branch, flag-combination,
or live-provider coverage. Provider executables are controlled local fixtures;
they do not validate a provider's current authentication or CLI compatibility.

| Command / mode | Behavioral checks | Tests run against installed package |
|---|---|---|
| `review` | Review, triage, fix, commit, push, convergence, resume, failure recovery | `review-group`, `reviewer-selection`, `cli-commands` |
| `agent` alias; bare review flags | Subprocess reviewer completes and saved run lists the round | `cli-commands` |
| Bare PR URL shorthand | Related PR review completes and remote branches contain fixes | `review-group` |
| `--web-only` | Serve selected saved run, real HTTP response, no new review events | `web-launch` |
| `finding list` / `findings list` | Empty and populated output; reproduced and resolved states | `cli-commands` |
| `finding reproduce` | Evidence persisted and visible in subsequent listing; invalid inputs do not mutate events | `cli-commands` |
| `finding resolve` | All four verdicts; acceptance requires reproduction and test evidence; persisted output | `cli-commands` |
| `finding settled` | Empty output and regenerated file agree with resolved findings | `cli-commands` |
| `reply` | Selected reviewers receive their own findings; reply events/output; empty reply refused | `reviewer-selection`, `new-agents`, `cli-commands` |
| `runs` | Empty listing and saved run slug, title, rounds, finding counts | `cli-commands` |
| `agents` | Executable availability, missing executable failure, effective judge role | `cli-commands`, agent integration tests |
| `agents judge <name>` | Every built-in set, queried in a different directory, and shown as main in listing | `cli-commands` |
| `agents judge` | Unset and exact saved-name output through separate processes | `cli-commands`, `global-judge` |
| `agents judge --reset` | Reset output followed by query confirming unset; every built-in | `cli-commands`, `global-judge` |
| `version`, `-v`, `--version` | Exact installed package version | `cli-commands` |
| `help`, `-h`, `--help`, no command | Usage output, all topics and aliases, full-reference variants, invalid topics | `cli-commands`, `help` |
| Unknown command/subcommand | Nonzero exit and actionable errors | `cli-commands` |
| npm executable names: `jury`, `codejury`, `cr` | npm-created links discovered through PATH; exact package version | `scripts/check-package.mjs` |

Test filenames above are under `test/` with the `.test.js` suffix. Home directories,
configuration, agent processes, and Git remotes are isolated; these checks do not
change the user's global judge or contact real agent services. Executable-link
checks use a temporary npm installation, not the user's global npm prefix.

CI runs source and package checks on Linux and macOS with Node 20, 22, and 24.
Separate Chromium checks exercise the installed console's timeline rendering.
