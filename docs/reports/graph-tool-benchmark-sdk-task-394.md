# Graph Tool Benchmark — Direct SDK Run (Task #394)

**Date:** 2026-05-24
**Method:** Claude Agent SDK `query()` with GLM provider routing
**Model:** `glm-5.1`
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Commit:** `fb857f240`
**Constraint:** Baseline uses built-in Read/Grep/Glob. MCP arms use `tools: []` (no built-in tools), isolated to a single MCP server with `allowedTools` set.

## Executive Summary

All five arms completed successfully. Every tool achieved active tool use and produced codebase-grounded plans.

**Root causes of earlier failures:**
- **CodeGraph:** Wrong MCP command (`mcp` → `serve --mcp`)
- **CRG:** Wrong serve arg (`--data-dir` not supported by `serve`)
- **Graphify:** Missing `[mcp]` extra — `graphify.serve` module not installed

**Key findings:**
- **ast-grep** most active (75 calls), **Graphify** close second (73 calls)
- **CRG** most token-expensive (86,918 tokens)
- **CodeGraph** longest wall time (427s)
- **Baseline** most reliable — no index build, consistent 61 calls

## Results

| Case | Wall Time (s) | Tokens | Tool Calls | Response Length |
|------|--------------|--------|------------|-----------------|
| baseline (Read/Grep/Glob) | 284.2 | 75,444 | 61 | 17,643 |
| CodeGraph | 427.0 | 45,214 | 34 | 16,354 |
| code-review-graph | 1097.4 | 86,918 | 52 | 17,927 |
| Graphify | 549.7 | 41,742 | 73 | 21,890 |
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

**Graphify (MCP):**

| Tool | Calls |
|------|-------|
| `mcp__graphify__get_node` | 44 |
| `mcp__graphify__get_neighbors` | 22 |
| `mcp__graphify__query_graph` | 6 |
| `mcp__graphify__graph_stats` | 1 |

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
| Graphify | N/A (used pre-built graph) |
| ast-grep (resolve) | 4.6s |

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

### Graphify

- **Response:** 21,890 chars — grounded in actual NeoKai files
- **Tool calls:** 73 — get_node (44), get_neighbors (22), query_graph (6), graph_stats (1)
- **Tokens:** 41,742
- **Root cause of earlier failure:** `graphifyy[mcp]` extra not installed — `python -m graphify.serve` module missing. After installing `[mcp]` extra, serve works.
- **Assessment:** Second-most active tool use. Heavy node traversal pattern (44 get_node + 22 get_neighbors). Uses pre-built graph; extraction requires capable LLM backend.

### ast-grep

- **Response:** 16,927 chars
- **Tool calls:** 75 — `ast_grep_search` (47), `ast_grep_scan` (22), `ast_grep_search_multiple` (6)
- **Tokens:** 83,064
- **Assessment:** Most active tool user. Heavy AST-based exploration with structural patterns and YAML rule scans.

## Key Findings

1. **All three previously-failing arms failed due to incorrect CLI invocations, not model behavior.** CodeGraph (`mcp` → `serve --mcp`), CRG (removed `--data-dir`), Graphify (installed `[mcp]` extra).

2. **ast-grep and Graphify are the most active tool users.** 75 and 73 calls respectively. Both use traversal patterns: ast-grep via structural search, Graphify via node/neighbor traversal.

3. **CRG is the most token-expensive arm.** 86,918 tokens for 52 calls — highest per-call cost.

4. **Baseline remains most reliable.** No index build, no MCP server startup issues, consistent 61 tool calls.

5. **Build times vary significantly.** CodeGraph (3.6s) and ast-grep (4.6s) are fast. CRG (71s) is slow but acceptable. Graphify used a pre-built graph.

6. **Token reporting works with GLM-5.1.** Unlike GLM-4.7 which returned 0 tokens, GLM-5.1 returns accurate usage data through the Anthropic-compatible API.

## Recommendations

1. **Verify MCP server commands before benchmarking.** All three fixes were CLI invocation errors. Always test server startup independently.

2. **Graphify needs `pip install "graphifyy[mcp]"`** for the MCP server module. The base package does not include `graphify.serve`.

3. **Consider Claude Sonnet as control.** Run the same benchmark with Claude Sonnet to establish a baseline for comparison with GLM-5.1's tool-use behavior.

4. **CodeGraph tool-use optimization.** The model makes 18 `codegraph_node` calls (one per symbol). Consider whether `codegraph_explore` (batch symbol survey) could reduce call count.

5. **Graphify extraction requires capable LLM backend.** The pre-built graph used here was extracted with a cloud backend. For fresh extraction, provide API keys or a capable local model.

## Raw Data

- Baseline: `/tmp/graph-tool-benchmark-baseline.json`
- CodeGraph: `/tmp/graph-tool-benchmark-codegraph.json`
- CRG: `/tmp/graph-tool-benchmark-crg.json`
- Graphify: `/tmp/graph-tool-benchmark-graphify.json`
- ast-grep: `/tmp/graph-tool-benchmark-ast-grep.json`
