# Full transcript message hydration uses a reader snapshot

Run `lane-b-single-message-reader.ts` through `proof-run.sh` in a fresh synthetic
source daemon. Run the same helper with cached Deno for its native-worker smoke.
No provider turn, model mock, real credential or external HTTP is needed.

The helper waits for the real startup SDK body-copy completion marker before
acquiring its competing writer and measuring reader SQL. This keeps asynchronous
startup migration outside the reader-only assertions without bypassing migration.
Pass `--defer-body-copy` through proof-run.sh to hold startup copying until after
fixture seeding. That controlled schedule previously reproduced the Deno CI race
with one main-SQL attempt; it must now pass with zero attempts and
`startupBodyCopyComplete: true`. Run both ordinary and deferred modes with the
pinned Deno runtime. The deadline reports a failed migration instead of hanging.
The Deno CI smoke always runs the deferred schedule.

This is the actual `message.sdkMessage` WebSocket RPC used by thinned-message
hydration and full tool output. Seed the body through the production writer,
then deny main session/body SQL at execution, including statements cached before
the measurement. The baseline must reject the first cold RPC on target main SQL;
commit that failing reproduction before changing the handler.

Cold and concurrent warm reads must preserve the uncapped body and existing
16-KiB tool-output cap without changing stored text. A separately held WAL writer
must retain outside/inside values 0/1 before and after reads. Existing session,
UUID, conversation and parameter errors remain unchanged, and another session
cannot read the message. A later committed message is visible on the next read.
Inject a native reader failure: the affected request rejects, health stays usable,
and a later request recovers without main fallback or actor restoration.

The helper records body/reply hashes, latency, loop lag, RSS, WAL bytes and worker
round-trip/encoding size and time. Worker round-trip combines queue, SQL, assembly
and cloning; it does not isolate those costs. The wrapper retains evidence and
logs, then removes the disposable HOME and daemon data after owned resources
close. This source RPC proof leaves browser layout and served-build deployment
smoke unverified.
