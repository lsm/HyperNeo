# Standalone Neo goal storage

From the worktree root, run with a fresh synthetic HOME, data directory and DB:

```bash
RUN=$(mktemp -d /private/tmp/neo-standalone-goals-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/neo-standalone-goals.ts "$RUN"
```

The helper owns an ephemeral loopback daemon, stops background jobs, refuses all
GitHub calls with a stub and uses no model or keys. It calls the public WebSocket
operation door to create and read a goal, retry one journal run, compact ten
entries, complete and reopen the goal, and read its restored 15-minute cadence
and nudge interval. It restarts only its own isolated daemon and reads the same
goal and journal again. One goal-linked ask is a synthetic repository fixture;
its association must survive the restart. It is not an agent-created ask proof.

Pass: `evidence/neo-standalone-goals.json` retains the RPC receipts, zero Space
goals/events, ten journal rows, compaction cursor 10, the same reopened goal,
retained ask link, and no foreign-key violations. Both daemon instances close in
finally. Before the fix, the public create succeeds but the storage assertion
fails with one Space goal/event and no `neo_goals` table.

Run the G8 journey (`goal-what-works-g8.md`) as well: compaction must retain every
journal entry and confirmed mandate edits must still require the existing human
path/content-hash gate. No Space event is written by Neo goals.

From `packages/daemon`, run:

```bash
bunx vitest run tests/unit/1-core/operations/neo-goals-migration.test.ts \
  tests/unit/1-core/operations/neo-standalone-goals.test.ts \
  tests/unit/1-core/operations/goal-session-operations.test.ts \
  tests/unit/4-space-storage/storage/neo-conversation-wakes.test.ts
```

The upgrade fixture preserves 266 synthetic asks, their parent/todo/question
links, rowids, indexes, triggers, genuine Space goals/events and legacy Rooms
goals. Nonempty legacy session goals/journal or invalid goal links must refuse
without changing schema/data or marking migration 444 complete. Wake title and
journal additions stay visible through the existing conversation reader.

A real autonomous goal run and GUI are not exercised here. Before publishing,
recheck migration-number 444 against dev and all open PRs and read live row counts
only: if a legacy session goal/journal appears, preserve it and stop for an
explicit migration decision. Never empty a table to make migration succeed.
