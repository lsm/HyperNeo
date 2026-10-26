# Session title admission through the writer

Run `lane-b-session-title-enqueue-writer.ts` with Bun and Deno in a fresh synthetic
run under env -i, NODE_ENV=test, disposable HOME and HYPERNEO_DATA_DIR. The helper
owns an ephemeral daemon, stops and drains its processors, and defers unrelated
synthetic jobs. It never reads credentials or starts a provider or model turn.

Publish the real persisted-message event with workspace initialization disabled,
then enabled, while refusing main-connection job insertion SQL. No title job is
admitted for the former; one durable job with the original payload and two retries
is admitted for the latter. A synthetic manual rename has already won when the
job executes: load the session through RPC and tick the daemon's real registered
processor. The job completes and the RPC session title remains the human's title.
Health RPCs bracket the path. Baseline evidence must fail on main insertion;
fixed Bun and Deno evidence must show zero main insertion attempts.

Save evidence/session-title-enqueue-writer.json before deleting the owned run.
Focused tests cover receipt waiting before draft cleanup, unavailable writers,
rollback and existing session-manager behavior. Model-based title generation,
worktree branch renaming, UI, production startup, worker death, contention and
large-payload latency are unverified.
