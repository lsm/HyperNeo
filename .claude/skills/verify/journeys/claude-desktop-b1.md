## Claude Desktop B1 option B: prepare, import, native message

Read shared `SKILL.md` first. From the worktree root, use a fresh run directory
and free non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-b1-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/claude-b1.ts 9383 "$RUN"
```

The helper owns an actual isolated daemon and WebSocket RPC connection. `claude`
and the Desktop handoff are synthetic CLI fixtures; `gh` refuses all calls. No
real provider, credentials, app, GUI or live DB is used. The fixture emulates
native import and tool delivery; this is not proof that a real model calls the
native tool correctly.

Check `evidence/observed.json` and `native-events.jsonl`:

- The creating CLI receives only the preparation prompt, with tools disabled.
  Its exit precedes Desktop import. No actual task is executed in that process.
- Import records `acceptEdits`. Start/find/status carry that actual mode and a
  registered link, without claiming it matches bypass Neo. The Haiku relay
  explicitly uses the forwarding helper's actual permission mode.
- The native message contains the complete task, including quotes, emoji and
  all lines. Its target user-input ID is the returned task receipt. A helper's
  reply or relay acceptance alone is insufficient. Follow-up work also uses
  native messages; there is no task `--resume -p` fallback.
- A live CLI or unknown target owner refuses before any helper request. A
  dormant imported Desktop record remains eligible for native cold-start;
  focused contracts also reject ambiguous live ownership.
- The existing authorized synthetic `rc-toggle` receives the RC request. No
  replacement RC helper is created or granted permissions. A request is not
  proof of a connected RC session or phone rendering.
- A native permission wait is immediately visible as `needs_you`, with
  `waitingFor: permission prompt` and `permissionMode: acceptEdits`. Native
  refusal and failed import reject without headless fallback or approval.
- The native session record and global `defaultMode` sentinel are unchanged
  by task delivery. The helper closes its socket and daemon in `finally`.

The standalone-clone journey uses the same fixture, preserving the prepared
checkout and cleanup contracts through the new handoff.

For a task-authorized native check, use only a throwaway project/session and the
existing authorized `rc-toggle`. Do not drive the GUI, read credential files,
edit native session records or change global settings:

1. Run the real tool-less preparation and legal `--desktop --resume` handoff;
   record CLI exit, native list registration and actual imported mode.
2. Ask the forwarding Haiku helper to call native `send_message` for a harmless
   unique marker; verify the native tool call and the target's input/reply.
3. Ask existing `rc-toggle` to enable RC and retain its native tool result.
   Distinguish `on` from requested/pending/refused; never approve a prompt.
4. Have the human confirm that same target/marker on their phone. Label this
   human confirmation separately from the agent's native readback.
5. Stop only the test-owned processes and retain their records and transcripts.

Historical native evidence is local, outside this repository, under
`/private/tmp/neo-claude-b1-native-check/evidence/`. The human confirmed phone
visibility of probe `b19fce90`; do not transfer that assertion to a different
session. Re-run against the installed versions when validating native behavior.
