# Fast Local Memory for Agents — Research Report

**Date:** 2026-03-24
**Status:** v4 — All P0/P1/P2/P3 review issues resolved; refreshed with 2024–2026 internet research

---

## 1. Context

HyperNeo already handles *short-term* memory via the LLM context window (messages in the session). This report focuses on **long-term persistent memory**: facts, preferences, and decisions that should survive across sessions and be retrievable without reloading every past conversation.

### What agents actually need to remember

| Category | Examples | Access frequency |
|----------|----------|-----------------|
| **Project conventions** | Coding style, preferred patterns, banned APIs | Per-task |
| **Past decisions** | Why a particular design was chosen, rejected alternatives | Infrequent |
| **User preferences** | Response verbosity, preferred commit message style | Per-session |
| **Codebase facts** | Key module locations, tricky areas, known footguns | Per-query |
| **Cross-session context** | Previous related tasks, PR outcomes, failed experiments | On task start |

### Operations needed

- `store(content, tags[], scope)` — persist a memory entry
- `search(query, scope)` → `MemoryEntry[]` — retrieve relevant entries by relevance
- `update(id, content)` — update an existing entry
- `delete(id)` — remove an entry
- `list(scope)` — enumerate entries for a project/user

### Latency budget

Target: **< 50 ms** for retrieval (acceptable inside agent pre-processing).
Embedding generation on CPU: typically **10–50 ms** per sentence.
SQLite FTS5 full-scan of 100k rows: **< 5 ms**.

### Resolved: Memory Scope Anchor

> **Previous version left this as an open question. Resolved here.**

The codebase already has a `rooms` table with `id` as the first-class identifier. Sessions, goals, tasks, and session groups are all scoped to `room_id` — not to `workspace_path`. Using `workspace_path` as a scope key would create a denormalized coupling: if the workspace is renamed or moved, all memory entries would be orphaned.

**Decision:** Memory scopes are:
- `'global'` — cross-room user preferences (e.g. response style, commit message format); `scope_key = NULL`
- `'room'` — memory scoped to a room, keyed by `room_id`

The `scope_key` column stores `room_id` for room-scoped entries. This aligns with how `tasks`, `goals`, and `session_groups` are scoped today, and makes JOIN queries to the `rooms` table natural.

---

## 2. Landscape Overview (2024–2026)

The memory space has matured significantly. Key frameworks:

| Framework | Approach | Local? | Open source? | Key differentiator |
|-----------|----------|--------|-------------|-------------------|
| **Mem0** | Vector + graph hybrid | Yes (OSS tier) | Yes | Production-proven; 91% latency reduction vs full-context; $24M raised; AWS default memory provider |
| **Zep / Graphiti** | Temporal knowledge graph | Yes (Community) | Yes (Graphiti) | Temporal reasoning; tracks how facts change over time |
| **Letta (MemGPT)** | LLM-as-OS (in-context + archival) | Yes | Yes | Self-editing agent memory; sleep-time async management |
| **sqlite-memory** | Markdown + FTS5 + vector (SQLite) | Yes | Yes | Zero-infra; offline-first; hybrid retrieval |
| **sqlite-rag** | FTS5 + sqlite-vector + RRF | Yes | Yes | Pure SQLite hybrid search reference impl; direct blueprint for Phase 2 |

---

## 3. Candidate Approaches

### Approach A — SQLite FTS5 (Full-Text Search)

SQLite ships with the `fts5` extension which enables BM25-ranked keyword search over text columns.

**How it works:**
```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, tags,
  content='memory_entries',
  content_rowid='rowid',
  tokenize='trigram'    -- see tokenizer note below
);

-- BM25-ranked search. JOIN resolves FTS5's integer rowid back to the UUID id column.
SELECT me.id, me.content, me.tags, mf.rank
FROM memory_fts mf
JOIN memory_entries me ON me.rowid = mf.rowid
WHERE memory_fts MATCH 'tabs indentation'
  AND me.scope = 'room' AND me.scope_key = ?
ORDER BY mf.rank
LIMIT 10;
```

> **Important:** `memory_fts` search returns integer rowids (its internal FTS index key). The `JOIN memory_entries me ON me.rowid = mf.rowid` step is required to resolve those integers back to UUID `id` values. Omitting the JOIN means callers receive only integer rowids that cannot be passed to other API methods.

