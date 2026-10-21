### Notice groups reload by subtype (journey 33)

```bash
bun .claude/skills/verify/notice-select-cold.ts "$(mktemp -d /private/tmp/hn-notice-XXXXXX)"
```

The helper builds a synthetic DB shaped like root Neo (about 120k other rows, 17,000 `system`
rows and 82 `session_notices`) and runs the notice-group reload selection in a fresh `sqlite3`
connection, before and after, reporting SQLite page-cache misses: the pages a cold start must
fetch. End state in `observed.json`: the old `message_subtype` filter misses ~980 pages, the
`message_subtype_norm` filter on `idx_sdk_messages_session_subtype_parent` ~56. macOS cannot drop
the OS cache without root, so misses stand in for cold-disk time. Read-only on a live DB, the
same comparison went from 13,929 to 136 misses.
