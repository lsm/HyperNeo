# Ordered todo recompute and next-worker dispatch

Read the shared isolation rules in SKILL.md. This journey needs no provider,
model, HTTP mock or GUI. It owns a real test daemon on an ephemeral non-8399
port, a fresh SQLite database/home, a refusing GitHub PR fixture executable,
and a synthetic Codex app-server Unix socket. Its local `ps` stub reports no
running Desktop app so host GUI state cannot divert sends to native IPC. Nothing uses a real app or DB.

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-plan-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/todo-plan-recompute.ts verify "$RUN"
```

The helper seeds an ordered ask with a merged first PR and an open next PR,
then runs the actual driver-refresh job. Observe `first: done`, `next: doing`
in stored state and `neo.snapshot`, and exactly one `turn/start` received by
the synthetic worker through the real start/send path. Repeating refresh must
send nothing again. The captured first worker input (`workerRuleDelivered` in
`evidence/observed.json`) must include rule 10's 30-second PR/issue guidance,
the full-report-to-Neo boundary, public-repo privacy rule and concise issue
contract. This proves delivery to new worker context, not model compliance or
rewriting existing PRs. Completing the final todo through `neo.todo.close` sends
no further work.

With a non-start ask question open, the dispatched worker stays doing and its
unreceipted reply is not stored as a result; pending work still waits.
This synthetic app-server send returns a turn id but no input receipt. The
explicit-worker-results journey separately proves storage from matching
dispatch receipts. The helper then
pauses a real completion RPC inside its synthetic GitHub read, records a new
report, and releases the read. The RPC must return done with the complete new
report retained, rather than silently returning success with a pending todo.
The stub bounds this pause so an assertion cannot leave a child waiting forever.

Next it saves a completed predecessor with a pending successor, stops and
reopens its daemon, and repeats refresh. The saved handoff must dispatch once.
An ask with an open question must not start its later worker. The real
`neo.todo.remove` RPC removes another todo; after refresh and restart it remains
removed and its complete report bytes/hash stay identical. The predecessor's
complete report also survives restart. Contract tests additionally cover a
failed predecessor and repeated database reopen with no duplicate start.

`before` mode on the pre-fix revision observes the original failure: merged
facts mark the first todo done while the next remains pending and no worker is
dispatched. Keep that red evidence alongside the fixed run.

Evidence is `evidence/observed.json`: RPC receipts/snapshots, actual peer calls,
stored states and report hashes. `evidence/gh.log` records stub reads. The
synthetic Neo session has no provider, so delivery of its informational notes
may fail closed; this journey proves stored plan state and worker dispatch,
not model consumption of those notes. The helper closes its WebSocket, daemon
and peer in finally. Keep evidence outside the worktree, remove the worktree
after merge/close, and use `hyperneo build` for deploy readback.

## Todo question ownership and retry attempts

Add `--lifecycle` to the command above to exercise todo lifecycle RPCs on the
same isolated daemon. `neo.question.ask` must return its explicit `todoId`;
removing that todo through `neo.todo.remove` must retire the bound card after
recompute, while a general ask question remains open. Marking a previously
started synthetic todo failed and invoking `neo.todo.retry` must keep its ID,
send one new turn to its existing worker, preserve the old durable input, and
record a distinct new attempt. Restart the daemon and check that the retired
card and retry history survive. Evidence is in the same `observed.json` under
`lifecycle`. This checks the daemon RPC and snapshot surface without a model
turn; it does not claim browser rendering or model adherence to the prompt.