**Benchmark (2025, 100k entries):** < 5 ms end-to-end on an M1 MacBook Pro.

**Tokenizer choice — Porter vs. Trigram:**

The previous version used `porter ascii`. This is a poor choice for a developer memory store. Porter stemming handles English morphology ("running" → "run") but is entirely unsuited to code identifiers, which make up the majority of what HyperNeo agents would store — e.g., `ReactiveDatabase`, `useSessionActions`, `memory_fts`. The porter stemmer would not help match `ReactiveDatabase` when searching for `reactive database`.

**`trigram`** (available in SQLite ≥ 3.34, shipping with Bun 1.2+) breaks text into 3-character sliding windows and supports substring matching. This handles:
- Camel-case identifiers: searching `"sessioncache"` finds `SessionCache`
- Partial method names: searching `"loadext"` finds `loadExtension`
- Mixed-case symbol lookup

Trade-off: trigram indexes are larger (~3–5× vs. porter for typical English text) but this is acceptable for memory stores (not document archives). For the sqlite-better-trigram variant (`streetwriters/sqlite-better-trigram`), benchmarks show 1.6× faster than the built-in trigram while also handling tokens shorter than 3 chars.

**Recommended tokenizer:** `trigram` (built-in, zero deps), or `unicode61` as a simpler fallback for projects that want word-boundary tokenization without the index size cost.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | < 5 ms for 100k entries |
| Simplicity | ★★★★★ | Zero new infra; Bun SQLite already used |
| Privacy | ★★★★★ | All data stays on-disk, same DB file |
| Scalability | ★★★★☆ | Good to ~1M entries; degrades gracefully |
| Semantic search | ★★☆☆☆ | Keyword/trigram only — misses pure semantic paraphrase |
| HyperNeo fit | ★★★★★ | One migration; uses existing ReactiveDatabase |

**Verdict:** Best baseline. Covers ~70% of use cases with zero infra cost. Used as the **Phase 1** foundation.

---

### Approach B — sqlite-vector (Quantized In-Process Vector Search)

**sqlite-vector** (by sqliteai.com, `sqliteai/sqlite-vector`, distinct from `sqlite-vec` by asg017) is a cross-platform SQLite extension with quantization support, running entirely in-process with no HNSW pre-indexing required.

**2025 benchmark (100k vectors, 384-dim FLOAT32, Apple M1 Pro):**

| Mode | Latency |
|------|---------|
| Full-scan (exact) | 56.65 ms |
| 8-bit quantized scan | 17.44 ms |
| Quantized + preloaded in memory | **3.97 ms** |

With quantization + preload, it runs **17× faster than sqlite-vec** with minimal recall degradation (quantization is an approximation by definition — it trades a small amount of recall for a large speed gain). Uses only ~30 MB RAM by default.

**sqlite-vector (sqliteai) SQL API** — uses ordinary BLOB columns, not virtual tables:

```sql
-- Ordinary table with a BLOB column for the float vector
CREATE TABLE memory_vectors (
  rowid    INTEGER PRIMARY KEY,
  embedding BLOB    -- stores FLOAT32 vector bytes
);

-- One-time setup: register the column for vector search
SELECT vector_init('memory_vectors', 'embedding', 'type=FLOAT32,dimension=384');

-- Insert: convert JSON float array to FLOAT32 blob via vector_as_f32()
INSERT INTO memory_vectors(rowid, embedding)
VALUES (42, vector_as_f32('[0.12, -0.07, ...]'));

-- ANN search: JOIN against vector_quantize_scan() table-valued function.
-- The ? placeholder receives the query embedding as a BLOB.
SELECT mv.rowid, v.distance
FROM memory_vectors AS mv
JOIN vector_quantize_scan('memory_vectors', 'embedding', ?, 10) AS v
  ON mv.rowid = v.rowid
ORDER BY v.distance;
```

> **Note:** Do not confuse this API with **sqlite-vec** (`asg017/sqlite-vec`), which uses `CREATE VIRTUAL TABLE ... USING vec0(...)`. sqlite-vector uses ordinary tables + `vector_init()` + `vector_quantize_scan()`. The two libraries have entirely different SQL interfaces.

