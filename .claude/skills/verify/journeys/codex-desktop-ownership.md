## Codex worker threads remain Desktop-owned

Run from the worktree root with a fresh synthetic HOME and DB:

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-ownership-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/codex-send-intent.ts ownership 9387 "$RUN"
```

The helper owns an isolated daemon and fake Desktop/shared-server Unix sockets.
The real `work.send` RPC first reaches Desktop, which returns `no-client-found`.
The RPC must refuse delivery without making any shared app-server request. On
the regression-first commit, it instead succeeds with `server-active` and the
helper fails. This is the same routing decision observed in the affected worker's
production logs; it does not claim to render the real Desktop lock.

After Desktop confirms ownership, the same RPC steers through that owner. An
idle owner starts the next turn there. A Desktop protocol refusal must fail
without consulting the shared server. Keep `evidence/observed.json`, including
all peer calls and RPC replies. The daemon and peers close in `finally`.

The installed-app acceptance remains separate: start one disposable Codex task
through Neo, open its returned Desktop link, and confirm the composer is editable
without “This is open in another app”. From that thread, request one harmless
Computer Use read such as observing Finder; it must succeed rather than return
“Sender process is not authenticated”. Record the thread ID, request/result and
human-observed outcome. Do not infer this from an accepted IPC response. Use the
existing staged opening journey if a human needs to open the thread; do not
bypass a Computer Use tool restriction on the Codex app. Do not restart Desktop,
read credentials or change app/session databases. Existing locked live threads
are evidence, not sacrificial threads to archive or resume during this journey.

To reproduce the actual installed CLI writer conflict without using Desktop or a
model, run the sibling helper in another fresh directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-writer-lock-XXXXXX)
mkdir -p "$RUN/home" "$RUN/codex"
env -i HOME="$RUN/home" CODEX_HOME="$RUN/codex" PATH="$PATH" NODE_ENV=test \
  VERIFY_CODEX_CLI=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  bun .claude/skills/verify/codex-writer-lock.ts "$RUN"
```

It starts two owned stdio app-servers in the synthetic CODEX_HOME, creates a
thread and injects one synthetic history item without a model turn. The second
process must report `already has an active writer`; after the first process exits,
the same resume must succeed. Both owned processes close in `finally`. This proves
the native writer-lock mechanism, not GUI ownership or Computer Use authentication.
