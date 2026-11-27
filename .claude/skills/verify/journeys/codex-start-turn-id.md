# A Codex start keeps its opening turn id

A Codex Desktop `work.start` receives the opening turn's id from Desktop IPC
(`thread-follower-start-turn`) or from the shared app-server (`turn/start`). The
start outcome keeps it as `delivery.startedTurnId`, so that turn gives its todo
even when the rollout read finds no receipt. An app-server opening turn without
an id is not confirmed.

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-start-turn-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/codex-start-turn-id.ts 9391 "$RUN"
```

A real isolated daemon runs the MCP operation `neo.todo.add` with a
`codex-desktop` start target three times, then prints three PASS lines:

- With the synthetic Desktop IPC peer listening, the start creates the thread on a
  fake bootstrap `codex app-server` (`$RUN/bin/codex`, set via `CODEX_CLI_PATH`)
  and Desktop answers the opening turn. The rollout has no path, so there is no
  receipt. The recorded `work_delivery_inputs` outcome still has
  `delivery.startedTurnId`, and the coding pack's `own(todo)` returns that turn
  and not a later one.
- With the IPC socket removed, the start runs on the synthetic shared app-server,
  whose `turn/start` returns a turn id. The outcome keeps that id in the same way.
- When that `turn/start` returns no id, the todo does not start, and the outcome
  records `turn/start returned no turn id`.

`$RUN/bin/open` replaces the peer's refusing stub with a logger, so the
`codex://threads/<id>` link the start opens goes to `$RUN/evidence/open.log`.
Nothing reaches the real Codex app, its state or a provider. `$RUN/evidence/`
keeps `observed.json` and the bootstrap calls.

The turns are recorded directly with `recordWorkTurns`; reading a real rollout
is not covered here.
