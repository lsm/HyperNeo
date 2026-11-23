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
sessions only on request. Remote sessions and subagents must stay out of the
result. A live WAL must remain unchanged. This proof checks discovery without
an account. Creating or controlling a signed-in session needs an attended run.

Read the synthetic session's newest reply and page back to the user's input.
Open the returned input ID with one following message and observe both messages
without changing the JSONL. Cursor's desktop transcript omits timestamps, so
the reader returns zero for their numeric timestamp.
