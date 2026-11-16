# Docs-only changes skip code checks

`scripts/lib/inert-docs.sh` defines inert docs: Markdown and plain text under
`docs/`, and top-level `*.md`. Paths are read NUL-delimited, so non-ASCII names
match. The CI Path Filter and the pre-commit hook both use it.

Hook: run `bash .claude/skills/verify/docs-only-hook.sh`. It makes real
commits in a throwaway repo with the hook installed and a `bun` stub that fails
when called. Expect the docs-only commit to exit 0 with zero bun calls, the code
commit to be refused after `bun run lint`, and `result=pass`.

CI: open a pull request that changes only inert docs and read
`gh pr checks <number>`. Expect Path Filter and All Tests Pass to succeed and
every other job, including Lint, Knip, Format & Type Check, to be skipped.
A pull request touching any other path still runs the check job.
