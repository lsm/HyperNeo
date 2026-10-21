### Work-feed offsets read once (journey 31)

Work-feed polls must not re-read the offsets table:

```bash
bun .claude/skills/verify/work-feed-offsets.ts 2700 35
```

The script builds a synthetic temp DB (2,700 rows and 35 polls by default, the live per-5-minute cadence). Each poll calls `readWorkFeedOffsets`, then writes one offset through `saveWorkFeedChunk`. End state: `table reads=1` for any number of polls. Before the in-memory offsets map it printed `table reads=35`. On the live daemon, `select path, offset, size, mtime from work_feed_offsets` then appears in the `sqlite.query` summaries only in the first window after a restart.
