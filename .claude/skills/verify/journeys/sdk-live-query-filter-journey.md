## SDK live-query filter journey

Use a detached checkout of the pre-slice dev head under `~/focus/worktrees/`,
install its frozen dependencies, and copy `sdk-live-query-filters.ts` into its
verify directory. In that checkout run `seed "$RUN"`, then `measure "$RUN" before`
with the helper. Use `NODE_ENV=test`, a clean temporary HOME and `env -i` as in
Launch. The fresh synthetic DB has 55,014 messages, full large tool results,
production-derived columns/renderability/terminal flags and
`replacement_metadata_normalized=1`. Its archived synthetic Space prevents
background task execution; read-only feeds still expose its task and roster.

From the branch run `measure "$RUN" after`, then `measure "$RUN" restart`.
Keep body/receipt hashes, seven read results, query plans/times and separate
startup/query maximum lag. Receipts must match before/after; the helper fails
on body changes, lag >=1 s or a query >=250 ms. It covers repository reads,
background metadata, full/compact transcripts, the task feed and active roster.
Output shaping may shorten messages as it already does; stored bodies stay full.

Launch the isolated daemon, run Doctor and then
`bash .claude/skills/verify/sdk-live-query-filters-door.sh <port> "$RUN"`.
It uses the real `liveQuery.subscribe` door for both transcript variants, task
messages and active-turn entries. Every snapshot must match the pre-change
receipt, including ordered child messages and background metadata. Evidence is
the four RPC replies plus `rpc-feed-comparison.json`. No provider or GUI is used;
GUI rendering is not verified. Keep the launch shell alive through the helper
and stop the daemon/mock before it exits. Remove the baseline worktree after
capturing its receipts. Contract/unit tests run in CI, including late child
arrival and removal when its parent leaves the selected window. After stopping
the daemon, run `measure "$RUN" post-door` again: startup can update SQLite
statistics and change a previously fast plan. Migration 417's covering window
index must keep that read bounded after those statistics updates too.
