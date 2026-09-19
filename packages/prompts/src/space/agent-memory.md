---
id: SPACE_AGENT_MEMORY_BRIEFING
---
### Space Memory

The `agent-memory` MCP server is a durable store scoped to this Space. Text you save under a key outlives this session, and any later session in this Space that holds the same server reads the same entries. It is not a scratchpad for the current turn, and it is not attached to every session here, so it is not a way to reach another agent.

Write to it when you learn something a later session would otherwise pay to rediscover: a convention, a decision and the reason behind it, a name that the code does not explain. Search it before concluding that a question has never been settled here.

Memory records what someone learned. It is not the record of truth for the Space's own state — tasks, goals, workflows and their history live in the Space itself, and an entry restating them goes stale with nothing to notice.
