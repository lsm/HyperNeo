## Claude Desktop link registration

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-link-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/claude-desktop-link.ts 9383 "$RUN"
```

Use fresh synthetic HOME/data and a free non-8399 port. The real isolated daemon
calls a synthetic CLI that records each input and exits, and a Desktop-launch
`script` stub that fails, so Desktop never imports the session. Public `work.start`
must run only the one-line opening turn in the CLI (`evidence/cli-inputs` holds
"Session opened by Neo…", never the task), wait its bounded import window (two
handoffs of up to a minute each), and return `needs_you` with no link and the watch hint "Claude Desktop
did not import the new session. The task was not started. …". `work.status` and
`work.find` show no link either. The helper then writes a synthetic Desktop-store
record and repeats find/status: the link must appear without restarting the daemon.

`evidence/observed.json` retains every operation reply. The helper closes the
socket, stops all fixture worker PIDs and cleans up the daemon in `finally`.
Both `claude` and the Desktop-launch `script` are stubbed, as is `gh`; no real CLI,
provider, auth/token files, human sessions, GitHub or GUI is used. This proves the
no-hidden-task rule, the bounded wait and the record-discovery transition. The
success path (Desktop imports and opens the session, then takes the task through
its inbox) is unit-tested only; prove it with the human's hand test using a
throwaway session. For a supervised live check, have the human
observe the running CLI-only session in Neo, then after a genuine Desktop import
ask Neo to refresh find/status and have the human open the returned link. Do not
resume a second owner of a still-running CLI session, automate the GUI or restart
the human's Desktop app as part of this journey.
