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
