# Subscribed session rows and counters share a reader snapshot

Run `lane-b-session-list-live-reader.ts` through `proof-run.sh` in a fresh
synthetic daemon. The native Deno smoke runs the same helper under an isolated
HOME/data/TMPDIR. No provider, model turn or external HTTP is used.

The helper seeds full human/archived/excluded session rows and captures the
existing wire projection as its reference. A main-thread statement proxy,
installed before daemon startup, denies session SQL and the subscription's
total/archived counter projection during measurement
even for statements prepared before the guard is enabled. Real WebSocket
sessions.list subscriptions must deliver unchanged complete rows and counters
while a second synthetic WAL writer holds a transaction. The actor cache must
remain empty; heldPrompt is hidden in replies and retained in storage.

Real gateway writes archive a visible row and add an archived row. Assert both
row deltas and metadata-only counter deltas. Unknown session-only invalidations
must conservatively re-evaluate without a main SQL lookup; known Space scopes
may be skipped. Inject native reader failures during initial subscription and
later delta evaluation. Failed subscriptions must release their resources,
health must remain usable, and new subscriptions must recover complete rows.

Save baseline failure at the first subscription before the fix. Fixed evidence
records complete projection equality, counter/delta consistency, SQL attempts,
read-lane requests, cold/warm subscribe and concurrent health latency, loop lag
and any miss of 250 ms snapshot latency. The existing 150 ms debounce is retained
and included in timings. A latency miss is recorded explicitly, not relabelled
as a pass. Source proof data, socket, writers and daemon are closed and removed
after evidence is saved. UI/served-build smoke and production scale are not
established by this source proof.

The broader diagnostic also observed system.health's distinct countHumanSessions
counter read on main. That pre-existing path is outside this slice and is
not covered by its zero-target-SQL claim. The guard still blocks both the exact
subscription counter projection and all session-table statements, including
cached statement execution.
