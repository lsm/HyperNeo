# Durable delivery inputs (slice 2)

Run from the worktree root with a fresh synthetic HOME/data directory and a free
non-8399 port. Helpers remain in `.claude/skills/verify/`.

```bash
RUN=$(mktemp -d /private/tmp/hn-delivery-inputs-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/dispatch-evidence.ts 9387 "$RUN" --obligations
```

The actual daemon MCP `neo.todo.add` and `neo.todo.continue` paths use production
Codex and Claude CLI adapters with synthetic Unix-socket peers. Before accepting
turn-start, steer or inbox input, each peer reads only the synthetic SQLite database
read-only: an accepted input with exact target/instruction, sender, unique ID and
initial 30-second acknowledgement deadline must already be committed, with no
outcome yet. After dispatch, the correlated adapter outcome is attached.

The helper closes/restarts the daemon and requires every original input, deadline
and outcome to remain byte-identical. Continue adds another input rather than
replacing the first. The final read-only DB reopen retains both the earlier turn-start
acknowledgement and the newer steer acknowledgement. Old slice-1 assertions still
cover unconfirmed acceptance and latest-send evidence. Full operation replies,
pre-effect reads and reopened records are in `evidence/observed.json`. All peers,
sockets and daemons close in `finally`; no provider/model, real app/CLI, credential
file, live data, unattended GUI or port 8399 is used.

On the original regression commit the tool receives input and the todo is doing, but the
pre-effect read has no delivery-input record, so this journey fails. Focused
`neo-todo-runner` contracts also require storage failure to prevent external
start/send and a thrown dispatch to retain an unresolved input. The
`work-delivery-inputs.test.ts` storage contract proves actual close/reopen,
queue acknowledgement retention, first-outcome immutability, repeatable migration, remote target identity, bounded
due reads and exact deadline boundaries. Run `check:db-schema-parity` too.

This is a record-only ingestion slice. The deadline is durable evidence for later
classification, not an active timer: no replay, expiry notification, owner proof,
terminal-state inference, historical backfill or UI change is claimed. Returned
start time is adapter evidence, not independently verified worker output. The due
query exposes candidates without deciding whether an acknowledgement resolves an
obligation; that policy belongs to the later supervisor slice.

Current Codex auto mode starts an idle turn instead of silently queueing it. The
synthetic peer returns its turn ID; that acknowledgement must survive restart
with the existing session baseline unchanged. Explicit queue metadata remains covered
by the focused storage and driver contracts.
