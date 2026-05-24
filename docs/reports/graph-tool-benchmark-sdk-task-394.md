# Graph Tool Benchmark — Direct SDK Run (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-4.7`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `f6ce9b70d`
**Constraint:** Each arm runs with `tools: []` (no built-in tools), isolated to a single MCP server.

## Executive Summary

ast-grep was the only tool the model actually called during the benchmark. CodeGraph and code-review-graph returned zero tool calls — the model produced text-only responses despite MCP servers being attached. Baseline produced the longest, most detailed plan (19,760 chars). Graphify failed to extract (missing `openai` package for ollama backend).

**Key finding:** GLM-4.7 through the Anthropic-compatible API does not reliably invoke MCP tools when `tools: []` is set. Only ast-grep saw active tool use (27 calls). This suggests either the model needs built-in tools enabled alongside MCP, or GLM's tool-use capability is limited in this routing mode.

**Token reporting:** GLM returns 0 tokens through the Anthropic-compatible usage API. Wall time is the only reliable metric.

## Results

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (text-only) | 58.3 | 0 | 0 | 19,760 |
| CodeGraph | 12.8 | 0 | 0 | 179 |
| code-review-graph | 33.8 | 0 | 0 | 14,981 |
| Graphify | FAIL | — | — | — |
| ast-grep | 71.7 | 0 | 27 | 9,937 |

### Tool Call Breakdown (ast-grep)

| Tool | Calls |
|------|-------|
| `ast_grep_search` | 18 |
| `ast_grep_search_multiple` | 8 |
| `ast_grep_scan` | 1 |

### Index Build Times

| Tool | Build Time |
|------|-----------|
| CodeGraph | 4.0s |
| code-review-graph | 113.1s |
| Graphify | FAILED (missing `openai` package) |
| ast-grep (resolve) | 4.3s |

## Detailed Analysis

### Baseline (text-only)

- **Response:** 19,760 chars — longest and most detailed response
- **Quality:** Produced a comprehensive plan with architecture diagrams, phase breakdowns, interface definitions, migration strategy, risk analysis, and estimated LOC
- **Key files identified:** Generic path guesses (`src/space/runtime/task_agent.ts`) — none matched actual NeoKai paths
- **Assessment:** Best prose quality but no actual codebase grounding. Generic "agent runtime" architecture rather than NeoKai-specific.

### CodeGraph

- **Response:** 179 chars — shortest response by far
- **Tool calls:** 0 — model did not use CodeGraph MCP tools at all
- **Quality:** Produced only a brief "Let me explore the codebase" message, suggesting the session terminated early or the model couldn't figure out how to use the tools
- **Assessment:** Unusable in this configuration. The model needs guidance on tool usage or built-in tools enabled alongside CodeGraph.

### code-review-graph

- **Response:** 14,981 chars — second longest
- **Tool calls:** 0 — model did not use CRG MCP tools
- **Quality:** Despite not calling tools, produced a detailed plan. However, it hallucinated tool calls in XML format (`<read_file>`, `<search_files>`) that weren't actually executed
- **Key files identified:** Generic guesses (`src/agents/space/agent.ts`, `src/tasks/agent.ts`) — not actual NeoKai paths
- **Assessment:** Model produced reasonable generic content but fabricated exploration steps. No actual codebase grounding.

### ast-grep

- **Response:** 9,937 chars
- **Tool calls:** 27 — only tool that was actively used
- **Quality:** Produced a detailed plan with actual NeoKai file paths (`packages/daemon/src/lib/space/runtime/space-runtime.ts`, `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`, `packages/daemon/src/lib/space/managers/space-task-manager.ts`)
- **Key files identified:** Correctly identified 6+ actual NeoKai source files
- **Tool usage pattern:** 18 single-pattern searches, 8 batch searches, 1 YAML rule scan
- **Assessment:** Only tool that produced codebase-grounded results. The model actively explored and found real files. Response was shorter than baseline but more accurate.

### Graphify

- **Status:** FAILED — extraction requires `openai` Python package even for ollama backend
- **Error:** `[graphify] chunk 1/1 failed: Gemini/Kimi/Ollama/OpenAI-compatible extraction requires the openai package. Run: pip install openai`
- **Assessment:** Needs dependency fix before benchmarking. Build cache was stale (commit mismatch forced rebuild).

## Key Findings

1. **GLM tool-use is unreliable with isolated MCP servers.** CodeGraph and CRG saw zero tool calls despite MCP servers being correctly attached. Only ast-grep worked. This may be a GLM-specific limitation in the Anthropic-compatible API routing.

2. **ast-grep is the only tool that produced grounded results.** It found actual NeoKai file paths and referenced real abstractions. Other arms produced generic plans.

3. **Baseline produces the most detailed prose.** Without tool access, the model compensates with thorough (but ungrounded) architecture analysis.

4. **Token metrics are unavailable.** GLM's Anthropic-compatible API returns zero usage data. Wall time is the only comparable metric.

5. **Build times vary widely.** CodeGraph (4s) and ast-grep (4.3s) are fast. CRG takes ~2 minutes. Graphify extraction failed.

6. **`ast_grep_scan` was barely used.** Only 1 out of 27 calls used the YAML rule scan. Pattern-based search dominated, suggesting the model prefers simple patterns over complex rules.

## Recommendations

1. **Re-run with built-in tools enabled** alongside MCP to test whether GLM's tool-use improves with familiar tools available.

2. **Fix Graphify dependency** and re-run that arm.

3. **Consider different model** (e.g., Claude Sonnet) as control — GLM's tool-use behavior through the Anthropic-compatible API may not generalize to other providers.

4. **ast-grep MCP wrapper is production-ready.** The custom MCP server correctly handles all three tool types and the exit-code-1 edge case.

## Raw Data

Results written to `/tmp/graph-tool-benchmark-results.json` at `2026-05-24T17:30:49.236Z`.
