## Claude Desktop delivery: direct, fresh receiver mode, stopped auto turn

Read shared `SKILL.md` first. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-delivery-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/claude-delivery.ts 9383 "$RUN"
```

The helper owns an isolated daemon and RPC socket, a synthetic private Claude
inbox socket, and the synthetic `claude-b1-cli.ts` fixture. It reads no real DB,
credentials, Desktop records or settings and drives no GUI. Allow about three
minutes: held direct messages exercise the production confirmation deadlines.
It closes its sockets and daemon in `finally`. The older `claude-b1.ts` command
is an alias to this current journey.

Check `evidence/observed.json` and `native-events.jsonl`:

- `work.start` prepares and imports one worker in auto. A live target receives
  directly, including its initial task: the work.start receipt must match the
  initial inbox frame UUID and no initial relay may be spawned. It never opens
  a desktop-wake helper.
- After an unconfirmed direct input, the synthetic receiver's Desktop mode
  changes while the daemon is waiting. For auto, default and acceptEdits, the
  retry relay runs in auto; for bypassPermissions it runs in bypassPermissions.
  Each returned receipt identifies the completed target exchange. This must
  use a fresh metadata read, not the record loaded before the first send.
- If the relay also refuses, the returned `not_delivered` names the receiver's
  current mode and the relay reason. A mere socket write is not proven delivery.
- Two sends to the stopped imported target run `claude -p --resume` in auto,
  return confirmed receipts and create no helpers or additional Desktop imports.
  They never request a Desktop warm spawn, which can be refused at its cap.
- The existing synthetic rc-toggle, also in auto, receives its native RC
  request and sets the target's RC field. It is never replaced or granted new
  permissions. This synthetic result is not proof of a live phone connection.
- The synthetic global settings sentinel remains unchanged.

The focused `claude-remote-control.test.ts` and `claude-desktop-adapter.test.ts`
contracts cover ownership refusal, receiver-mode retries, error details,
headless input receipts, and retention of existing authorized rc-toggle.
Historical native-message receipt decoding remains covered for earlier sends.

Real Desktop permission-mode and governor behavior requires an explicitly
human-authorized real-route check. Synthetic evidence does not establish live
rendering, phone delivery or that the installed Desktop will start a process.
Never restart the live daemon, automate the GUI or change global settings as
part of this journey. Deployment and the final live check belong to Neo and
the coordinator for this fix.