**Note on sqlite-vec vs. vec1 vs. sqlite-vector:** `asg017/sqlite-vec` and the SQLite.org `vec1` extension are **separate projects** — vec1 was not derived from or merged from sqlite-vec. Both provide vector search for SQLite via similar virtual-table interfaces, but are independently developed codebases. Neither is production-stable: sqlite-vec is at v0.1.x alpha (upstream explicitly warns "expect breaking changes"), and vec1 is pre-release ("testing is very insufficient"). sqlite-vector (sqliteai) uses a different, BLOB-column-based API and is the only option here with a quantization-optimised query path; treat it as the most performance-relevant candidate for Phase 2, but validate its stability before committing.

#### Bun + Native SQLite Extension Constraint ⚠️

> **Research item required before Phase 2 is scoped.**

Bun bundles its own SQLite. On macOS, Bun's default build uses Apple's system SQLite, which **does not support extension loading**. The workaround is:

```typescript
import { Database } from 'bun:sqlite';

// Must be called before any Database() instance is created
Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');

const db = new Database('memory.db');
db.loadExtension('./sqlite-vector.dylib');
```

On Linux (including CI), Bun's bundled SQLite supports extension loading natively.

**Open questions before Phase 2:**
1. Does the pre-built sqlite-vector/sqlite-vec binary need to be compiled against the same SQLite version Bun uses? (Known friction point — test this before committing to Phase 2.)
2. For distribution: ship the `.dylib`/`.so` as a package asset, or compile at install time?
3. Alternative: use `fastembed-js` for embeddings but store vectors in a plain `BLOB` column and do brute-force cosine in TypeScript (avoids native extension entirely, adequate for < 50k entries).

sqlite-vec does list Bun as a supported runtime (`npm install sqlite-vec`), which suggests the team has tested this path, but the macOS `setCustomSQLite` workaround is still needed.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | 4 ms with quantized preload |
| Simplicity | ★★★★☆ | One native `.so`/`.dylib` + macOS workaround |
| Privacy | ★★★★★ | Fully local |
| Scalability | ★★★★☆ | Handles millions of vectors |
| Semantic search | ★★★★★ | True semantic similarity |
| HyperNeo fit | ★★★★☆ | Bun compatibility tested; macOS needs `setCustomSQLite` |

**Verdict:** Excellent for Phase 2. The quantization support eliminates the embedding latency bottleneck.

---

### Approach C — sqlite-rag (Pre-Built Hybrid FTS5 + Vector)

**sqlite-rag** (`sqliteai/sqlite-rag`) is an open-source reference implementation combining FTS5 and sqlite-vector via **Reciprocal Rank Fusion (RRF)**. It already solves the hybrid-merge problem. For HyperNeo (Bun/TypeScript), it serves as an architectural blueprint rather than a direct dependency.

```
Query
  ├─ FTS5 trigram search → top-N keyword hits (BM25 ranked)
  ├─ sqlite-vector ANN  → top-N semantic hits
  └─ RRF merge          → final top-K results

RRF score: score(d) = Σ 1 / (k + rank_i(d))   [k=60 is standard]
```

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | < 10 ms with preloaded quantized vectors |
| Simplicity | ★★★☆☆ | Reference code available; TypeScript port needed |
| Privacy | ★★★★★ | Fully local |
| Semantic search | ★★★★★ | Best of both worlds |
| HyperNeo fit | ★★★★☆ | Direct architectural model |

**Verdict:** This is the target architecture for Phase 2. Port the RRF merge logic from sqlite-rag.

---

### Approach D — Mem0 (Memory Layer Library)

**Mem0** is an open-source production memory layer. Published paper shows 26% accuracy improvement over OpenAI full-context, 91% latency reduction, 90%+ token savings. Raised $24M, used by AWS, CrewAI, Flowise.

**Key limitation for HyperNeo:** Mem0's `add()` call runs LLM extraction to distill facts before storage — 200–2000 ms. Not suitable as the primary retrieval path. Best used as an optional background enrichment layer that writes into the FTS5/vector store.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed (write) | ★★☆☆☆ | LLM extraction per write: 200–2000 ms |
| Speed (read) | ★★★★☆ | ~20 ms semantic retrieval |
| Semantic search | ★★★★★ | LLM-quality fact extraction |
| HyperNeo fit | ★★★☆☆ | Useful as async background enrichment only |

**Verdict:** Background enrichment layer for Phase 3. Not a Phase 1 or 2 dependency.

---

