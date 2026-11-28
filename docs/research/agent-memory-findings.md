# Agent memory: what it does, why searches miss, and how Neo could use it

Research note, 2026-11-27. Findings and options only. No product code changed.

## The existing store

Today agent memory lives inside the Space feature. Spaces are parked, so this note reads
the store as a reusable part, not as a Space feature.

| Surface | Operations |
| --- | --- |
| `agent-memory` MCP server (`packages/space/src/tools/agent-memory-tools.ts`) | `memory.write` (upsert by key), `memory.search`, `memory.read`, `memory.delete` |
| RPC (`packages/daemon/src/lib/rpc-handlers/agent-memory-handlers.ts`) and web UI | `agentMemory.write`, `.create`, `.read`, `.delete`, `.list` (optional query) |
| Daily job (`memory-consolidation.handler.ts`) | prune entries untouched for 90 days, merge near-duplicates (token Jaccard ≥ 0.82), rebuild a top-10 "core memories" list |

There is no "related memories" operation.

### Exact search mechanism (`AgentMemoryRepository.searchWithOptions`)

- **Keyword arm.** An FTS5 table with the `trigram` tokenizer indexes key, content and
  tags. The query is split on whitespace only, and words shorter than 3 characters are
  dropped. Each remaining word is quoted, and the words are joined with spaces, which
  FTS5 reads as AND. Results are ordered by `bm25()`, but only that **order** is used;
  the bm25 score itself is thrown away.
- **Vector arm.** The embedding model is `onnx-community/granite-embedding-small-english-r2-ONNX`.
  It produces 384-d vectors, runs in a worker, and is downloaded on first use. Each
  memory is embedded as `key + content + tags`. A search computes cosine similarity
  against every ready vector and keeps the top 100, with no similarity floor. If the
  model is not ready, this arm quietly returns nothing.
- **Fusion.** The two arms are merged with reciprocal rank fusion: each arm contributes
  `1 / (60 + rank)`, both weighted equally. Every returned row gets `access_count + 1`.
- **Not multilingual.** The model is English-only. The trigram index does match Chinese
  substrings, but because the query is split on spaces, a whole Chinese sentence is one
  term that must appear verbatim.

The Neo-side message search (`work-chat-search.ts`) shares this design: trigram FTS
with ANDed prefix terms, the same embedder, and RRF that also counts a recency rank. It
does have a floor, `MIN_SIMILARITY = 0.3`, but with this model that floor filters
almost nothing (see below).

### Who can use it today, and why

Only Space agents get the store. Those are the long-term Space agents
(`space-runtime-service.ts` `attachLongTermAgentMcpServers`) and Space workflow task
sessions (`task-agent-manager.ts` `buildAgentMemoryMcpServers`). Both paths exist only
when `HYPERNEO_SPACE=on`. The tables can still exist with Spaces off: migration 132
creates them without checking the flag, so an older, upgraded database may have them.
The live daemon checked here does not have them.

It is an in-process SDK MCP server bound to one `spaceId`. That means:
- **Neo** never receives it.
- **Workers** never receive it either. These are the Claude Code, Codex and HyperNeo
  sessions that Neo dispatches, which run outside the Space runtime.

Nothing in the Neo core or packs references it.

### Does it work end to end today?

Not where the human works. Spaces are parked. The live daemon records migration 132 as
applied, yet a read-only check finds none of the memory tables.
Local transcripts (about 1,700) contain **0** `memory.*` tool calls, so there are no real
queries to inspect. With Spaces on, the code paths are wired: write, then embed, then
search, plus kickoff injection. I did not run a Space daemon end to end, because the
human asked to set Spaces aside. The probes below call the real repository and
embedder code directly.

## Why searches miss (probes)

Both probes use synthetic memories in an in-memory DB.

Same-language probe, FTS only. One memory reads "Run daemon tests with
./scripts/test-daemon.sh…" and is tagged `testing`.

