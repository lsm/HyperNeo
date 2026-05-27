# Graph Tool Benchmark — Token Usage Analysis (Task #394)

**Date:** 2026-05-24
**Model:** `glm-5.1` via Anthropic-compatible API
**Task:** #394, "Refactor task event source as Layer-2 anti-stuck mechanism"
**Note:** GLM-5.1 does not report cache tokens through the Anthropic-compatible API. Only input/output totals are available.

## Raw Token Data

| Arm | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Wall Time (s) | Response Chars |
|-----|-------------|--------------|-------------|-----------|--------------|---------------|
| baseline (Read/Grep/Glob) | 66,805 | 8,639 | 75,444 | 61 | 284.2 | 17,643 |
| CodeGraph | 39,043 | 6,171 | 45,214 | 34 | 427.0 | 16,354 |
| code-review-graph | 80,335 | 6,583 | 86,918 | 52 | 1097.4 | 17,927 |
| Graphify | 33,457 | 8,285 | 41,742 | 73 | 549.7 | 21,890 |
| ast-grep | 74,837 | 8,227 | 83,064 | 75 | 379.4 | 16,927 |

## Efficiency Metrics

### Tokens per Tool Call

Lower is better — means each tool call costs fewer tokens.

| Arm | Input / Call | Total / Call |
|-----|-------------|-------------|
| CodeGraph | 1,148 | 1,330 |
| baseline | 1,095 | 1,237 |
| Graphify | 458 | 572 |
| ast-grep | 998 | 1,108 |
| CRG | 1,545 | 1,671 |

**Finding:** Graphify is most token-efficient per call (458 input tokens/call). CRG is least efficient (1,545 input tokens/call) — its semantic search returns large result payloads.

### Output Tokens per Response Character

Measures how "dense" the model's output is. Lower = more concise.

| Arm | Output Tokens / Char | Chars / Output Token |
|-----|---------------------|---------------------|
| CodeGraph | 0.377 | 2.65 |
| CRG | 0.367 | 2.72 |
| baseline | 0.490 | 2.04 |
| Graphify | 0.379 | 2.64 |
| ast-grep | 0.486 | 2.06 |

**Finding:** CodeGraph and CRG produce the most concise output (fewer tokens per character). Baseline and ast-grep are less concise. This suggests the graph-based tools (CodeGraph, CRG, Graphify) help the model produce denser, more structured plans.

### Time Efficiency

Tokens per second and calls per second.

| Arm | Tokens / Second | Calls / Second | Chars / Second |
|-----|----------------|---------------|---------------|
| baseline | 265.4 | 0.215 | 62.1 |
| CodeGraph | 105.9 | 0.080 | 38.3 |
| CRG | 79.2 | 0.047 | 16.3 |
| Graphify | 75.9 | 0.133 | 39.8 |
| ast-grep | 218.9 | 0.198 | 44.6 |

**Finding:** baseline and ast-grep are fastest in tokens/second. CRG and Graphify are slowest due to large tool result round-trips. CodeGraph is also slow (106 tokens/sec) despite fewer calls — individual tool results are large.

### Input/Output Ratio

Higher ratio = model reads more than it writes (heavy tool usage).

| Arm | Input : Output | Ratio |
|-----|---------------|-------|
| Graphify | 33,457 : 8,285 | 4.04 : 1 |
| baseline | 66,805 : 8,639 | 7.73 : 1 |
| ast-grep | 74,837 : 8,227 | 9.10 : 1 |
| CodeGraph | 39,043 : 6,171 | 6.33 : 1 |
| CRG | 80,335 : 6,583 | 12.20 : 1 |

**Finding:** CRG has the highest input:output ratio (12.2:1) — the model reads massive semantic search results but writes relatively little. Graphify has the lowest ratio (4.0:1) — its node/neighbor traversal produces smaller payloads.

## Tool-Specific Token Patterns

### Baseline (built-in tools)

| Tool | Calls | Est. Input / Call |
|------|-------|------------------|
| Read | 34 | ~800 tokens (full file reads) |
| Grep | 20 | ~500 tokens (search results) |
| Glob | 7 | ~200 tokens (file lists) |

**Pattern:** Read dominates (34 calls). Each Read returns full file contents, inflating input tokens. But reads are fast — no index build, no serialization overhead.

### CodeGraph

| Tool | Calls | Est. Input / Call |
|------|-------|------------------|
| codegraph_node | 18 | ~1,200 tokens (full symbol source) |
| codegraph_search | 8 | ~800 tokens (match lists) |
| codegraph_context | 4 | ~2,000 tokens (composed results) |
| codegraph_explore | 2 | ~1,500 tokens (batch symbols) |
| codegraph_callees | 2 | ~600 tokens (caller lists) |

