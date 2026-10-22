# Contributing to Code Jury

Bug reports, reproducible examples, documentation improvements, and focused fixes are welcome.
For a substantial feature, open an issue describing the user problem before investing in implementation.

## Development

```sh
git clone https://github.com/agentsdance/codejury.git
cd codejury
npm ci
npm test
npm run test:package
```

Use Node.js 20+ and Git. Tests use temporary repositories and local fake agent executables;
they do not require provider accounts. CI covers Linux and macOS. The optional Go console
prototype can be checked with `go test ./...` using the version declared in `go.mod`.

See the [CLI command coverage map](docs/cli-test-coverage.md) for the behavioral checks
run against the installed package and their limits.

The supported CLI entrypoint is `bin/jury.js`; orchestration and persistence live in `lib/`,
the console in `web/index.html`, and tests in `test/`. Run `node bin/jury.js help --all`
for current commands. `npm start` opens saved reviews.

## Pull requests

- Keep changes focused and explain the concrete before/after behavior.
- Add a regression test for behavioral fixes; verify it fails without the fix.
- Update user-facing documentation and `CHANGELOG.md` when behavior changes.
- Run the full suite and fresh package smoke check for CLI/release changes.
- Keep credentials, private prompts, transcripts, and personal configuration out of commits.

Use the PR template to record validation and limitations. Never label dry-run agent output as a real
code review. Maintainers may request a reproduction or ask to split unrelated changes.

## Community

Be respectful and specific. Critique code and ideas, avoid personal attacks, and respect privacy.
Maintainers may remove abusive content or restrict disruptive participation.
Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.
There is no guaranteed support response time.


### Console regression checks

`npm test` and `npm run test:package` use a temporary home and Git configuration,
so a personal global judge cannot affect default-agent assertions.

For the browser suite, run `npm ci`, `npx playwright install chromium`, then
`npm run test:browser`. It packs and installs this checkout, launches that CLI's
saved-run console, and loads its real HTTP page in Chromium. Fixtures cover all
built-in agents, the legacy main lane, and an unknown agent in light/dark themes
at wide and narrow viewport widths. Checks cover completed-bar contrast, state
patterns, short/reply duration summaries, and multiple rounds. The summaries
also retain readable contrast for running and interrupted segments.

CI runs this browser suite separately from the Node/OS matrix. Failures retain
screenshots, a trace, and the HTML report as `console-browser-failure` artifacts.
Locally, inspect `playwright-report/index.html` or `test-results/` after a failure.
These tests use saved review data; they do not call live model providers.

### Diagnosing CI test hangs

The Node/OS matrix runs the same `npm test` and `npm run test:package` commands
through `node scripts/ci-check.mjs test` and `node scripts/ci-check.mjs test:package`.
The source suite has a three-minute watchdog; package validation has five minutes
for packing, installation, and subprocess-heavy installed CLI regressions on slower
runners. Both remain within the fifteen-minute job limit. A timeout remains a
failed check and terminates that phase's process group.
Tests and their parallelism are unchanged.

Package validation streams test results and prints named subprocess start/end markers. The independent
watchdog streams Node process lifecycle/resource records and snapshots of its own
process group and descendants, without command arguments or environment values.
CI uploads these records as `test-diagnostics-node<version>-<os>` artifacts for
seven days. Logs also receive the records periodically so a failed artifact upload
does not remove the only copy. A missing runner log still limits diagnosis; a
successful retry alone does not explain a prior timeout.


## Publishing releases

The `publish.yml` GitHub Actions workflow publishes to npm using
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), without a stored
npm token. Configure the npm package's GitHub Actions trusted publisher once:
organization `agentsdance`, repository `codejury`, workflow filename
`publish.yml`, no environment name, and allow direct `npm publish`.

Prepare the package version, lockfile, and changelog in a release PR and wait for
CI to pass. Tag the merged commit as `v<package version>` and publish its GitHub
release. The workflow checks that the tag matches the package version, runs the
source and fresh installed-package tests through `prepublishOnly`, and publishes
stable versions to `latest` and prereleases to `next`. Verify the publish workflow
succeeds and the expected version is available from npm before announcing it.

To retry a failed publish, use **Re-run failed jobs** on that workflow run. For a
release whose publish workflow never started, dispatch it on the existing tag:
`gh workflow run publish.yml --ref v<package version>`. Branch refs are rejected.
An already published npm version cannot be overwritten; do not rerun a successful
publish. The npm CLI tarball, plugin ZIP, and checksums are attached separately to
the GitHub release.
