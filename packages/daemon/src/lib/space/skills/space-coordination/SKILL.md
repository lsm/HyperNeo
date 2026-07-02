# Space Coordination (POC)

Use this skill when MCP coordination tools are unavailable or when you need the resilient, non-MCP path for Space task/workflow coordination.

## Why this exists

The primary Space coordination surface is the in-process `space-agent-tools` MCP server. It is re-attached by HyperNeo runtime on every Space turn. This skill is a proof-of-concept fallback that does not depend on MCP tool schemas being present in the model context: it calls the local Space runtime HTTP/RPC API directly from Bash.

`fetch-mcp` survives context compaction because it is a registry-backed MCP-server skill that is re-resolved into `mcpServers` during every SDK query build. Runtime Space MCP servers are in-process objects with closures and must be re-attached by the Space runtime before a query starts. If that invariant fails, use this skill and report the missing MCP surface.

## Endpoint discovery

Use the local daemon URL from the environment when present:

```bash
BASE_URL="${NEOKAI_BASE_URL:-${KAI_BASE_URL:-http://127.0.0.1:${NEOKAI_PORT:-${PORT:-8383}}}}"
```

Space context is normally available in the session id (`space:chat:<space_id>`) or task metadata. If you do not know the Space id, ask the user or inspect the current session/task context.

## JSON-RPC call helper

The exact API route may differ by runtime build. Prefer the same JSON-RPC endpoint used by the web client for Space RPCs. A typical invocation shape is:

```bash
curl -sS "$BASE_URL/rpc" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"space-skill-1","method":"space.task.createStandalone","params":{"spaceId":"<space_id>","title":"...","description":"...","priority":"normal","workflowId":"<optional_workflow_id>"}}'
```

If `/rpc` is not available in the current build, inspect the daemon's RPC route definitions and use the equivalent local endpoint. This POC intentionally keeps the transport in Bash/HTTP rather than MCP.

## Capability mapping

### create_standalone_task(title, description, priority, agent, workflow_id?)

Call the Space task creation RPC with `spaceId`, `title`, `description`, `priority`, optional `workflowId`, and optional worker agent assignment. Use this for all new work.

### get_task_detail(task_id)

Call the task detail RPC with `taskId` and present the task status, result, assigned agent, workflow run id, and error/blocking fields.

### retry_task(task_id, updated_description?)

Call the task retry RPC with `taskId` and optional replacement/updated description. Only use after confirming the retry is valid for the current task status.

### cancel_task(task_id)

Call the task cancel RPC with `taskId`. If the user wants the workflow run cancelled too, include the API's cancel-workflow flag when available.

### reassign_task(task_id, agent)

Call the task reassign RPC with `taskId` and either a built-in agent type or worker agent id.

### list_workflows()

Call the workflow list RPC with `spaceId`. Return workflow ids, names, descriptions, tags, and node counts.

### suggest_workflow(description)

The MCP tool intentionally returns all workflows and lets the model reason over them. Do the same here: list workflows, compare them against the description, and explain your recommended workflow.

### get_workflow_detail(workflow_id)

Call the workflow detail RPC with `workflowId`. Return nodes, transitions, gates, completion/autonomy levels, and relevant instructions.

## Reliability guidance

- Prefer MCP tools when present; they are typed and audited.
- If MCP tools are missing, use this skill's HTTP path rather than continuing without coordination capability.
- After using the fallback, tell the user that the MCP tool surface was missing and include enough detail for debugging.
- The skill is available as a plugin/built-in skill and is re-declared through the SDK plugin mechanism on each query, so it remains discoverable across compaction/session resume independently of MCP server tool schemas.