### Approach E — Zep / Graphiti (Temporal Knowledge Graph)

**Zep** builds a temporal knowledge graph (via OSS **Graphiti** library). Every memory is time-anchored. 18.5% accuracy improvement, 90% latency reduction vs full-context. Community edition supports local deployment.

**Key limitation:** LLM extraction for entity/relationship parsing on every write. High cold-start cost. Best for agents with months of history.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed (write) | ★★☆☆☆ | LLM extraction + graph update |
| Speed (read) | ★★★★☆ | Graph traversal < 20 ms |
| Simplicity | ★★☆☆☆ | Needs graph engine; LLM extraction |
| HyperNeo fit | ★★☆☆☆ | Over-engineered for current scale |

**Verdict:** Revisit when HyperNeo agents accumulate 6+ months of project history.

---

### Approach F — Letta / MemGPT (LLM-as-OS)

**Letta** treats the LLM as an OS: editable in-context memory blocks + archival external store. Self-editing via tool calls. "Sleep-time agents" run async memory consolidation in the background — a pattern worth adopting regardless of framework.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★☆☆ | Self-editing adds 1–3 tool calls per turn |
| Simplicity | ★★★☆☆ | Framework has TypeScript bindings |
| HyperNeo fit | ★★★☆☆ | Sleep-time pattern is worth borrowing |

**Verdict:** Borrow the "sleep-time agent" pattern for Phase 3. Full framework integration not needed.

---

### Approach G — External Vector Database (Qdrant / Chroma)

**Qdrant (2025):** 24× compression via asymmetric quantization. Requires a running service.

**Chroma (2025):** Rust-core rewrite delivers 4× faster writes/queries. Can now run **embedded** (no separate process). Growing embedded usage for local AI apps.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★☆ | Chroma embedded: ~5 ms; Qdrant: ~2 ms |
| Simplicity | ★★★☆☆ | Chroma embedded is viable; Qdrant needs process |
| HyperNeo fit | ★★☆☆☆ | Chroma embedded now viable fallback; Qdrant breaks zero-infra |

**Verdict:** Chroma embedded is now viable as a fallback if sqlite-vector Bun extension bundling proves too painful. Qdrant remains over-engineered.

---

### Approach H — FastEmbed-js (Embedding Generation)

