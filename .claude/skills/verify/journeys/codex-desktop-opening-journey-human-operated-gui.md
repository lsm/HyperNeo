## Codex Desktop opening journey (human-operated GUI)

Use `env -i HOME="$HOME" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin"
NODE_ENV=test bun .claude/skills/verify/codex-start.ts <action> "$RUN"` with a fresh
absolute temporary run directory. This helper starts no HyperNeo daemon, reads
no credential file, and never opens or drives a window. The installed Codex app
uses its own existing login for the single verification turn.

1. Run `prepare`. It uses the production adapter to create and name a sacrificial
   thread, captures its opening request, and deliberately pauses before handoff.
   `prepare-result.json` reports this intentional unconfirmed turn. `opening.json`
   records the actual text input; `text_elements` must be `[]`.
2. The human opens the printed `codex://threads/...` link in the already running
   Desktop. Run `start` only after that thread is open. It submits the captured
   request through the same native IPC follower-start interface as the driver,
   without an automatic `open` command. Do not restart Desktop.
3. The human checks that the thread displays `DESKTOP_OPENING_VERIFIED`, without
   “ChatGPT hit a snag”, and reports the result. Run `observe` to preserve the
   thread metadata and latest turn in `observed.json`. An accepted IPC request,
   backend completion, or a pure input-consumer check does not prove GUI success.
4. The human may archive only this verification thread afterward. Retain the JSON
   evidence and the human's result in the PR. Before the fix, the opening request
   lacks spans and Desktop's live turn continuation reader calls `.some` on
   undefined; reloading persisted history can conceal this failure.
