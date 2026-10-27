# Local ownership doors stay open for read doors and refuse by name

Build web and use Launch in the verify skill with a fresh synthetic run
directory and a free non-8399 port (also not 8000 or 9383 while orphaned
verify processes hold them). In the same shell, stop with
`.claude/skills/verify/stop.sh "$RUN"` on an EXIT trap, then run:

```bash
node .claude/skills/verify/neo-local-ownership-doors.mjs 9385 "$RUN"
```

The helper drives the real daemon over the RPC door as the local user.
daemon.session.inspect returns excerpts for the live Neo session,
neo.project.move still refuses the Inbox by name (not by role), and
goal.session.create/list work for a named owner. Evidence:
evidence/neo-local-ownership-doors.json.

No model/provider calls, credentials, live DB, desktop GUI or port 8399
are used. The worker-session cuts (goals, tree moves, asks, inspection)
are covered by the registry-level suites in goal-session-operations,
neo-project-tree, neo-ask-record and session-inspection tests.
