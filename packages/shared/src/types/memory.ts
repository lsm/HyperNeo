/**
 * Agent memory wire types.
 *
 * These mirror the on-the-wire shapes returned by the `agentMemory.*` RPC
 * handlers (`packages/daemon/src/lib/rpc-handlers/agent-memory-handlers.ts`),
 * which delegate to `AgentMemoryRepository`. The daemon repository imports
 * these types from here so there is a single source of truth for the shape
 * clients receive.
 *
 * Note: there is intentionally no `id` field — the internal DB row id (and all
 * embedding-related columns) are stripped before crossing the wire. A memory
 * is uniquely identified within a space by its `key`.
 */

export interface AgentMemoryEntry {
  key: string;
  spaceId: string;
  content: string;
  tags: string[];
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessedAt: number | null;
}

/**
 * A single ranked search hit. `rank` is a fused reciprocal-rank-fusion score
 * combining BM25 (FTS) and vector similarity — treat it as an opaque ordering
 * value, not a normalized 0-1 score.
 */
export interface AgentMemorySearchResult {
  memory: AgentMemoryEntry;
  rank: number;
}
