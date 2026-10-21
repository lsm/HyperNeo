## Codex Desktop work.send journey

Codex work.send steers a Desktop-owned running turn. This journey uses
the real native IPC and the `invokeOperation` door used by Neo; it does not
automate the GUI or start a HyperNeo daemon. Use only a sacrificial thread
in a fresh temporary workspace, never a human's working thread. Run helpers
with `env -i HOME="$HOME" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin"
NODE_ENV=test bun .claude/skills/verify/codex-send.ts <action> "$RUN"`.
`prepare` creates and names the verification thread via the existing
app-server, archives/unarchives only that new empty thread to release its
runtime lock, and uses the existing Desktop handoff once. An unsubscribe
alone can leave the runtime loaded; a handoff failure is not a steer pass.
`start` starts another turn on that same Desktop-owned verification thread
via IPC without opening a window. Immediately run `send`, then `observe`
after the reply. End state: `send-result.json` has `delivered: true`, a
`steeredIntoTurnId` and no `queuedSubmissionId`; `acceptance.json` confirms
the matching turn completed with the requested token. On the old code,
`send` fails with a queue receipt and the token appears in a later turn
whose trigger is `queue`. `stop` interrupts only the verification thread
if cleanup is needed. No credentials are read; the installed app handles
its existing authentication. Keep the JSON evidence and state that GUI
rendering was not verified. After the turn completes, `fallback` confirms
an idle Desktop thread starts a new turn and returns `startedTurnId` without a queue receipt.
Do not run this live journey when the task authorizes synthetic peers only; use
`codex-send-intent-through-a-synthetic-daemon.md` instead. Unit tests use fake
sockets and run in CI.
