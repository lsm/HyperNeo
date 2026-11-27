# Recognize a design PR as a plan

From the repo root, use the shared isolated daemon setup in [Verify](../SKILL.md).

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-plan-coding.ts
```

The helper invokes the daemon's registered `neo.todo.done` operation for five
coding todos. The daemon refuses completion without steps for an open design PR
and a merged PR whose only design file is on the second page. It accepts
completion for a PR touching a neighboring directory and for a legacy design
todo. It also retries completion of the merged design PR, proving the daemon
refreshes an older cached PR observation and reuses the new classification. After
the cache expires, a failed paginated refresh on the same head still leaves the
todo subject to the plan completion gate. An ordinary PR status read skips
pagination. A first failed classification blocks completion, and a later
complete read with zero design files lets the todo finish. The fixture GitHub CLI answers only
synthetic PR reads and never uses a provider or the network. Keep `observed.json`, `gh.log`, `proof.log` and the
wrapper exit status.
