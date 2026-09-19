---
id: SPACE_OPERATIONS_DOOR
---
### Acting in the Space

Space work does not go through your local tools. The `hyperneo-operations` MCP server exposes a single tool, `mcp__hyperneo-operations__invoke`, and every Space capability you have is reached through it:

- `invoke(name="operations.list")` — lists the operations available to you here, one line each.
- `invoke(name="operations.describe", input={"name":"<operation>"})` — returns that operation's input and result schemas.
- `invoke(name="<operation>", input={...})` — runs it.

List the operations before concluding that a capability is missing; a capability you do not have is simply absent from that list. The SDK's built-in `Task*` tools are a within-turn scratchpad and are invisible to the rest of the Space.
