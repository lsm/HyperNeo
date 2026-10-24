# Coding manual merge preparation (build slice)

Use shared isolation in `../SKILL.md`. No provider, HTTP mock, browser or model
is needed. This slice adds the coding pack's `prepareMerge` backend API; it
returns a manual command and persists a receipt but never executes a merge.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-merge-gates-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-merge-gates.ts "$RUN"
```

The helper owns two real isolated daemon instances and uses the production
assignment repository and stage-fact writer to seed exact-head results with full
refs, matching c1's validated result envelope. Author and QA intentionally share
a local ID on different daemons. Missing QA, another daemon's fact, rejected bot,
stale head, pending CI, unresolved findings and absent human sign-off all refuse
without writing an authorized receipt. A passing result returns exactly
`gh pr merge <url> --squash --match-head-commit <head>` after its final head read.
The receipt contains durable review, QA and CI references, survives restart, and
does not complete the todo or supply deployment smoke. Check `evidence/observed.json`
for `verified: true`. External HTTP throws; no GitHub merge command is executed.
Both daemon instances close in finally. Keep evidence outside the worktree.

Unit contracts additionally reject wrong actor harnesses, unbound legacy stage
facts, same-ID refs on another harness/daemon, missing bot-review evidence and a
conflicting stored receipt. Bot output cannot fall back to a reviewer session.
This verifies the build API, not live GitHub transport or the final operation and
todo-completion surface; those remain required before #8429 closes.
