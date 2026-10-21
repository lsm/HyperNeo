## Complete stored worker reply (handoff PR3)

```bash
RUN=$(mktemp -d "$PWD/.verify-work-read.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-work-read.ts "$RUN" 9363
```

Use a fresh directory and a free non-8399 port. The real SDK invokes `work.read`
over MCP against an isolated SQLite database and a loopback scripted model.
A synthetic 198,001-byte report lives only in SDK body storage, behind 30 later
follow-ups; no search-index row exists. Neo/internal and archived session reads
must return `not_found` through the same MCP door, without exposing their
synthetic private text. Linked archived tasks and terminal tasks older than the
shared 30-day TTL must also return no body, using each SDK row's task ID rather
than session-name inference. The helper follows the returned cursors
and checks exact UTF-8 byte length and SHA-256, hidden-thinking exclusion and
unchanged SDK/body rows. A retracted legacy message without an SDK UUID must
stay hidden when its replacement edge targets the stored message ID. The proof also
follows textless older pages until `complete`, rather than `reply_unavailable`.
A malformed stored SDK body is skipped without losing healthy report text or
rewriting the corrupt bytes; unit coverage also exercises predecessor context.
`evidence.json` records the page count and maximum
observed event-loop lag against the 1 s goal. Text pages budget serialized UTF-8
bytes so the SDK does not replace the tool result with a persisted-output stub.
`textOffset` counts UTF-16 code units; concatenate chunks of the same message ID
in cursor order, then follow older-history cursors if needed. Availability
reports paging completeness, not whether a task is finished or its todo answered.
Result deduplication uses the selected page and at most 16 preceding records; a
distinct visible result stops substitution. Unscanned history stays on the cursor,
so a long tool-only prefix does not cause an unbounded synchronous backward scan.

This proves the SDK/MCP read interface, not todo attribution (PR4) or GUI rendering.
File references remain descriptors; their contents are read and hash-checked
through `handoff.read`, with PR1's same-user trust boundary unchanged.
The helper closes its SDK stream, mock HTTP server and SQLite in `finally`.
Preserve evidence outside the worktree and remove only its synthetic run afterward.
