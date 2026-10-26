# Fire-and-forget system broadcast survives reader failure

Run `lane-b-projected-system-broadcast-failure.ts` through `proof-run.sh` with a
fresh synthetic daemon; the native Deno smoke uses the same helper and isolated
HOME/data/TMPDIR. No model turn, provider key or external HTTP is used.

Capture the actual callback registered by the app with ProviderCredentialManager.
Install the production process-fatal logger with its supported observing exit
hook so the fixture can record a would-exit request and still close its daemon.
This does not disable or replace the unhandled-rejection handler. After startup
settles, inject a native health-count reader error and invoke that real callback,
which calls void broadcastSystemChange just as production does.

The baseline must record a fatal exit request, failing the no-exit assertion.
After the fix, require one warning, no fatal request, no stale state emission and
no automatic retry. Real health and projected-state WebSocket RPCs must remain
usable. A later explicit invocation of the same app callback must broadcast
fresh system health successfully. Main session/counter SQL is denied, including
cached statements, and the actor cache must remain empty.

The observing exit hook is a disclosed fixture seam, not a claim that an actual
process exit was allowed. Save the failure JSON/log; retain warnings, would-exit
requests and recovered public RPC replies. Close every owned resource and
remove disposable data after saving evidence. UI, served build and production
scale remain unverified.
