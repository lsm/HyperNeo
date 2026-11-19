# System map pipeline routes

Run `bash .claude/skills/verify/system-map-routes.sh` from the repository root
with Bun 1.4.4 on PATH. It prints the real exported runner's ordered stages,
checks an unavailable export, and lists the source-scan coverage. The wrapper
also checks typed inline chains and an optional call with the strict classifier.
It exits nonzero if a check fails. The strict classifier is not yet wired into
the source-scan command; this is construction proof rather than CLI proof.
