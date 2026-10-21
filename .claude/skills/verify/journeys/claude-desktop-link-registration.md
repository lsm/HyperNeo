## Claude Desktop link registration

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-link-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/claude-desktop-link.ts 9383 "$RUN"
```

Use fresh synthetic HOME/data and a free non-8399 port. The real isolated daemon
calls a synthetic `claude` that behaves like `claude -p`: it writes each turn to
the transcript with `entrypoint: sdk-cli` and its permission mode, records it in
`evidence/cli-inputs`, and exits. `claude agents` lists nothing, as real Desktop
runs no process for an imported, unused session. The Desktop-launch `script` stub
fails, so Desktop never imports the session.

Public `work.start` must run the task itself as the first CLI turn, in the
worker's mode (`bypassPermissions Synthetic task only`), and return `running`
with no link and a `work.status` watch hint. `work.status` and `work.find` show
no link either. The helper then writes a synthetic Desktop-store record that, like
real Desktop, relabels the session `acceptEdits`, and repeats find/status. The link
must appear without restarting the daemon.

Next, `work.send` to that idle session must be delivered as a `claude -p --resume`
turn in the mode Neo started it in (`bypassPermissions Synthetic follow-up`).
Finally, a human-created session (its first turn came from `claude-desktop`, and
it is in `acceptEdits`) must return `unreachable` with its Desktop link, and must
never run headless.

`evidence/observed.json` retains every operation reply. The helper closes the
socket and cleans up the daemon in `finally`. Both `claude` and the Desktop-launch
`script` are stubbed, as is `gh`. No real CLI, provider, auth/token files, human
sessions, GitHub or GUI is used. This proves that starts and idle sends run with
no click, the permission-mode rule, and the record-discovery transition. The real
Desktop import and Remote Control are proven only by the human's hand test with
a throwaway session. Do not automate the GUI or restart the human's Desktop app
as part of this journey.
