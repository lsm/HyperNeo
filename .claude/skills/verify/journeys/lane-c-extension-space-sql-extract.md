# Extract Space extension configuration SQL

Use proof-run.sh with lane-c-extension-space-sql-extract.ts on Bun and cached
Deno (VERIFY_PROOF_RUNTIME=deno). Shared setup owns fresh HOME/data and an
ephemeral listener, scrubs credentials, retains evidence and deletes owned data.
No provider turn, HTTP mock, GitHub access or live daemon/8399 is used.

The real GitHub extension is enabled through its public global RPC with polling
and webhooks disabled and RPC configuration enabled. Seed only a synthetic Space
with no watched repositories. Drive space.github.enable, space.github.disable
and space.github.listConfig over the actual WebSocket. Preserve their replies,
exact persisted settings JSON, compound key and creation time across updates.
Two target main UPSERTs remain expected: extraction claims no SQL movement.
Additional GitHub source-setting/watch-row writes remain separate too.

Commit the failing helper-availability contract first while legacy RPC behavior
already passes. After extraction, direct scratch SQLite proves supplied time,
caller-owned rollback and parent cascade. Unit tests compare old/new six bindings
and full rows, Space/source key partitioning, validation before clock/prepare and
serialization failure before mutation. Pin exact SQL bytes and binding/JSON AST,
clock expression and all non-Space store methods; stay below 200 owned lines.

The entire GitHub/plugin/startup dependency closure is not transitively audited;
no writer activation or full off-main claim is made. Save
extension-space-sql-extract.json; close scratch DB, socket, processors and daemon
in finally before wrapper cleanup. Deployment smoke remains Neo-owned.
