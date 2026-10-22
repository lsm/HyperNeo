# Todo facts step 1: pin current removal behavior

This is a contract-only slice before the core/pack split and recompute cut-over.
It adds no production or schema behavior. Keep the existing completion, stale
check, resume and delivery contracts; do not pin an old inference heuristic or
ladder as the replacement design.

Read SKILL.md shared isolation setup. Pick a free non-8399 port (9443 below):

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-current-pin-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PIN_REMOVAL=1 \
  bun .claude/skills/verify/todo-stop-recheck.ts 9443 "$RUN"
```

The opt-in flag extends the existing stopped-worker journey. It owns a synthetic
Codex state DB/transcript, Unix-socket app-server peer, GitHub refusal stub and
real test daemon. No GUI, real HOME/DB, credentials, provider or live mutation.
All original assertions remain: resumed activity and a sibling start clear
worker blocks; an unchanged stopped worker stays blocked with prior reports.

Additional assertions drive the real MCP `neo.todo.remove` operation. Its todo
shares the sibling worker reference but must stay removed when that worker starts
new work, after driver refresh, and after closing/restarting the actual daemon.
The removed row/history stays present. Its complete 152,000-byte report must have
the same SHA-256 before removal, after worker reuse and after restart. No new
turn/start may occur on restart. Actual `neo.snapshot` RPCs and operation replies,
peer calls, report hashes and restart evidence live in `evidence/observed.json`.

The helper also records max event-loop lag, snapshot RPC latency, removal MCP
handler duration, interval-sampled RSS and main SQL summaries/slow events over
fixture setup through cleanup, including both daemon starts. It refuses a SQL
measurement with zero observed executions: no samples mean unavailable, not a
0 ms pass. Report sample/retention limits and all misses against 1 s/250 ms; this
Pin slice claims no performance improvement. Sampled RSS is not an OS high-water
mark. Keep earlier incomplete runs as evidence rather than replacing them with a
success claim.

CI-only unit contracts additionally cover removal pruning only its start-question
choice, duplicate removal refusal, worker-stop refusal leaving the full todo
unchanged, and rejected start/continue/retry of removed work after database reopen.
Run no suite locally. No existing assertion is weakened. Daemon, WebSocket and
synthetic peer close in finally; retain evidence and remove the worktree only
after PR merge/close. Live deploy readback uses `hyperneo build`, never port 8399.
