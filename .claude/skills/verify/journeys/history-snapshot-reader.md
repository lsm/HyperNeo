# Legacy history snapshots use the gateway read lane

Run `history-snapshot-reader.ts` through the shared `proof-run.sh` wrapper with a
fresh evidence directory. Run the same helper with `VERIFY_PROOF_RUNTIME=deno`
for native Deno acceptance. No model, external HTTP, real HOME/database or port
8399 is used.

The helper seeds complete ordinary text, a tool parent/child and task metadata
with tied timestamps through production writers. It waits for startup body copying
before measuring. Real `state.sdkMessages` RPCs must preserve the existing
100-message selection, since filtering, output caps, timestamp and missing-session
errors. Empty room/conversation fallbacks must still work. Deny main-connection
SDK-message/body SQL during these requests, including actor restoration side
effects. The tests-first baseline fails its first public snapshot with that SQL
guard. Preserve its log and failure JSON.

Fixed cold/concurrent snapshots must match the existing repository reference,
keep the actor cold and leave body hashes unchanged. Health remains responsive;
a native gateway reader failure must reject the snapshot without main fallback,
and the next request must recover. Evidence records latency, maximum loop lag,
main SQL attempts and recovery. This is source RPC proof, not browser/deployment
or production-scale performance evidence.
