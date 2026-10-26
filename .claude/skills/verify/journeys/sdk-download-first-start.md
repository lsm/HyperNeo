## First start downloads the Claude Code binary without blocking the daemon

A compiled HyperNeo binary has no `node_modules`, so on a fresh data dir its
warmup downloads the platform `@anthropic-ai/claude-agent-sdk-*` package from
the npm registry (real network, no credentials). Build and run:

```bash
make build && make compile
.claude/skills/verify/sdk-download-first-start.sh \
  "$PWD/dist/bin/hyperneo-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/')" \
  "$RUN" 9411 9412
```

`$RUN` must be a fresh absolute directory; neither port may be 8399. The helper
starts the binary and the local model mock (`neo-model-settings-mock.ts`) from
`env -i` with a temp HOME, `HYPERNEO_DATA_DIR` and DB inside `$RUN`. As soon as
the log says `[SDK] Downloading`, it registers the mock provider over RPC,
creates a session and sends it a message.

Pass: the binary is downloaded, the log has no `Event loop blocked for` line,
and the session sent during the download gets an `assistant` row once the
binary is ready. The old synchronous download fails with an ~8 s block and
cannot take the message until the download ends. Evidence in `$RUN/evidence/`:
`daemon.log`, `session-messages.txt`, the RPC replies. A failed download giving
one clear session error is covered by the resolver unit tests, not this journey.
