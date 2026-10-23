# Session writes reach the session list (DB-off-main, sessions table)

Read shared SKILL.md setup. This journey drives the real RPC door of an isolated
`launch.sh` daemon: synthetic HOME/data/DB, no model turn, no keys, no GUI, never
port 8399.

```bash
RUN=$(mktemp -d /private/tmp/hn-session-write-XXXXXX)
.claude/skills/verify/launch.sh 9317 "$RUN"
VERIFY_PORT=9317 bun .claude/skills/verify/session-write-live-query.ts "$RUN"
.claude/skills/verify/stop.sh "$RUN"
```

The helper subscribes to `sessions.list` the way the web sidebar does, then
creates a session in a temp folder, renames it with `session.update` and
archives it. Each write must show up as its own live-query delta (added, updated
with the new title, removed), and `session.get` must return the new title right
after `session.update` replies. Exit 0 means all of that held. The checks and
every delta are kept in `evidence/session-write-live-query.json`.

Run it on every step of the sessions-table move: the async-facade PR, the caller
PRs and the gateway switch. A missing or stale delta means a change notification
fired before its write landed.

Before the gateway switch, every session write must be awaited or explicitly
handed off with a `.catch`, since a write that fails after the switch can only
reject. List the ones that are not:

```bash
bun .claude/skills/verify/session-write-awaits.ts
```

It type-checks `packages/daemon/src` and prints each un-settled call of the
`Database` session writers, and of wrappers listed in the script, with its
enclosing function. Exit 0 means none are left. Add a wrapper to its list when
it starts returning the write's promise.
