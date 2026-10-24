## A second instance's work feed shows only sessions it started (workFeedScope)

Run on a free port (never 8399):

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/feed-scope.sh 9322
```

The script writes synthetic Claude transcripts (`cli-mine`, `cli-foreign`) and Codex
rollouts (`1111…`, `3333…`) under a temp `HOME`, starts an isolated daemon through the CLI
(`env -i`, NODE_ENV=test, its own data dir and DB, no provider key), and records `cli-mine`
and `1111…` in the run DB's `work_started_sessions` (what a local `work.start` writes; real
Claude/Codex starts need the apps, so that write is covered by
`tests/unit/1-core/drivers/work-feed-scope.test.ts`). It sets `workFeedScope` over
`settings.global.update`, queues the `work.feed.claude` and `work.feed.codex` jobs (the feed
is not scheduled in test mode), and reads which sessions were indexed.

End state, in `$RUN/evidence/`:
- `own.txt`: both jobs `completed`; feed sessions `claude:cli-mine codex:1111…` only.
- `all.txt`: after switching to `all`, the foreign `claude:cli-foreign` and `codex:3333…`
  appear too, as they do today with no setting.
