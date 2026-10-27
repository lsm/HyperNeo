# Workflow node configuration retains its RPC behavior

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/workflow-node-evidence \
  .claude/skills/verify/workflow-node-config-contract.ts verify
```

This neutral extraction proof creates a workflow through a fresh synthetic
daemon's real WebSocket RPC, then inserts, reorders and removes nodes through
spaceWorkflow.update. Full Unicode custom prompts, timeout, context reset,
tool guards, post-approval routing and transitions round-trip unchanged.
Clearing post-approval and empty transitions retains the existing omitted-field
semantics. The persisted immutable definition payload/hash matches the RPC result.

Commit this characterization before extracting the pure node-config builder and
repeat it unchanged afterward and under supported Deno with
VERIFY_PROOF_RUNTIME=deno. Compare the captured main-connection node SQL hashes.
This rung leaves node SQL on main; it prepares the smaller serializable writer
command and does not claim a write migration. No agent, hook script or model turn
executes. The wrapper preserves evidence and removes its synthetic daemon data.

Run workflow-manager and node configuration repository suites. Shared setup stays
in SKILL.md and proof-run.sh; later writer slices must preserve the whole node
replacement transaction and definition-version behavior.
