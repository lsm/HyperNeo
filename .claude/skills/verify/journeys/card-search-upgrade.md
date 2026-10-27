# Existing cards become searchable after a real daemon upgrade

Use the shared metadata-only wrapper on a clean, committed, owned checkout:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/card-search-upgrade.ts
```

The helper reuses this checkout and its installed dependencies. It temporarily
selects origin/dev, boots an isolated daemon on an OS-chosen port and seeds two
asks, a todo and an answered question. It then selects this branch and boots
the same database twice. Finally it always restores the original branch.
No baseline worktree, web build, model mock, provider or real database is used.

Pass: the baseline has no card index. Upgraded startup backfills all four cards
and twelve triggers; FTS integrity passes. Real raw writes move the todo's ask
attribution and update the question's indexed answer/timestamp. Old terms stop
matching. The second upgraded start preserves identical index schema and rows.
The helper owns each daemon and closes it in finally. The shared wrapper saves
observed.json, the index snapshots and logs, then deletes the synthetic data.
This verifies migration and index upkeep; the subsequent search operation and
web search UI belong to their own slice.
