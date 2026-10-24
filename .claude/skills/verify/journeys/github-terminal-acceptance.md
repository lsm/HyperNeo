# Terminal events await durable session-mailbox acceptance

Use shared isolation in `../SKILL.md`, with a fresh run directory:

```bash
RUN=$(mktemp -d /private/tmp/hn-terminal-acceptance-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-terminal-acceptance.ts "$RUN"
```

The helper starts its own daemon on an ephemeral loopback port, stops its job
processor and seeds only its synthetic DB. A temporary trigger rejects the
terminal event's mailbox insert. Publishing through the daemon's event bus must
fail, retain the subscription and create neither a job nor an acceptance receipt.
After removing the trigger, retry the same persisted event: one mailbox job and
receipt survive, then the subscription is removed. Re-registering and routing
again, including after restart, must not duplicate the job. Canonical event
history remains intact.

Inspect `evidence/terminal-acceptance.json` and the captured daemon log. This proves
durable queue acceptance through real app wiring, not worker consumption or
automatic terminal-event replay. No model, GitHub, real keys, auth files, live DB,
GUI or port 8399 is used. All owned daemon resources stop in finally.
