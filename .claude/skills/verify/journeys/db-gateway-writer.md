# Daemon writes run on the DB gateway's single writer

Use a fresh synthetic run, with no provider, real HOME, real DB copy, GUI or
port 8399. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-db-gateway-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/db-gateway-writer.ts "$RUN"
```

Expect six `ok` lines: session-event ingest commits once and dedupes, the
Claude feed purge deletes in batches and keeps the Codex row, a job claim sent
during the purge completes on the same writer, cleanup keeps young jobs, a
Claude Desktop outbox prompt and its mailbox report commit together, and a
bridge exchange journals its event and hands out that prompt.
`scripts/deno-smoke.sh` runs the same ops under Deno in CI.
