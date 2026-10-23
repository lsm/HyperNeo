## Codex worker threads remain Desktop-owned

Run from the worktree root with a fresh synthetic HOME and DB:

```bash
RUN=$(mktemp -d /private/tmp/hn-codex-ownership-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  LOG_LEVEL=warn bun .claude/skills/verify/codex-send-intent.ts ownership 9387 "$RUN"
```

The helper owns an isolated daemon and fake Desktop/shared-server Unix sockets.
Its owned bin directory must be first on PATH; it refuses to run if Bun does not
resolve `open` to the synthetic opener. No real GUI opens. The real `work.send`
RPC first reaches Desktop, which returns `no-client-found`. HyperNeo must open
that saved worker, discover its owner, and steer through it without a shared
app-server request. On the regression-first source the RPC refuses delivery
instead, and the helper fails. A confirmed idle owner starts the next turn there;
a protocol refusal remains `not_delivered` without consulting the shared server.

The same real RPC door then invokes `work.start` with an owned synthetic stdio
CLI and registered synthetic project. The opener checks that the bootstrap PID
no longer exists before granting Desktop ownership. The opening input goes only
to `thread-follower-start-turn`. A second bootstrap exits with status 7; that
request must return `not_delivered` with the saved thread ID in its detail,
without handing off or submitting an opening turn. It must not become an
`execution_failed` RPC error during cleanup. A subsequent name refusal combined
with the same exit 7 must preserve the name error, typed rejection and saved
thread ID; cleanup must not replace the first error. A bootstrap held past
the existing five-second close deadline reports that deadline explicitly and
must submit no Desktop turn after forced termination. The delayed
exit and abnormal-exit unit contracts separately pin the process lifecycle.
Keep `evidence/observed.json` and `evidence/open.jsonl`. The daemon and peers close
in `finally`. This proves routing and lifecycle through the production operation
door, not real Desktop rendering or Computer Use authentication.

Legacy shared-server release is intentionally not implemented in this slice.
The human accepted the documented idle grace; the separate release slice must
unsubscribe and show 「释放中」 while awaiting native unload. Do not
archive/unarchive human threads or restart Codex as a release workaround.

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
