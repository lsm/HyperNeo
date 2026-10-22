# Goal what-works compaction and mandate reconciliation (G8)

Run from the worktree root, using a fresh directory for each mode and a free
non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-goal-what-works-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/goal-what-works.ts 9472 "$RUN" all
```

The helper owns its isolated daemon, synthetic HOME/Git identity and DB. It closes
all resources in finally. It uses no provider, keys, external GitHub, desktop GUI
or live DB. No browser is needed for this daemon/tool-context slice.

`all` exercises the real WebSocket operation door. A refused human mandate proposal
must leave HEAD/content/facts unchanged. A matching path/hash-bound human yes uses
the existing neo.home.save flow, produces a mandate-changed fact, and reconciliation
through goal.session.update removes it. The returned commit is journal evidence.
Facts reads must never change mandateRev or home HEAD. After ten entries, facts
must request compaction; goal.session.update worksNote must preserve all ten rows,
atomically save the note/cursor without writing Space events.

Repeat with new RUN directories and final arguments `wake` and `nudge`. These
exercise the actual scheduler fire and mailbox delivery. `wake` creates ten new
entries; `nudge` seeds only the synthetic schedule's previous facts digest with
its current real RPC digest and nudgeEvery 1. Both make that one synthetic job due
now instead of waiting an hour. The mailbox's actual model-facing daemon note
must ask Neo to read journal pages and rewrite worksNote. These fixtures do not
replace the source, fire handler or delivery handler. A later no-provider turn
failure is expected and is not autonomous-model proof.

Each mode writes `evidence/goal-what-works.json`, including exact RPC receipts or
actual mailbox payload and scheduler outcome. The test-first `all` run records
false compaction/mandate checks, a rejected worksNote input and no note/cursor.

The existing INTEGER works_note_through stores the number of retained entries
covered by the note. This avoids timestamp ties and unstable SQLite rowids; run-id
retries replace their entry and do not increment it. Unit contracts cover the
9/10 boundary after compaction, retry, same-millisecond entries, owner scope,
cursor-write failure rollback and unrelated home commits. No journal rows are removed.
Compaction quality and the choice of goal refinement remain model judgments.
