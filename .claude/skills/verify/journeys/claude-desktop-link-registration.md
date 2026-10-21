## Claude Desktop link registration

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-link-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/claude-desktop-link.ts 9383 "$RUN"
```

Use fresh synthetic HOME/data and a free non-8399 port. The real isolated daemon
calls a synthetic CLI that records the first input and remains busy. Public
`work.start`, `work.status` and `work.find` must omit the Desktop epitaxy link and
return `watchHint` directing Neo to `work.status` while no Desktop record exists.
The helper then writes a synthetic Desktop-store record and repeats find/status:
the link must appear and the hint disappear without restarting the daemon. CLI
exit or a requested Desktop handoff alone is not proof of Desktop registration.
On the reproduction commit the same journey fails on the premature start link.

`evidence/observed.json` retains every operation reply. The helper closes the
socket, stops all fixture worker PIDs and cleans up the daemon in `finally`.
Both `claude` and Desktop-launch `script` are stubbed, as is `gh`; no real CLI,
provider, auth/token files, human sessions, GitHub or GUI is used. This proves the
public response and record-discovery transition, not the live Desktop UI's import,
account access or restart behavior. For a supervised live check, have the human
observe the running CLI-only session in Neo, then after a genuine Desktop import
ask Neo to refresh find/status and have the human open the returned link. Do not
resume a second owner of a still-running CLI session, automate the GUI or restart
the human's Desktop app as part of this journey.
