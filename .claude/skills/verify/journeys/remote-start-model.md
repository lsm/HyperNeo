## Neo starts work on an attached daemon with an explicit model and effort

Build the web bundle first (`cd packages/web && bun run build`), then run on two free
ports (never 8399) with the mock API port (8000 unless `VERIFY_MOCK_PORT`) free:

```bash
TMPDIR=/tmp/claude-501 .claude/skills/verify/remote-start-model.sh 9341 9342
```

The script starts the mock Anthropic API and two isolated daemons, A and B (`env -i`,
NODE_ENV=test, dev proxy, own HOME, data dir and database). B gets the dev-proxy key over
RPC, A attaches to B with a daemon pairing code, and A calls `work.start` with
`place.daemon: "b"`, an explicit model from B's `models.list` and effort `high`.
The run directory is removed on exit; `VERIFY_KEEP_RUN=1` keeps it and prints the path.

End state:
- A reads B's `work.adapters`: `hyperneo` is `configurable: true`, `claude-desktop`
  is `configurable: false`.
- The `hyperneo` start answers `ok: true` with B's confirmed model, effort `high` and
  `daemon: b`; B's database holds one session on that model.
- The `claude-desktop` start answers `unsupported_model` and starts nothing.
- Before the fix the `hyperneo` start also answered `unsupported_model` ("This remote
  route cannot confirm the requested model") and B held no session.
