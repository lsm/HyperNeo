# Agent memory: what it does and why searches miss

Research note, 2026-11-27. No product code changed.

## What it is

Agent memory is a per-Space key/value store for facts, conventions and decisions. It
belongs to the Space feature, so it only exists when the daemon runs with
`HYPERNEO_SPACE=on` (the schema extension and the runtimes are both gated on it).
Neo sessions and Neo workers never get it.

| Surface | Operations |
| --- | --- |
| `agent-memory` MCP server (`packages/space/src/tools/agent-memory-tools.ts`) | `memory.write` (upsert by key), `memory.search`, `memory.read`, `memory.delete` |
| RPC (`packages/daemon/src/lib/rpc-handlers/agent-memory-handlers.ts`) | `agentMemory.write`, `.create` (insert only), `.read`, `.delete`, `.list` (optional query) |
| Web UI (`SpaceMemories`, `SpaceMemoryEditor`) | list, search, create, edit, delete |
| Daily job (`memory-consolidation.handler.ts`) | prune, merge near-duplicates, rebuild "core memories" |

There is no "related memories" operation. The closest things are the duplicate merge
(token Jaccard ≥ 0.82) and core memories.

Storage lives in `space_agent_memory`, plus an FTS5 trigram index over key, content and
tags, plus `memory_vectors` (384-d `granite-embedding-small-english-r2`, run in a worker
and downloaded on first use).

### How search works (`AgentMemoryRepository.searchWithOptions`)

1. **FTS arm.** The query is split on whitespace. Words shorter than 3 characters are
   dropped. Each remaining word is quoted, and the words are joined with spaces, which
   FTS5 treats as **AND**. So every word must appear as a substring of the key, content
   or tags.
2. **Vector arm.** The query is embedded, and every ready vector in the Space gets a
   cosine score. The top 100 come back, with **no similarity floor**. If the embedder is
   missing, still downloading, timed out or failed, this arm quietly returns nothing.
3. **Merge.** The two arms are merged with reciprocal rank fusion (k = 60). Every
   returned row gets `access_count + 1`.

### How memory reaches an agent without a search

- **Workflow task agents.** The kickoff message gets up to 10 **core memories** plus
  `search(title + "\n" + description, 5)` as "Relevant Memories"
  (`task-agent-manager.ts` `buildKickoffMessage`).
- **Long-term Space agents.** They get only the briefing in
  `prompts/src/space/agent-memory.md` ("search it before concluding…"). No memory
  content is injected, so the agent has to come up with a query.
- **Core memories.** These are the top 10 by `access_count / (1 + age_days)`, and only
  memories with `access_count > 0` qualify.

## Real usage

I checked read-only, without copying any database, and report counts only.

- The live daemon on the research machine runs without Spaces, so none of the
  agent-memory tables exist there.
- Across about 1,700 local Claude Code transcripts, there are **0 calls** to any
  `mcp__agent-memory__memory.*` tool. No real queries or results were available to
  inspect.
- The memory agents actually use here is Claude Code's file memory: an index file loaded
  into every session plus one file per fact. It has 6 fact files. They were written in 5
  transcripts and read in 1, and no transcript searched them. That memory reaches agents
  because its index is always in context, not because anything searches it.

I could not observe the reported "search mostly finds nothing" in production data here.
The probe below reproduces it from the code.

## Why searches miss

I ran a probe against the real repository code: an in-memory DB with two saved memories,
one of them "Run daemon tests with ./scripts/test-daemon.sh…" tagged `testing`.

| Query | FTS only (no embedder) |
| --- | --- |
| `test-daemon` | 1 hit |
| `daemon tests` | 1 hit |
| `how do I run the daemon tests` | **0** (`how` and `run` are not substrings of the memory) |
| `testing conventions` | **0** (`conventions` is missing) |
| a task title and description | **0** (dozens of words ANDed together) |
| with an embedder: `what is the weather today` | **2 hits**: every memory, unrelated |

1. **AND over natural language.** The tool tells agents to send a "natural language
   query". The FTS arm then requires every word, so any phrase longer than a keyword or
   two misses. The kickoff search sends the whole task title and description, so its FTS
   arm practically never matches.
2. **The vector arm is either off or indiscriminate.** When the model is not ready (first
   run, offline download, timeout), search is FTS-only and gives the misses above. When
   it is ready, it returns the top-k whatever the relevance, so "found something" doesn't
   mean "found the right thing".
3. **The agent has to guess.** Long-term agents get no memory content, only an
   instruction to search. They don't know which keys or words a past session used.
4. **Unread memories decay.** Core memories need `access_count > 0`, so a memory nobody
   has found yet can never become core. Consolidation also deletes any memory that has
   gone untouched for 90 days, so memories that are never found are eventually removed.
   Meanwhile, irrelevant vector hits raise access counts and push noise into the core set.

## Smallest options

1. **Inject a key index, not a search.** At session start, put a compact list of `key —
   first line` for the Space's memories into the briefing, capped by characters, newest
   or most-used first, and have the agent `memory.read` by key. This is the pattern that
   works for Claude Code's file memory, and it needs no query. The change goes in
   `attachLongTermAgentMcpServers` and the kickoff builder, which already lists core
   memories.
2. **Make FTS terms OR and add a floor.** Join the FTS terms with `OR` so that bm25 ranks
   partial matches, and drop vector hits below a cosine threshold. Then a natural-language
   or task-text query returns the memories that share words with it, and stops returning
   unrelated rows. This is about a one-line change in `buildFtsQuery` plus a filter in
   `searchVector`, with a repository unit test.
3. **Count only real reads.** `memory.read` already bumps `access_count`. Stop bumping it
   on every search hit, and bump it when a memory appears in a kickoff instead. Seed core memories from the
   most recent writes when no memory has been accessed yet. Then new memories reach the
   core list and get read before the 90-day prune removes them.

Option 1 alone removes the guessing. Option 2 makes the existing kickoff "Relevant
Memories" block actually fill.
