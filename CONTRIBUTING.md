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
