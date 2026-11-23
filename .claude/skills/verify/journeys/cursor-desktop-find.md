# Cursor Desktop discovery

Use the isolated daemon with pinned Bun and a fresh evidence directory:

```bash
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh /absolute/evidence \
  .claude/skills/verify/cursor-desktop-find.ts 9389 -
```

The final argument can be a file containing just the `composerHeaders` table
DDL from a fresh Cursor profile. The proof writes synthetic session rows to
its own database and never modifies the source profile.

The public adapter catalog appears as soon as the desktop index is present.
Find should show local sessions by title and workspace and include archived
sessions only on request. It must honor the result limit and still find a
session by exact ID. Remote sessions and subagents must stay out of the
result. A live WAL must remain unchanged. This proof checks discovery without
an account. Creating or controlling a signed-in session needs an attended run.

The proof then changes the fixture schema. The Cursor read must report the
schema error while a queued HyperNeo SDK read still completes.
