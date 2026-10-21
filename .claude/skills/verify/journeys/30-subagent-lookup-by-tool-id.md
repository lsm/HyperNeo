### Subagent lookup by tool id (journey 30)

A page's subagent rows must be read by tool id, not by walking the session:

```bash
bun .claude/skills/verify/subagent-lookup.ts 45000 10
```

The script builds a synthetic session (45,000 rows by default, with 10 tool uses on the last page) and installs the live laptop's `sqlite_stat1` figures for `sdk_messages`. It then times the subagent lookup inside `getSDKMessages` and prints its plan. It runs on Bun's SQLite, the planner the daemon uses; Vitest's `node:sqlite` plans differently. End state: the plan seeks `(session_id=? AND parent_tool_use_id=?)` (the covering `idx_sdk_messages_session_visible`), and the lookup takes about 0.1 ms. Before the `ORDER BY +timestamp` hint, it walked `idx_sdk_messages_session_timestamp_id` whenever a page had two or more tool uses: about 7.4 ms on warm synthetic rows, and 234–2,734 ms on the live disk.
