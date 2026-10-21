4. **An open todo's PR leads the PR ledger in the snapshot.** After journey 1
   opened root, run `.claude/skills/verify/seed-ledger.sh "$RUN"`. It writes a
   project for `verify-test/demo` (so the pack sweep keeps its ledger rows), an
   open ask with a `doing` todo that owns `verify-test/demo#8` (and was once
   branch-matched to `#100`), and 120 older open ledger rows in the same repo.
   End state: `rpc.ts neo.snapshot '{}'` returns `packRows` whose first coding
   row is `verify-test/demo#8` with `todoId: "todo-ledger"`, its state and its
   owner, even though the ledger lists only its 100 oldest rows otherwise, and
   `#100` carries no `todoId`.
