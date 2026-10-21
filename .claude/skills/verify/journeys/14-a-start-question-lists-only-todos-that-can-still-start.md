14. **A start question lists only todos that can still start.** After journey 1
    opened root, run `.claude/skills/verify/seed-start-question.sh "$RUN"`. It
    writes `ask-prune` with two todos awaiting start, `todo-a` (check
    `pr_merged` on `verify-test/demo#8`, which reads as `MERGED`) and `todo-b`
    (no check), and one open start question `q-start` listing both. End state
    within ~3 min: `todo-a` is `done` with `started_at` empty, and `q-start`
    is still `open` with `start_todos` `["todo-b"]`.
