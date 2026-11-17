# Unresolved review threads return to the author

Use the isolation and cleanup in `../SKILL.md`:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-unresolved-threads.ts
```

The helper seeds an approved, green PR and a synthetic review-thread observation
in an isolated database. The real coding-pack sweep must show `changes_requested`
with the author as owner and send a reminder containing the thread URL. The merge
gate must identify unresolved threads when GitHub reports the PR blocked. No
external GitHub or provider access is used. The helper seeds the observation; it
does not verify live GitHub collection or a live worker receiving the reminder.
Draft, conflicting and failing PRs retain those states while threads remain open.
The helper also checks that a failed thread refresh preserves a successful ledger
poll, low quota prevents refresh, and unowned cross-model review reaches Neo.
