# Security

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/agentsdance/codejury/security/advisories/new)
for exploitable flaws or credential exposure. Include affected versions, reproduction steps,
impact, and a minimal sanitized example. Do not open a public issue containing exploit details,
access tokens, private source code, or run transcripts.

The latest release is the supported security-fix target. Older pre-1.0 versions may require an upgrade.
This is a community-maintained project; no response-time SLA is promised.

## Trust model

Code Jury executes third-party coding-agent CLIs and commands from repository configuration.
These processes inherit the environment and can access whatever their configured permissions allow.
Repository content and prompts may influence agents; Jury is not an isolation boundary for untrusted code.
Use a separate environment with appropriately scoped credentials for unfamiliar repositories.

`--push=false` disables Jury's push step, not arbitrary agent commands. Some agent configurations
have broad approval settings. Review [configuration and permissions](docs/configuration.md) first.
Provider processing and retention are governed by your agent accounts and settings.

The console binds only to localhost, has no authentication, and exposes saved review artifacts.
Do not reverse-proxy or expose it to a network. Run directories may contain sensitive source,
prompts, and command output. Redact them before sharing.
