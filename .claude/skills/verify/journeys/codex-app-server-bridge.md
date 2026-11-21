## Codex app-server bridge

On macOS, run the bridge journey from the worktree root with the isolated proof
wrapper and the pinned Bun version from `SKILL.md`.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence \
  .claude/skills/verify/codex-app-server-bridge.ts verify
```

The journey boots real HyperNeo daemons with a fresh home and database and uses
a synthetic WebSocket peer on the Codex Unix socket. It verifies no listener
or token at default settings. It persists the opt-in and verifies that the next
boot refuses missing and wrong tokens before connecting upstream. An authorized
client exchanges a frame, the upstream request target carries no token, and
shutdown closes the connection and loopback listener. A subsequent boot uses
the same token and tightens the directory and file modes to 0700 and 0600. A
symlink in place of the token makes the bridge refuse startup. A busy port is
reported and the previous listener continues serving. The journey
scans daemon log events for the generated token without printing it.

For a listener-only smoke check after dependencies are installed, use the
disposable run wrapper. This exercises the production listener with the same
Unix peer, token gate, permission repairs, port conflict and shutdown.

```bash
bash .claude/skills/verify/with-run.sh bash -c '
  mkdir -p "$RUN/home" "$RUN/tmp"
  env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$PATH" NODE_ENV=test \
    HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/codex-app-server-bridge.ts listener 0 "$RUN"
'
```

Retain `proof.log` and `run-status.json`. This journey covers the bridge slice.
The design's setup, cutover, desktop, phone and reboot checks require the later
setup slice and a real Codex installation.
