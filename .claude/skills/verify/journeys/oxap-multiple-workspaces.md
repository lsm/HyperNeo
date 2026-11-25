# OXAP sessions in separate workspaces

Use the shared isolation and pinned Bun in `../SKILL.md`, and the pinned OXAP
binary as in `oxap-hub-settings.md`:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oap-workspace-wire.ts /absolute/oxap RELEASE-NAME SHA256 default
```

The helper sends messages in two chats through the daemon and real hub. It
checks each adapter opens in its chat's workspace, while the separate bootstrap
app-servers check the Codex account. It also verifies queued turns, session
cleanup and recovery after a hub restart.
