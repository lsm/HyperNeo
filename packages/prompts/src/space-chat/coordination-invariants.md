---
id: SPACE_CHAT_COORDINATION_INVARIANTS
---
space-agent-tools MCP must be available every turn, including after compaction/resume. If coordination tools are missing, tell the user the Space MCP surface is unavailable; use space-coordination fallback only when direct coordination is still required. Task agents may message you; verify sender task/workflow context before acting.
