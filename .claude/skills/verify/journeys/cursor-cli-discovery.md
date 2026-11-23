# Cursor CLI discovery

Run the real daemon with an isolated home using the shared proof wrapper and
pinned Bun. Give each run a new evidence directory and a free loopback port.

```bash
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/fixture-evidence \
  .claude/skills/verify/cursor-discovery.ts 9387 fixture -
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/signed-out-evidence \
  .claude/skills/verify/cursor-discovery.ts 9388 signed-out /absolute/path/to/cursor-agent
```

The fixture must expose only `find`, return two distinct sessions across
pages, match a session present only on the second page with a limit of one,
and report a repeated cursor as unavailable. The installed
CLI must report that sign-in is required through `work.find` with the empty
home. Both paths use `operation.invoke` and leave the human's daemon and account
untouched. The fixture verifies the session result contract. Signed-in session
listing and native desktop sessions require a separate attended check.
