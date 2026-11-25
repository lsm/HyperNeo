# Archive a thread open on the shared Codex app-server

On a test host, use Bun and a Codex executable that supports app-server on a
Unix socket. Run from the repository root after installing dependencies.

```sh
env -i PATH="$PATH" NODE_ENV=test CODEX_CLI_PATH=/absolute/codex-executable \
  bun .claude/skills/verify/codex-shared-archive.ts
```

The probe starts an isolated app-server and keeps a client attached to a
throwaway thread. It then archives the same thread through the production work
adapter. Expect two PASS lines, an archive result of `archived: true`, persisted
`archived: 1`, and exit 0. Before the fix, archive returns `busy` and the thread
stays open.
