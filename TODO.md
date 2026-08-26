# Deferred

## The triage step
`macr agent` still prints `→ awaiting claude: macr finding reproduce <id>` and
moves on. It no longer lies about it — a round with open findings reports
"N finding(s) still open — not convergence" rather than success — but the
fix-between-rounds half of the loop is not built.
