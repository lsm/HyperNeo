# Coding delivery evidence APIs (build slice)

Use shared isolation in `../SKILL.md`. This backend build slice has no model,
HTTP mock or browser. It exposes `prepareMerge` and `recordSmoke` on the coding
pack, without changing dispatch or todo completion. Exercise those exact APIs
in an actual isolated daemon, then reopen its synthetic database:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-delivery-proof-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-delivery-gates.ts "$RUN"
```

The helper reuses `readGithubDeploys` with synthetic merge/build ancestry effects;
unexpected GitHub commands and external HTTP throw. It never runs a merge. Check
`evidence/observed.json`: a changed head, rejected bot, author attempting smoke,
and absent deployment all refuse. A matching gate returns only a manual command
with `--squash --match-head-commit <head>`. Assigned author and QA deliberately
share a local ID on different daemons, exercising full WorkRef independence.
A smoke pass followed by a failure retains the failure after reopening the app;
an explicit docs-only inapplicability reason is then recorded. The todo remains
doing throughout: completion wiring belongs to the following slice. Historical
head receipts are preserved and never satisfy another head. Both daemon instances
close in finally. Keep the evidence outside the worktree.

This proves pack API behavior and persistence, not live GitHub transport, a real
deployment, actor dispatch, or the final gated todo completion surface. The wire
slice must add an operation-door/completion journey before #8429 is complete.
