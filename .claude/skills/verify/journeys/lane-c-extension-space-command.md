# Construct the Space extension configuration command

Use proof-run.sh with lane-c-extension-space-command.ts on Bun and cached Deno
(VERIFY_PROOF_RUNTIME=deno). Shared setup owns a fresh HOME/data and ephemeral
listener, scrubs credentials, saves evidence and deletes owned data. No provider,
HTTP mock, GitHub access or live daemon/8399 is used.

Commit the failing native unregistered-command proof first while the merged SQL
helper characterization passes. Construct only a typed writer accepting validated
Space/source/config and caller-captured time. Its void acknowledgement follows
the existing immediate worker transaction commit; it has no callbacks or replay.

Enable only the real GitHub extension RPC capability, with polling/webhooks off,
and seed a synthetic Space with no watched repositories. Self-check cached/new
main config UPSERT traps, then forbid those statements. Invoke the command on the
real daemon gateway and verify its committed row via space.github.listConfig.
Retain settings JSON, compound key, creation time and supplied update time.

An AFTER UPDATE failure rolls back; a missing parent fails the foreign key.
Hold a separate WAL writer for 1.2 seconds: acknowledgement remains pending,
public readback shows prior state, and health stays responsive. After release,
the supplied timestamp survives the wait. This intentional wait does not pass
the 250 ms affected-write target. Refuse admission and drop an actual committed
reply: each produces one command and no automatic replay. Record command bytes,
round trip, loop lag, RSS and WAL. Unit contracts also cover insert rollback and
compound-key partitioning across Spaces/sources.

This does not activate the public setter or route its predecessor GitHub source-
setting/watch-row writes. Exact helper/store/framework hashes are stable pins,
not a full transitive plugin/startup/Space audit. Save extension-space-command.json;
close socket, lock, processors and app before wrapper cleanup. Deployment is Neo-owned.
