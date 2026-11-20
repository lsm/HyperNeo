# A send reaches a Codex thread that another app-server writes

The ChatGPT-hosted Codex app keeps each open thread on its own app-server, which
holds that thread's writer lock. HyperNeo sends through the shared app-server.
There `thread/resume` refuses with "already has an active writer", but
`thread/queue/add` still queues input for the owning writer.

Use the shared isolation rules in `../SKILL.md`. Pass the Desktop-bundled Codex
executable:

```sh
CODEX_CLI_PATH=/absolute/codex-executable NODE_ENV=test \
  bun .claude/skills/verify/codex-active-writer-probe.ts
```

The probe uses a throwaway `CODEX_HOME` with no credentials. It starts a shared
app-server on a unix socket and a second app-server that creates and names a
thread, so the second server holds the writer lock. Production
`queueCodexMessage` then sends through the shared server.

Expect three `PASS` lines and `failed=0`:

- the shared server's resume is refused for the active writer,
- the send returns `ok: true` with a `queuedSubmissionId`,
- the owning server's `thread/queue/list` holds the message.

Before the fix, the send returned `not_delivered` with the resume refusal, and the
owner's queue stayed empty. With the worker sandbox on, a refused resume still
fails the send, because the worker profile cannot be applied. The probe does not
run a model turn, so it does not show the owner consuming the queued message.
