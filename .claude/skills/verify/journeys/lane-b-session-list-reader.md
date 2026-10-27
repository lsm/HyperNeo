# Full session list RPC uses the read lane

Run `lane-b-session-list-reader.ts` through `proof-run.sh` in a fresh synthetic
daemon. It takes the wrapper's run directory as its sole argument. The native
Deno smoke runs the same helper under a disposable HOME/data/TMPDIR. No model,
provider key, external HTTP, real DB copy or live daemon access is required.

Seed active, paused, ended, archived and ordinary child sessions with full config,
metadata, worktree, SDK/ACP references, commands and processing state. Add excluded
room/Space sessions and each excluded type. Build reference full rows before the
guard. Deny every main-connection session SQL prepare, then call the actual
WebSocket session.list RPC for default, status and archive filters. An extra
includeSpaceSessions input must continue to be ignored by the public RPC.

Cold and concurrent warm responses must match the complete reference, ordering
and fields. Warm RPCs and health run while a second connection holds a synthetic
WAL writer transaction, which must not block the reader. Inject a native read
worker error; the RPC must reject without main fallback, health must remain
usable, and a later RPC must open a replacement reader and return the same rows.
The actor cache must stay empty and stored session rows must remain unchanged.

The tests-first baseline must fail at the first real list RPC because its SQL
reaches the guarded main connection. Preserve the failure JSON/log. After the
fix, record cold/warm RPC time, concurrent health time, loop lag, read-lane
request count and zero main SQL. The helper closes its socket, writer,
processors and daemon before deleting its own data. The wrapper retains evidence
outside the disposable run.

This proves the existing full Session[] RPC. LiveQuery list/counter evaluation,
pagination DTOs, web migration and deployment/UI smoke remain separate work.
