# Transcript existence gate uses the page reader

Run `lane-b-transcript-session-reader.ts` through `proof-run.sh` in a fresh
synthetic daemon. The helper takes the wrapper's run directory as its only
argument. Use the same helper with Deno's native worker for the runtime smoke.
No provider turn, model mock, real credentials or external HTTP is needed.

The fixture creates a persisted session without an actor, complete ordinary
messages, a parent/child tool exchange and background metadata. Identical
timestamps exercise timestamp/rowid pagination. References are read before the
measurement guard. Actual WebSocket RPCs must return the exact latest, before
and since pages while all session/message SQL is denied on the main connection.
The session must remain absent from the actor cache after cold and concurrent
warm reads. Missing ordinary sessions must reject; conversation fallback must
still return an empty page. An injected native reader error must reject through
the RPC, leave health usable and allow a later request to open a fresh reader.
Logical stored body hashes must remain unchanged.

The baseline must fail on target main SQL during the first cold public history
request. Save its JSON and failure log before implementing the fix. The helper
closes the socket, processors, workers and daemon before removing its own data
and disposable home. The wrapper retains JSON and log outside that directory.

This slice changes only existence admission to the current full transcript
response. Parent/background query improvements, live subscriptions, single
message reads, counts and exports remain separate. These proofs use synthetic
source daemons and do not establish served-build UI or deployment smoke.