**fastembed-js** (`Anush008/fastembed-js`) is a Node.js ONNX Runtime embedding library. Sub-10 ms CPU inference. Default model `BGESmallEN` (~25 MB ONNX). No subprocess — pure ONNX Runtime Node.js bindings (compatible with Bun's Node.js compat layer).

According to 2025 surveys, 92% of practitioners achieve sub-10 ms inference with FastEmbed on modern CPUs. 65% of new semantic search projects use ONNX embeddings.

**Alternatives:**
- `onnxruntime-node` directly with `all-MiniLM-L6-v2` (384-dim, ~25 MB)
- BGE-M3 for multilingual support (~560 MB, heavier)
- Ollama-hosted model (requires Ollama daemon running separately)

**Verdict:** fastembed-js is the correct embedding solution for Phase 2. Zero external service, Bun-compatible, sub-10 ms per sentence.

---

## 4. Recommendation

### Phased: SQLite-Native Hybrid

**Phase 1 — FTS5 trigram baseline (complexity: 2/5, ~1 week)**

Zero new dependencies. Delivers working memory immediately:
1. `memory_entries` table (integer surrogate rowid + UUID `id`, `room`/`global` scope keyed by `room_id`) — see fixed schema below
2. `memory_fts` virtual table with `trigram` tokenizer
3. `MemoryRepository` with `store / search / update / delete / list`
4. `MemoryManager` exposed through `DaemonApp`
5. RPC handlers registered in `packages/daemon/src/lib/rpc-handlers/`
6. Agent MCP tools via `createSdkMcpServer` — see correct format below

**Phase 2 — Add sqlite-vector + fastembed-js (complexity: 3/5, ~2 weeks)**

Adds semantic search to the Phase 1 baseline:
1. Research Bun + sqlite-vector compatibility (macOS `setCustomSQLite` + binary distribution)
2. Add `memory_vectors` shadow table via sqlite-vector
3. Add fastembed-js for in-process ONNX embedding (`BGESmallEN`, ~25 MB)
4. Generate embeddings via the existing `job_queue` (fire-and-forget from `store()`)
5. Implement RRF merge in `MemoryManager.search()` with explicit fallback for un-embedded entries
6. Enable quantized preload mode for < 5 ms retrieval

**Phase 3 — Background consolidation (complexity: 3/5, future)**

Inspired by Letta's "sleep-time agents" and Mem0's extraction pattern:
- Background job deduplicates related entries, promotes frequently-accessed memories to a "core memory" block injected at session start, prunes stale entries per TTL
- Optionally: Mem0 as an enrichment layer that extracts structured facts and writes back to the FTS5/vector store

---

## 5. Implementation Sketch (Phase 1 — Fixed)

### 5.1 Schema

> **Fix for P0 review issue:** The previous version used `TEXT PRIMARY KEY` (UUID) for `memory_entries` but the FTS5 content table binding (`content_rowid='rowid'`) requires **integer rowids**. When FTS5 returns `rowid` values from a search, those are integer rowids — there is no automatic mapping back to UUID strings.
>
> **Fix:** Use an explicit `INTEGER PRIMARY KEY` as the surrogate rowid (which SQLite aliases to the table's implicit rowid). The UUID `id` is stored in a separate column with a `UNIQUE` constraint. The `MemoryRepository.search()` JOIN uses `me.rowid = mf.rowid` to resolve back to `me.id`.

```sql
-- Core entries table
-- NOTE: id is UUID for external references; rowid is the FTS5 binding anchor.
CREATE TABLE memory_entries (
  rowid      INTEGER PRIMARY KEY,         -- surrogate integer rowid (FTS5 binding anchor)
  id         TEXT NOT NULL UNIQUE,        -- UUID v4 (external reference key)
  scope      TEXT NOT NULL,               -- 'global' | 'room'
  scope_key  TEXT,                        -- room_id for 'room' scope; NULL for 'global'
  content    TEXT NOT NULL,               -- The memory text
  tags       TEXT NOT NULL DEFAULT '',    -- Space-separated tags
  source     TEXT,                        -- 'agent' | 'user' | 'system'
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 virtual table — content table mode (no duplication of text data).
-- content_rowid links back to memory_entries.rowid (integer).
-- tokenize='trigram' preferred over 'porter ascii' for code identifier search.
-- Fallback: tokenize='unicode61' for word-boundary tokenization without trigram index overhead.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  content='memory_entries',
  content_rowid='rowid',
  tokenize='trigram'
);

-- Sync triggers (content table mode requires manual FTS maintenance)
CREATE TRIGGER memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

-- Indexes
CREATE INDEX memory_entries_scope    ON memory_entries(scope, scope_key);
CREATE INDEX memory_entries_updated  ON memory_entries(updated_at DESC);
CREATE INDEX memory_entries_access   ON memory_entries(last_accessed_at DESC);

-- Foreign key to rooms table for room-scoped entries (enforced at app layer; no FK constraint
-- because scope_key is NULL for global entries).
```

**FTS5 index rebuild after migrations:**

The FTS5 content table mode keeps the index in sync via triggers at runtime, but if a migration drops and recreates `memory_entries` (a common pattern in this codebase), the FTS5 shadow tables become stale. After any bulk data migration that touches `memory_entries`, run:

```sql
INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
```

This triggers a full re-index from the content table and is safe to run at any time.

---

### 5.2 Repository interface

```typescript
// packages/daemon/src/storage/repositories/memory-repository.ts

export type MemoryScope =
  | { type: 'global' }
  | { type: 'room'; roomId: string };

export interface MemoryEntry {
  id: string;             // UUID (external reference key)
  scope: MemoryScope;
  content: string;
  tags: string[];
  source?: 'agent' | 'user' | 'system';
  accessCount: number;
  lastAccessedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  rank: number;           // BM25 rank from FTS5 (Phase 1); RRF score (Phase 2)
}

export class MemoryRepository {
  store(payload: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): MemoryEntry;

  // Phase 1: FTS5 BM25 search. JOIN resolves integer rowid → UUID id.
  // Correct query pattern:
  //   SELECT me.id, me.*, mf.rank
  //   FROM memory_fts mf
  //   JOIN memory_entries me ON me.rowid = mf.rowid
  //   WHERE memory_fts MATCH ?
  //   [AND me.scope = ? AND me.scope_key = ?]
  //   ORDER BY mf.rank
  //   LIMIT ?
  search(query: string, scope?: MemoryScope, limit?: number): MemorySearchResult[];

  get(id: string): MemoryEntry | undefined;
  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'tags'>>): MemoryEntry;
  delete(id: string): void;
  list(scope?: MemoryScope, limit?: number): MemoryEntry[];
  recordAccess(id: string): void;   // bump access_count + last_accessed_at
}
```

---

### 5.3 RPC handlers

```typescript
// packages/daemon/src/lib/rpc-handlers/memory-handlers.ts
// Registered in packages/daemon/src/app.ts alongside other RPC handlers

hub.handle('memory.store',  handler_store);   // { scope, roomId?, content, tags?, source? } → MemoryEntry
hub.handle('memory.search', handler_search);  // { query, scope?, roomId?, limit? } → MemorySearchResult[]
hub.handle('memory.list',   handler_list);    // { scope?, roomId? } → MemoryEntry[]
hub.handle('memory.get',    handler_get);     // { id } → MemoryEntry
hub.handle('memory.update', handler_update);  // { id, content?, tags? } → MemoryEntry
hub.handle('memory.delete', handler_delete);  // { id } → void
```

---

### 5.4 Agent tool integration (correct format)

> **Fix for P1 review issue:** The previous version showed an XML tool definition format that does not match the Claude Agent SDK. In HyperNeo, tools are registered using `tool()` + `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`, exactly as in `room-agent-tools.ts` and `task-agent-tools.ts`.

```typescript
// packages/daemon/src/lib/memory/memory-agent-tools.ts

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { MemoryManager } from './memory-manager';

export function createMemoryTools(memoryManager: MemoryManager, roomId: string) {
  const tools = [
    tool(
      'store_memory',
      'Save a fact, convention, or decision to persistent memory for future sessions. ' +
        'Use for coding conventions, user preferences, past decisions, and project facts.',
      {
        content: z.string().describe('The memory text (1–3 sentences).'),
        tags: z.array(z.string()).optional().describe('Keyword tags to improve retrieval.'),
        scope: z
          .enum(['global', 'room'])
          .default('room')
          .describe("'global' for user preferences; 'room' for this project."),
      },
      async ({ content, tags, scope }) => {
        const entry = memoryManager.store({
          content,
          tags: tags ?? [],
          scope: scope === 'room' ? { type: 'room', roomId } : { type: 'global' },
          source: 'agent',
        });
        return { content: [{ type: 'text' as const, text: JSON.stringify(entry) }] };
      },
    ),

    tool(
      'search_memory',
      'Retrieve relevant memories from previous sessions. Call before starting a task to recover relevant context.',
      {
        query: z.string().describe('Natural language or code identifier query.'),
        limit: z.number().int().min(1).max(20).default(5),
        scope: z
          .enum(['global', 'room', 'all'])
          .default('room')
          .describe("'room' searches this project only; 'global' user-wide; 'all' both."),
      },
      async ({ query, limit, scope }) => {
        const results = memoryManager.search(
          query,
          scope === 'all' ? undefined : scope === 'room' ? { type: 'room', roomId } : { type: 'global' },
          limit,
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(results) }] };
      },
    ),
  ];

  return createSdkMcpServer({ name: 'memory', tools });
}
```

The server is then passed to the agent session's MCP configuration, analogous to how `createRoomAgentTools()` and `createLeaderContextServer()` work in `room-agent-tools.ts`.

---

### 5.5 Phase 2: Consistency handling for async embeddings

> **Fix for P2 review issue:** When embeddings are generated asynchronously (via `job_queue`), entries stored since the last embedding job run will appear in FTS5 results but **not** in vector search results. This is a silent correctness gap if not handled explicitly.

**Strategy:**

Add an `embedding_status` column to `memory_entries`:

```sql
ALTER TABLE memory_entries ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending';
-- values: 'pending' | 'ready' | 'failed'
```

`MemoryManager.search()` in Phase 2 applies hybrid RRF only for entries where `embedding_status = 'ready'`. For `pending` entries, it falls back to FTS5 rank only:

```typescript
// Pseudocode for Phase 2 MemoryManager.search()
async function search(query: string, scope: MemoryScope | undefined, limit: number) {
  // 1. Generate the query embedding first (fastembed-js, ~10 ms on CPU)
  const queryEmbedding = await embeddingModel.embed(query);  // Float32Array, length 384

  // 2. Run both retrieval paths concurrently
  const [ftsResults, vecResults] = await Promise.all([
    repo.searchFts(query, scope, limit * 2),                    // always runs; covers pending entries
    repo.searchVector(queryEmbedding, scope, limit * 2),        // only 'ready' entries
  ]);

  // 3. Merge with Reciprocal Rank Fusion (k=60)
  // Entries not yet embedded appear only in ftsResults — no silent omission.
  return reciprocalRankFusion(ftsResults, vecResults, limit);
}
```

**Observable behavior:**

- Immediately after `store()`: entry appears in keyword (FTS5) search results. Semantic search result quality is unaffected (it only queries `embedding_status = 'ready'` entries).
- After the embedding job runs (typically seconds to minutes later): entry also appears in semantic search.
- No silent omission. FTS5 acts as the floor; vector search adds precision on top.

**Exposure to the user:**

The `MemoryEntry` returned from `store()` and `list()` can include `embeddingStatus: 'pending' | 'ready' | 'failed'` so the UI or agent can optionally surface this state.

---

## 6. Complexity & Effort Estimates

| Approach | Complexity (1–5) | Effort | Notes |
|----------|-----------------|--------|-------|
| FTS5 trigram baseline | **2** | ~1 week | One migration, ~300 LOC; fixed rowid/UUID pattern |
| + sqlite-vector (Phase 2) | **3** | +1–2 weeks | Native ext; Bun macOS workaround; fastembed-js |
| + Background consolidation (Phase 3) | **3** | +1 week | New job type; reuses job_queue |
| Mem0 enrichment layer | **3** | ~1 week | npm pkg; async; writes back to FTS5 store |
| Zep / Graphiti | **4** | 2–3 weeks | Graph infra; LLM extraction |
| Letta/MemGPT full | **4** | 2–3 weeks | Framework integration |
| Chroma embedded (fallback) | **3** | ~1 week | If sqlite-vector Bun compat is too painful |
| External Qdrant | **4** | 1–2 weeks | Separate process; breaks zero-infra goal |

---

## 7. Performance Summary

| Approach | Write latency | Read latency | Semantic? | Zero infra? |
|----------|--------------|-------------|-----------|------------|
| SQLite FTS5 trigram | < 1 ms | < 5 ms | No | Yes |
| sqlite-vector (quantized+preload) | 5–10 ms (async job) | **< 4 ms** | Yes | Yes (native ext) |
| Hybrid FTS5 + sqlite-vector | 5–10 ms (async job) | < 10 ms | Yes | Yes (native ext) |
| Mem0 OSS | 200–2000 ms (LLM) | ~20 ms | Yes | Needs LLM |
| Zep / Graphiti | 200–2000 ms (LLM) | < 20 ms | Yes | Needs graph |
| Chroma embedded | ~5 ms | ~5 ms | Yes | Yes (2025 rewrite) |
| Qdrant local | ~2 ms | ~2 ms | Yes | No (separate process) |

---

## 8. Open Questions for User Input

1. **Embedding model distribution:** Bundle `BGESmallEN` (~25 MB ONNX via `fastembed-js`) or require a user-installed Ollama instance? Bundling simplifies setup but adds to binary size.

2. **Memory injection strategy:** Auto-inject top-N memories into the system prompt at session start, or explicit tool calls only? Auto-injection is simpler but consumes context tokens on every session. Explicit search is more efficient but requires agents to remember to call `search_memory`.

3. **Embedding status exposure:** Should `embeddingStatus: 'pending' | 'ready'` be surfaced in the UI (e.g., a spinner on a recently stored memory), or is this purely internal state?

4. **Memory expiry/pruning:** Should entries expire after a configurable TTL (e.g., 90 days without access)? Phase 3 background consolidation can handle deduplication, but hard TTL policy needs a decision.

5. **Encryption at rest:** Should memory entries be encrypted at the column level? Most relevant if HyperNeo is deployed in shared/cloud environments. Adds ~1 ms per operation.

6. **Multi-agent sharing:** In Leader + Worker spaces, should all agents share one memory store per room, or should each agent type have an isolated memory namespace? Shared enables cross-agent learning; isolation prevents contamination.

7. **Bun/sqlite-vector pre-research:** Before Phase 2 is scoped, someone should verify: (a) sqlite-vector or sqlite-vec loads cleanly via `db.loadExtension()` on both macOS (with `setCustomSQLite`) and Linux; (b) the pre-built binary is compatible with Bun's bundled SQLite version; (c) CI build matrix includes extension loading test.

8. **Trigram index size:** Trigram indexes are 3–5× larger than porter for long prose content. For typical memory entries (1–3 sentences, often code-heavy), this is acceptable, but worth measuring once ~10k entries exist.

---

## 9. Recommendation Summary

| Phase | What | Why |
|-------|------|-----|
| **Phase 1** (now) | SQLite FTS5 trigram + RPC + MCP tools | Zero deps; ships fast; covers most use cases; fixed rowid/UUID schema |
| **Phase 2** (+2 weeks) | sqlite-vector (quantized) + fastembed-js + RRF merge | True semantic search; < 5 ms with preload; explicit async-embedding fallback |
| **Phase 3** (future) | Background consolidation + optional Mem0 enrichment layer | Quality improvement without blocking agents |

Skip: Zep, Letta framework, Qdrant (too heavy for current scale).
Revisit: Chroma embedded (viable fallback if sqlite-vector Bun compat is painful), Zep (when project lifespans exceed 6+ months).

---

## 10. References

- [sqlite-vector (sqliteai)](https://github.com/sqliteai/sqlite-vector) — Quantized in-process vector search; 17× faster than sqlite-vec with preload
- [sqlite-vec (asg017)](https://github.com/asg017/sqlite-vec) — SQLite vector extension, v0.1.x alpha (breaking changes expected); separate codebase from vec1
- [vec1 — SQLite.org vector extension](https://sqlite.org/vec1) — Independent SQLite.org project (not derived from sqlite-vec); pre-release, testing described as insufficient
- [sqlite-rag (sqliteai)](https://github.com/sqliteai/sqlite-rag) — Hybrid FTS5 + vector search reference implementation
- [sqlite-memory (sqliteai)](https://github.com/sqliteai/sqlite-memory) — Markdown-based agent memory with offline-first sync
- [Hybrid FTS5 + vector search — Alex Garcia's blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [State of Vector Search in SQLite — Marco Bambini](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [SQLite FTS5 trigram tokenizer — official docs](https://www.sqlite.org/fts5.html)
- [sqlite-better-trigram — 1.6× faster trigram tokenizer](https://github.com/streetwriters/sqlite-better-trigram)
- [SQLite FTS5 tokenizers: unicode61 and ascii (2025)](https://audrey.feldroy.com/articles/2025-01-13-SQLite-FTS5-Tokenizers-unicode61-and-ascii)
- [fastembed-js — Node.js ONNX embedding](https://github.com/Anush008/fastembed-js)
- [FastEmbed ONNX performance (2025)](https://johal.in/fastembed-onnx-lightweight-embedding-inference-2025/)
- [Bun SQLite loadExtension docs](https://bun.com/reference/bun/sqlite/Database/loadExtension)
- [Bun SQLite + macOS extension constraint](https://bun.com/docs/runtime/sqlite)
- [Bun SQLite version discussion](https://github.com/oven-sh/bun/discussions/8177)
- [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Mem0 graph memory — Jan 2026](https://mem0.ai/blog/graph-memory-solutions-ai-agents)
- [Zep temporal knowledge graph (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [Graphiti — open-source temporal graph engine](https://github.com/getzep/graphiti)
- [Letta / MemGPT architecture](https://docs.letta.com/concepts/memgpt/)
- [Claude Agent SDK — custom tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude Agent SDK — MCP integration](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [AI Agent Memory Systems 2026 comparison](https://yogeshyadav.medium.com/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Best vector databases 2026](https://www.firecrawl.dev/blog/best-vector-databases)
- [Hybrid search: BM25 + vectors without lag](https://medium.com/@connect.hashblock/7-hybrid-search-recipes-bm25-vectors-without-lag-467189542bf0)
- [Reciprocal Rank Fusion paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [A-MEM: Agentic Memory for LLM Agents (arXiv 2502.12110)](https://arxiv.org/pdf/2502.12110)
- [ICLR 2026 Workshop: MemAgents](https://openreview.net/pdf?id=U51WxL382H)
