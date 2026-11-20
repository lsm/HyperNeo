# System map pipeline routes

Run `bash .claude/skills/verify/system-map-routes.sh` from the repository root
with Bun 1.4.4 on PATH. It prints the real exported runner's ordered stages,
checks an unavailable export, and lists the source-scan coverage. The wrapper
also checks typed inline chains, expression preambles, early returns, optional
calls, and direct and re-entrant queue callbacks with the strict classifier.
It exits nonzero if a check fails. The strict classifier is not yet wired into
the source-scan command; this is construction proof rather than CLI proof.

For the strict registry verdict on the real source tree, run
`bun scripts/pipeline-verdict-report.ts --strict > "$RUN/verdicts.json"` and
inspect the JSON. A registered DB operation may be named by its registry key;
unregistered or ambiguous operations remain unreadable. This report does not
prove that an opaque post-pipeline callback is only a projection.
