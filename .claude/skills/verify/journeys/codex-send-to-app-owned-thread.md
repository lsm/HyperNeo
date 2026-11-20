# A send to a Codex thread the Codex app holds refuses plainly

The ChatGPT-hosted Codex app keeps each open thread on its own app-server, which
holds that thread's writer lock, and it does not serve Desktop IPC. HyperNeo then
reaches only the shared app-server. There `thread/resume` refuses with "already
has an active writer". Input queued through the shared server is never started by
an idle owner, and the shared server cannot start it. So HyperNeo cannot deliver
to that thread, and it must say so instead of reporting a queued message.

Use the shared isolation rules in `../SKILL.md`. Pass the Desktop-bundled Codex
executable:

```sh
CODEX_CLI_PATH=/absolute/codex-executable NODE_ENV=test \
  bun .claude/skills/verify/codex-active-writer-probe.ts
```

The probe uses a throwaway `CODEX_HOME` with no credentials and a local stub
model that only records requests. It starts a shared app-server on a unix socket
and a second app-server that creates and names a thread, so the second server
holds the writer lock. Expect six `PASS` lines and `failed=0`:

- the shared server's resume is refused for the active writer,
- input the shared server queued gets no model request from the idle owner,
- the shared server cannot run `thread/queue/start`,
- as a control, the owner's own `thread/queue/start` reaches the stub model,
- production `queueCodexMessage` returns `not_delivered` with `notSent: true` and
  a detail that starts "The Codex app has this thread open",
- nothing waits in the owner's queue afterwards.

Before the fix, the send failed with the raw `thread/resume` error. A version that
queued past the refusal returned `ok: true`, but the queued message never ran.
Steer, compaction and archive on such a thread are covered by unit tests: steer
is refused as not sent, and compaction and archive report `busy`.