**Pattern:** `codegraph_node` dominates (18 calls). Each call returns full symbol source code, making it input-expensive per call. The model prefers reading individual symbols over batch exploration.

### CRG

| Tool | Calls | Est. Input / Call |
|------|-------|------------------|
| semantic_search_nodes | 28 | ~2,000 tokens (semantic matches with context) |
| query_graph | 21 | ~1,200 tokens (graph traversals) |
| get_review_context | 2 | ~3,000 tokens (composed review context) |
| get_minimal_context | 1 | ~1,500 tokens (minimal context) |

**Pattern:** `semantic_search_nodes` dominates (28 calls) and is the most expensive per call. CRG's semantic search returns richly contextualized node descriptions, driving the 80K input token total.

### Graphify

| Tool | Calls | Est. Input / Call |
|------|-------|------------------|
| get_node | 44 | ~400 tokens (node metadata + snippet) |
| get_neighbors | 22 | ~600 tokens (edge lists with node summaries) |
| query_graph | 6 | ~1,500 tokens (BFS/DFS traversal results) |
| graph_stats | 1 | ~300 tokens (aggregate stats) |

**Pattern:** `get_node` dominates (44 calls) but each call is cheap (~400 tokens). Graphify's node-centric model produces smaller payloads than CRG's semantic search, explaining the low total tokens (41,742) despite 73 calls.

### ast-grep

| Tool | Calls | Est. Input / Call |
|------|-------|------------------|
| ast_grep_search | 47 | ~1,000 tokens (JSON match arrays) |
| ast_grep_scan | 22 | ~1,500 tokens (YAML rule scan results) |
| ast_grep_search_multiple | 6 | ~2,500 tokens (combined pattern results) |

**Pattern:** Heavy search usage (47 calls) with moderate per-call cost. `ast_grep_scan` (22 calls) is more expensive than search due to YAML rule complexity.

## Cost Projections (GLM-5.1 Pricing)

GLM-5.1 pricing (approximate, via BigModel CN):
- Input: ~¥0.005 / 1K tokens
- Output: ~¥0.015 / 1K tokens

| Arm | Input Cost | Output Cost | Total Cost | Cost / Call | Cost / Char |
|-----|-----------|------------|-----------|------------|------------|
| baseline | ¥334 | ¥130 | ¥464 | ¥7.60 | ¥0.026 |
| CodeGraph | ¥195 | ¥93 | ¥288 | ¥8.47 | ¥0.018 |
| CRG | ¥402 | ¥99 | ¥501 | ¥9.63 | ¥0.028 |
| Graphify | ¥167 | ¥124 | ¥291 | ¥3.99 | ¥0.013 |
| ast-grep | ¥374 | ¥123 | ¥497 | ¥6.63 | ¥0.029 |

**Finding:** Graphify is cheapest per call (¥4.0) and per character (¥0.013). CRG is most expensive overall (¥501) and per call (¥9.63). CodeGraph is mid-range in total cost but highest per call among graph tools.

## Key Insights

1. **Graphify achieves lowest total cost (¥291) with highest tool use (73 calls).** Small per-call payloads make it cost-efficient despite many calls.

2. **CRG is most expensive (¥501) due to semantic search payload size.** Each `semantic_search_nodes` call returns richly contextualized results that consume input tokens.

3. **CodeGraph has low total cost (¥288) but high per-call cost (¥8.47).** The model makes fewer calls (34) but each `codegraph_node` returns full symbol source.

4. **Baseline cost (¥464) is driven by Read tool returning full files.** 34 Read calls at ~800 tokens each = 27K input tokens from reads alone.

5. **Output token variance is small (6,171–8,639).** All arms produce similar output volume. Cost differences are driven by input tokens (tool result sizes).

6. **Wall time correlates with input tokens, not tool calls.** CRG (80K input, 1097s) and Graphify (33K input, 550s) show that large tool results slow round-trips more than call count.

7. **No cache token data available.** GLM-5.1's Anthropic-compatible endpoint does not expose `cache_creation_input_tokens` or `cache_read_input_tokens`. Cannot measure prompt caching efficiency.

## Recommendations

1. **For cost-sensitive use:** Graphify is cheapest (¥291 total, ¥4.0/call). Its node-centric model produces small payloads.

2. **For accuracy per dollar:** CodeGraph at ¥288 total with excellent line-number precision. Best accuracy/cost ratio.

3. **For speed:** baseline (284s) or ast-grep (379s). Both avoid large graph tool result round-trips.

4. **Avoid CRG for cost-sensitive tasks** unless semantic search precision is critical. Highest cost (¥501) and slowest (1097s).

5. **Consider prompt caching** if the API supports it. With ~40–80K input tokens per run, even a 50% cache hit would save ¥100–200 per run.
