# Neo snapshot index

Run the helper through `proof-run.sh` with the pinned Bun runtime. Pass `baseline -` on the original tree to capture the RPC response and the expected first-page failure. Pass `verify` and the saved baseline `rpc.json` on the changed tree to compare RPC output and walk all MCP pages.

The helper starts a real isolated daemon on an ephemeral port with test mode, its own HOME and database, and no provider keys. It seeds forty long synthetic asks and invokes neo.snapshot through the MCP adapter. It prints response bytes, first-page ask count, more, rule-text presence, total asks across the cursor walk, and exit status. It preserves the RPC snapshot for comparison after normalizing revision and preference timestamps. Cleanup closes the daemon before the wrapper saves evidence and removes temporary data.
