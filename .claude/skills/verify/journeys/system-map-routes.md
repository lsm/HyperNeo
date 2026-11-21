# System map pipeline routes

Run `bash .claude/skills/verify/system-map-routes.sh` from the repository root
with Bun 1.4.4 and `jq` on PATH. It prints the real exported runner's ordered stages,
checks an unavailable export, and lists the source-scan coverage. The wrapper
also checks typed inline chains, expression preambles, early returns, optional
calls, direct and re-entrant queue callbacks, and returned factory methods with identifier arguments through the strict classifier.
It also checks awaited async factories with identifier arguments.
The wrapper also runs the strict verdict CLI on the current source tree and
checks that the seven operations from step 3 of the DB operation registry design
and the done-todo page and conversation reader appear exactly once with verdict `named`.
The wrapper exits nonzero if a check fails.

For the strict registry verdict on the real source tree, run
`bun scripts/pipeline-verdict-report.ts --strict > "$RUN/verdicts.json"` and
inspect the JSON. A registered DB operation may be named by its registry key;
unregistered or ambiguous operations remain unreadable. This report does not
prove that an opaque post-pipeline callback is only a projection.
The regular verdict also checks the typed goal-session executor.
The worker checks reject a returned runner with an effectful argument.
