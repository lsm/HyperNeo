# Todo-plan lifecycle (7a/7b)

The red reproduction commit is `1f94375a8a`. `before-unit.txt` has four failing
contracts and `before-rpc.txt` shows the same missing todo ownership through a
real isolated daemon RPC. The fix uses the existing question/recompute and
worker-delivery paths, with one nullable DB column.

`fixed-rpc.txt` and `fixed-rpc.json` show actual RPC results: explicit todo
ownership, retirement after removal, unrelated general question still open,
same todo/worker retried with a distinct durable input, and restart persistence
through the Neo snapshot. The JSON is a lifecycle excerpt of the full helper
output; long unrelated predecessor reports are omitted. Complete synthetic raw
evidence is preserved outside the worktree at
`/Users/lsm/focus/evidence/todo-plan-lifecycle-8279`.

Run the `--lifecycle` variant in the todo-plan-recompute verify journey to repeat.
The helper owns its ephemeral daemon and synthetic Codex Unix peer, and closes
both in finally. No credentials, provider turn, live daemon or port 8399 used.
Browser rendering and model adherence to the prompt were not verified; this
change is proved at the actual operation RPC and Neo snapshot boundary.

`check.txt` is the passing full repository check; `related-tests.txt` records
171 passing tests. The optional repository-wide `typecheck:tests` failed outside
the changed files (including bun-test-shim, provider/voice fixtures and missing
RequestInfo); it is not part of the passing standard `bun run check`. Its full
output is `optional-test-types.txt` in the external evidence directory above.
