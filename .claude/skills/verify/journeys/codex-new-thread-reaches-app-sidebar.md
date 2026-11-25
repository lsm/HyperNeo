# New Codex threads reach the app's sidebar without Desktop IPC

The ChatGPT-hosted Codex app adds a thread to its sidebar when its own
app-server connection hears `thread/started`. When the Desktop IPC socket is
missing or stale, `work.start` creates the thread on the shared app-server, the
same server the app is connected to. While the IPC socket listens, the spawned
bootstrap server still creates it and Desktop takes the first turn.

Run against the installed Codex CLI, with a throwaway home and no provider key:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY NODE_ENV=test \
  CODEX_CLI_PATH=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  bun .claude/skills/verify/codex-thread-started-probe.ts
```

It starts a real `codex app-server` on a unix socket in a temporary
`CODEX_HOME`, connects one client as the app and one as HyperNeo, and prints one
PASS or FAIL line per check, ending with `failed=0`:

- The IPC probe used by `work.start` reports a missing path and a stale socket
  as absent, and a listening socket as present. `python3` leaves the stale
  socket bound with no listener; if it cannot, that check fails.
- A thread created on the shared app-server sends `thread/started` to the app
  connection.
- A thread created on a spawned app-server stays unheard by the app, even after
  a `thread/resume` on the shared one. This is why such threads were missing
  from the sidebar.

No model turn runs, and nothing touches the real Codex state or app. Rendering in
the app's sidebar itself is not covered; that needs a human-operated app.
