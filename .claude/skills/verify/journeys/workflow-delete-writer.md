# Workflow deletion guards and writes use the DB writer

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/workflow-delete-evidence \
  .claude/skills/verify/workflow-delete-writer.ts verify
```

A fresh synthetic daemon serves the real `spaceWorkflow.delete` WebSocket RPC.
Deletion of an unused workflow must succeed and remove its nodes while retaining
immutable definition history. A taskless executable run must block deletion;
a mismatched optional Space must be refused without changing either workflow.
A repeated delete must report the missing workflow. Instrumentation must see no
executable-run guard query or workflow DELETE on the main connection.

The same journey before the fix completes those behavior checks but fails its
SQL assertion. That regression is committed before wiring. Repeat with
`VERIFY_PROOF_RUNTIME=deno` and supported Deno on PATH. The wrapper preserves RPC
replies and SQL evidence before removing the synthetic home and database.

The RPC uses `SpaceWorkflowManager.deleteWorkflowAsync(id)`. The legacy sync API
remains for unported import callers; lane C owns that handler and can switch to
the async API separately. The duplicate-resync RPC also awaits the new deletion
API. The writer checks executable runs and deletes in one transaction; main
publishes deletion only after the promise resolves. Typed deletion refusals are
preserved across the worker reply.

Unit cases cover typed refusal, immutable history, rollback and no notifications
for a rejected delete. Main RPC preflight workflow/Space reads, duplicate-resync
run deletion, other workflow mutations, worker death and held-lock latency are
not claimed migrated or verified by this narrow journey.
