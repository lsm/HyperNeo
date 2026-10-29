# Construct the global extension configuration command

Use proof-run.sh with lane-c-extension-global-command.ts on Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data, an ephemeral
listener, credential scrubbing, evidence retention and immediate data cleanup.
No provider turn, HTTP mock, GitHub or live daemon/8399 is used.

Commit the failing proof before the command: the native worker rejects the
unregistered operation while merged helper characterizations pass. Build only
a typed write accepting validated source/config and caller-captured time. Its
undefined acknowledgement is returned after the existing worker transaction
commits. The merged helper's SQL and JSON expression remain byte-identical.

Self-check new and cached main UPSERT guards, then deny the target statement.
Invoke the registered command through the real daemon gateway and observe its
config through externalEvents.extensions.list over WebSocket. Preserve exact
synthetic settings, creation time and supplied update time. An AFTER UPDATE
failure must roll back. Unit contracts also cover failed insertion rollback.

Hold a competing WAL writer for 1.2 seconds: acknowledgement stays pending,
public readback retains the prior config and health remains responsive. Release
the lock and verify supplied time survives the wait. That intentional wait does
not pass the 250 ms write target; record it separately. Inject admission refusal
and drop an actual committed worker reply; assert one command each and no
automatic replay. Record round-trip/request/reply bytes, loop lag, RSS and WAL.

The synthetic extension's lifecycle callbacks must not run. This construction
does not activate the public setter or move reads/startup DDL off main. Pin the
complete merged helper hash, command module and exact store hash in measurement;
the framework and plugin closure are stable infrastructure, not a transitive
activation audit. Close socket, processors, lock and daemon before cleanup.
Evidence: extension-global-command.json. Deployment smoke remains Neo-owned.
