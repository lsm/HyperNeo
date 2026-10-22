# A stopped-session todo block clears when work resumes

Use the shared isolated environment from SKILL.md. No model/provider, real Codex
app/state, credentials or GUI is involved. The helper owns a real test daemon,
its synthetic database, and a loopback Unix-socket Codex app-server peer.

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-stop-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/todo-stop-recheck.ts 9391 "$RUN"
```

Pick a free non-8399 port. Three synthetic todos begin with the reminder ladder's
worker stop block. First, a real driver-refresh maintenance job must leave them
blocked while their synthetic Codex sessions remain stopped. Then one transcript
gets a task_started event, and the real neo.todo.add operation starts a sibling on
another worker through the production Codex adapter. A second real refresh must
show the first two todos doing, with block fields cleared and prior reports
retained; the still-stopped todo stays blocked. Real neo.snapshot RPC responses,
job receipts and peer calls are saved in evidence/observed.json. The pre-fix
helper must fail with both resumed cases still blocked. The helper closes its
WebSocket, daemon and peer in finally, retaining all synthetic evidence.

The focused neo-todo-runner suite additionally drives the actual 30/60/90-minute
reminder ladder with a controlled clock, tests activity without a new reply,
a turn finished between refreshes, a fresh ladder after recovery, and an unchanged
stop. No production stored data is trimmed or deleted. GUI rendering and live
Desktop ownership are not verified by this backend journey.
