# Final todo cleanup (step 6c2)

Use SKILL.md's shared isolation setup and the existing plan/lifecycle and coding
issue/nudge helpers. Each run owns a fresh HOME, data directory and database,
ephemeral daemon and synthetic Codex socket; no provider, real GitHub, GUI,
credential, live DB or port 8399 is involved.

Run `todo-plan-recompute.ts verify "$RUN" --lifecycle` before deletion and on the
exact final head. Compare persisted outcomes, complete worker inputs, dispatch
counts, report hashes and legacy claim identities. They must match, including
restart, retry, removal and next-worker dispatch exactly once. Removing the
checked-map throttle increases synthetic GitHub reads; record both counts and
make no quota-saving claim. The queued ledger work owns acquisition coalescing.

Run `coding-issue-nudges.ts verify "$RUN"` on the final head. Its existing
COMPLETED/NOT_PLANNED/open/unreadable, failure-block and persistent 20/40/60
contracts must pass. Its seeded historical card-subscription row remains stored,
but a raw CI event sends no worker frame. Next, its actual `neo.pack.sweep` jobs
read only a local GitHub fixture: a claimed PR's failing-CI transition must send
one real `turn/start` to the synthetic worker. Repeating unchanged ledger facts
sends nothing. Keep `ledgerClaimDelivery` and `rawPrEvent` in `observed.json`.

The claimed-PR unit expectation must fail before removing the old suppression
condition. Keep its committed red evidence. Run legacy completion/concurrency,
human Mark done, todo-runner, coding ledger/event and core import contracts, plus
the full repository check. Schema/history and completion gates are preserved;
no replacement idle map, routing helper or state writer is added.

Keep evidence outside the worktree with the exact head. Helpers stop owned
resources in finally. After merge verify owner-RPC ancestry for 6b2, 6c1 and 6c2,
remove the worktree and unlink the merged PR before starting the ledger lane.
