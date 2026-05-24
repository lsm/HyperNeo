# Graph Tool Benchmark — Direct SDK Run (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-5.1`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `fb857f240`
**Constraint:** Baseline uses built-in Read/Grep/Glob. MCP arms use `tools: []` (no built-in tools), isolated to a single MCP server with `allowedTools` set.

## Executive Summary

Four of five arms completed successfully. Baseline, CodeGraph, CRG, and ast-grep produced codebase-grounded plans with active tool use. Graphify could not be benchmarked due to lack of a working LLM backend.

**Key findings:**
- **CodeGraph:** Wrong MCP command (`mcp` → `serve --mcp`). Fixed, now 34 calls.
- **CRG:** Wrong serve arg (`--data-dir` not supported). Fixed, now 52 calls.
- **Graphify:** No working backend. No API keys available; local ollama model too small.
- **ast-grep:** Most active tool user (75 calls), no issues.

## Results

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (Read/Grep/Glob) | 284.2 | 75,444 | 61 | 17,643 |
| CodeGraph | 427.0 | 45,214 | 34 | 16,354 |
| code-review-graph | 1097.4 | 86,918 | 52 | 17,927 |
| Graphify | SKIP | — | — | — |
| ast-grep | 379.4 | 83,064 | 75 | 16,927 |

### Tool Call Breakdown

**Baseline (built-in tools):**

| Tool | Calls |
|------|-------|
| `Read` | 34 |
| `Grep` | 20 |
| `Glob` | 7 |

**CodeGraph (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__codegraph__codegraph_node` | 18 |
| `mcp__codegraph__codegraph_search` | 8 |
| `mcp__codegraph__codegraph_context` | 4 |
| `mcp__codegraph__codegraph_explore` | 2 |
| `mcp__codegraph__codegraph_callees` | 2 |

**code-review-graph (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__code-review-graph__semantic_search_nodes_tool` | 28 |
| `mcp__code-review-graph__query_graph_tool` | 21 |
| `mcp__code-review-graph__get_review_context_tool` | 2 |
| `mcp__code-review-graph__get_minimal_context_tool` | 1 |

**ast-grep (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__ast-grep__ast_grep_search` | 47 |
| `mcp__ast-grep__ast_grep_scan` | 22 |
| `mcp__ast-grep__ast_grep_search_multiple` | 6 |

### Index Build Times

| Tool | Build Time |
|------|-----------|
| CodeGraph | 3.6s |
| code-review-graph | 71.3s |
| ast-grep (resolve) | 4.6s |
| Graphify | N/A (no working backend) |

## Detailed Analysis

### Baseline (built-in Read/Grep/Glob)

- **Response:** 17,643 chars
- **Tool calls:** 61 — Read (34), Grep (20), Glob (7)
- **Tokens:** 75,444
- **Quality:** Active codebase exploration, grounded in actual NeoKai paths.
- **Assessment:** Strong baseline. Most thorough exploration, no index build required.

### CodeGraph

- **Response:** 16,354 chars — grounded in actual NeoKai files
- **Tool calls:** 34 — node (18), search (8), context (4), explore (2), callees (2)
- **Tokens:** 45,214 — input-heavy (39,043 input, 6,171 output)
- **Root cause of earlier failure:** Benchmark script used `codegraph mcp` which does not exist. Correct command is `codegraph serve --mcp`.
- **Assessment:** Good codebase grounding. Longest wall time (427s) due to large tool result payloads. Model prefers `codegraph_node` over batch `codegraph_explore`.

### code-review-graph

- **Response:** 17,927 chars — grounded in actual NeoKai files
- **Tool calls:** 52 — semantic_search_nodes (28), query_graph (21), get_review_context (2), get_minimal_context (1)
- **Tokens:** 86,918 — highest token usage of all arms
- **Build time:** 71.3s — slowest index build
- **Root cause of earlier failure:** Benchmark script passed `--data-dir` to `serve` command, which does not accept it. Server failed on startup.
- **Assessment:** Good codebase grounding once serve args are correct. Heavy use of semantic search (28 calls). Most token-expensive arm.

### ast-grep

- **Response:** 16,927 chars
- **Tool calls:** 75 — `ast_grep_search` (47), `ast_grep_scan` (22), `ast_grep_search_multiple` (6)
- **Tokens:** 83,064
- **Assessment:** Most active tool user. Heavy AST-based exploration with structural patterns and YAML rule scans.

### Graphify

- **Status:** SKIP — no working LLM backend available
- **Issue 1:** Extraction requires `openai` package even for ollama backend (installed, but insufficient)
- **Issue 2:** Local ollama model (`qwen3:0.6b`) too small — returns invalid JSON, cannot extract graph
- **Issue 3:** No API keys (Gemini/OpenAI) available for cloud backends
- **Assessment:** Graphify cannot be benchmarked in this environment without a capable LLM backend. The tool itself does not expose a native MCP server; the benchmark script attempted to run `python -m graphify.serve` which does not exist.

## Key Findings

1. **Both CodeGraph and CRG failed due to incorrect CLI arguments, not model behavior.** After fixing commands, both achieved active tool use (34 and 52 calls).

2. **CRG is the most token-expensive arm.** 86,918 tokens for 52 calls — higher per-call cost than CodeGraph or ast-grep.

3. **ast-grep remains most active tool user.** 75 calls, no setup issues.

4. **Baseline is most reliable.** No index build, no MCP server startup issues, consistent 61 tool calls.

5. **Graphify requires a capable LLM backend to function.** Without API keys or a sufficiently large local model, extraction fails and no graph is available for querying.

6. **Build times vary significantly.** CodeGraph (3.6s) and ast-grep (4.6s) are fast. CRG (71s) is slow but acceptable.

## Recommendations

1. **Verify MCP server commands before benchmarking.** Both CodeGraph (`serve --mcp`) and CRG (`serve` without `--data-dir`) had incorrect invocations. Always test the server startup independently.

2. **Graphify needs backend setup.** To benchmark Graphify, provide either a Gemini/OpenAI API key or a capable local ollama model (≥7B parameters).

3. **Consider Claude Sonnet as control.** Run the same benchmark with Claude Sonnet to establish a baseline for comparison with GLM-5.1's tool-use behavior.

4. **CodeGraph tool-use optimization.** The model makes 18 `codegraph_node` calls (one per symbol). Consider whether `codegraph_explore` (batch symbol survey) could reduce call count.

## Raw Data

- Baseline: `/tmp/graph-tool-benchmark-baseline.json`
- CodeGraph: `/tmp/graph-tool-benchmark-codegraph.json`
- CRG: `/tmp/graph-tool-benchmark-crg.json`
- ast-grep: `/tmp/graph-tool-benchmark-ast-grep.json`
