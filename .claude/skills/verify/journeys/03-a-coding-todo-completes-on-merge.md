3. **A coding todo completes on merge.** After journey 1 opened root, run
   `.claude/skills/verify/seed-todo.sh "$RUN"`. It writes an open ask for root
   with a `doing` todo whose check is `pr_merged` and whose report names
   `https://github.com/verify-test/demo/pull/8`, and a `$RUN/pr.json` that reads
   that PR as `MERGED`. End state within ~3 min (one driver refresh plus the
   2-minute check window): the todo is `done` with evidence `#8 merged`,
   `evidence/gh.log` shows the `gh pr view`, and root's transcript holds the note
   `Todo "Fix the loader" is done: #8 merged`.
   Local human `neo.ask.settle` explicitly confirms done even with unfinished
   todos (#8292). Do not call it before observing this automatic-merge proof:
   settling done closes unfinished todos as `closed_unverified`, for human and
   agent callers, and returns a `todos_unfinished` record. Those rows never count
   as done. See ask-bookkeeping-actions.md for that separate settlement proof.
   To verify PR ownership and URL edits, run
   `bun .claude/skills/verify/todo-pr-claims.ts <port> "$RUN"` on a fresh isolated
   daemon. It seeds only this run's ask, URL-less session todo and coding ledger
   claim, then uses the real `neo.todo.add/edit/remove` RPC door. End state: adding
   a duplicate succeeds and records the existing todo id/title; `addUrls` pins the PR on
   that original; a competing edit succeeds with a bookkeeping record. The helper marks the stub PR merged
   and waits up to 210 seconds for the coding pack to finish the original without
   a manual close. Evidence: `evidence/todo-pr-claims.json` includes RPC receipts,
   stored merged evidence and the Neo snapshot; `gh.log` shows stub-only lookups.
   No real PR, provider, credentials or GUI is used; model notifications use the
   local mock and this run's dev-proxy provider row. GUI rendering is not verified.
   In another fresh run, execute
   `bun .claude/skills/verify/todo-pr-concurrency.ts <port> "$RUN"`.
   It overlaps a completion check awaiting GitHub with 20 URL additions on that
   same todo. Every URL must remain in its check; the stale completion is refused
   and the todo remains open. Repeat in fresh run directories with a final
   argument `edit`, `close`, and `sweep` to cover plain completion, closure and the
   real periodic background check. Each mode pauses the local gh stub after its
   check starts, adds 20 URLs through RPC, then releases the old result. None may
   finish the todo. The sweep mode can take up to 3 minutes to begin.
   Evidence: `evidence/todo-pr-concurrency.json`.