| Query | Hits |
| --- | --- |
| `daemon tests` | 1 |
| `how do I run the daemon tests` | **0**: `how` does not appear in the memory, and every word must match |
| `testing conventions` | **0**: `conventions` is missing |
| a task title and description (what kickoff sends) | **0** |

Cross-language probe, using the shipped embedder. There are 3 English and 3 Chinese
memories, with neutral keys. The table shows the rank of the right memory out of 6.

| Query | Wanted memory | Vector rank | FTS |
| --- | --- | --- | --- |
| `怎么运行守护进程的测试？` | English: run daemon tests | **6/6** | 0 |
| `如何发布新版本` | English: releases are tags | 2/6 | 0 |
| `database lock per worktree` | Chinese: per-workspace DB, process lock | 2/6 | 0 |
| `pin exact dependency versions` | Chinese: pin exact versions | 3/6 | 0 |
| `run daemon tests` | English (same language) | 1/6 (cos 0.93) | 1 |
| `数据库进程锁` | Chinese (same language) | 1/6 (cos 0.91) | **0** (one whole-sentence term) |

Cross-language retrieval found the right memory first in 0 of 4 queries. Unrelated pairs
still scored cosine 0.70–0.82. That is why a fixed 0.3 floor does nothing, and why the
memory vector arm, which has no floor at all, returns every memory for an unrelated
query.

The root causes:
1. ANDed keywords over natural language.
2. Chinese is not split into words.
3. An English-only embedder, with no usable relevance floor.
4. Agents must invent a query, because nothing is retrieved for them.
5. Memories nobody finds never become core memories and are deleted after 90 days.

## Options for Neo

### Where it lives and who gets it

- **A. Neo-owned store, reached through operations.** Lift the repository out of the
  Space schema into a Neo-core table, scoped to the human rather than to a Space.
  Expose `memory.save/search/read/delete` as `defineOperation`s, so Neo uses them through
  `hyperneo-operations` MCP and the web UI uses `operation.invoke`.
- **B. Workers read but don't write.** The daemon puts retrieved memories into the
  worker brief (pack `workerBrief`/`workerStartBrief`), so workers of any harness get
  them without a tool. Workers report learnings to Neo, and Neo decides what to save.
  This keeps one writer and avoids a second store of stale worker notes. Giving workers
  the search operation directly is a cheap add later if briefs prove too thin.

### What search should be

Use **hybrid**, fixing each half:
- **Keyword half.** Keep trigram FTS, which already matches Chinese and English
  substrings. Join terms with `OR` and let bm25 rank them. Split Chinese runs into
  overlapping 3-character pieces, so a sentence is no longer one term.
- **Vector half.** Swap in a **multilingual** embedder, so that a Chinese query finds an
  English memory and the reverse. `intfloat/multilingual-e5-small` (384-d, the same
  dimensions as today) is a candidate; it is unmeasured here, and the cross-language
  probe above is the acceptance test. Replace the absolute floor with one relative to
  the best hit, for example keeping hits within 0.05 of the top score, tuned on the probe.
- **Fusion.** Keep RRF. Do not bump access counts on search hits.

Vector-only search loses exact identifiers like `test-daemon.sh` and PR numbers.
bm25-only search cannot cross languages. That is why both halves stay.

### How the right memories surface without Neo guessing

1. **Retrieve with the human's own words.** Neo already has a `UserPromptSubmit` hook
   (`neo-plan-hook.ts`) that injects plan context every turn. Run memory search with the
   submitted prompt as the query, and add the top 3 hits above the floor to
   `additionalContext`. The query is the message itself, so no keyword is guessed.
2. **Retrieve with the todo text for workers.** Do the same once at dispatch, with the
   todo instruction, inside the worker brief (option B).
3. **A small always-on index.** While the store is small, put `key — first line` for
   every memory into SessionStart context, capped, and let Neo read entries by key.
   This is how Claude Code's file memory works here: its index sits in every session,
   and agents never need to search it.

Smallest first step: option 1, together with OR-joined FTS. That uses one existing hook
and changes one query builder, and it fixes the "finds nothing" complaint for
same-language memories. The multilingual embedder is the larger second step.
